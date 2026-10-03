import { DivarScrapeWorkflow } from './workflow.js';
import { getSettings, json, logError } from './utils.js';

export { DivarScrapeWorkflow };

const LABELS = new Set(['real', 'suspicious', 'fake', 'unknown']);
const SERVICES = new Set(['scraper', 'workers-ai', 'jev', 'system', 'willhaben']);

function html(body, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

async function startWorkflow(env, params = {}) {
  if (!env.DIVAR_WORKFLOW) throw new Error('Workflow binding is not configured');
  const id = `divar-${Date.now()}-${crypto.randomUUID()}`;
  return env.DIVAR_WORKFLOW.create({ id, params });
}

async function apiRoute(request, env, url) {
  const path = url.pathname;
  if (path === '/api/stats' && request.method === 'GET') {
    const stats = await env.DB.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN fake_label = 'fake' THEN 1 ELSE 0 END) AS fake,
        SUM(CASE WHEN fake_label = 'suspicious' THEN 1 ELSE 0 END) AS suspicious,
        SUM(CASE WHEN fake_label = 'real' THEN 1 ELSE 0 END) AS verified,
        SUM(CASE WHEN extraction_done = 0 THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN extraction_done = -1 THEN 1 ELSE 0 END) AS failed
      FROM listings
    `).first();
    return json(stats || {});
  }

  if (path === '/api/districts' && request.method === 'GET') {
    const result = await env.DB.prepare(`
      SELECT d.id, d.name_fa, d.name_en, COALESCE(l.count, 0) AS count,
        l.avg_price, COALESCE(l.fake_percent, 0) AS fake_percent, s.last_scrape
      FROM districts d
      LEFT JOIN (
        SELECT district_id, COUNT(*) AS count,
          AVG(CASE WHEN price_toman > 0 THEN price_toman END) AS avg_price,
          100.0 * SUM(CASE WHEN fake_label = 'fake' THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0) AS fake_percent
        FROM listings GROUP BY district_id
      ) l ON l.district_id = d.id
      LEFT JOIN (
        SELECT n.district_id, MAX(s.last_scraped_at) AS last_scrape
        FROM neighborhoods n LEFT JOIN scrape_state s ON s.neighborhood_id = n.id
        GROUP BY n.district_id
      ) s ON s.district_id = d.id
      ORDER BY d.id
    `).all();
    return json(result.results || []);
  }

  if (path === '/api/listings' && request.method === 'GET') {
    const page = Math.max(1, Math.min(100000, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1));
    const pageSize = 20;
    const clauses = [];
    const values = [];
    const district = Number.parseInt(url.searchParams.get('district') || '', 10);
    const label = url.searchParams.get('fake_label');
    if (Number.isInteger(district) && district > 0 && district <= 22) { clauses.push('l.district_id = ?'); values.push(district); }
    if (label === 'pending') clauses.push('l.extraction_done = 0');
    else if (LABELS.has(label)) { clauses.push('l.fake_label = ?'); values.push(label); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const count = await env.DB.prepare(`SELECT COUNT(*) AS total FROM listings l ${where}`).bind(...values).first();
    const result = await env.DB.prepare(`
      SELECT l.id, l.divar_token, l.url, l.title, l.price_toman, l.rent_toman, l.deposit_toman,
        l.size_m2, l.rooms, l.image_url, l.fake_label, l.fake_score, l.fake_reason,
        l.extraction_done, l.district_id, d.name_fa AS district_name, n.name_fa AS neighborhood_name,
        l.scraped_at
      FROM listings l LEFT JOIN districts d ON d.id = l.district_id
      LEFT JOIN neighborhoods n ON n.id = l.neighborhood_id
      ${where} ORDER BY l.scraped_at DESC LIMIT ? OFFSET ?
    `).bind(...values, pageSize, (page - 1) * pageSize).all();
    return json({ listings: result.results || [], page, page_size: pageSize, total: Number(count?.total || 0), pages: Math.ceil(Number(count?.total || 0) / pageSize) });
  }

  if (path === '/api/logs' && request.method === 'GET') {
    const clauses = [];
    const values = [];
    const service = url.searchParams.get('service');
    const status = url.searchParams.get('status');
    if (SERVICES.has(service)) { clauses.push('service = ?'); values.push(service); }
    if (status === 'error') clauses.push('(status IS NULL OR status = 0 OR status >= 400 OR error IS NOT NULL)');
    if (status === 'success') clauses.push('(status > 0 AND status < 400 AND error IS NULL)');
    const limit = Math.max(1, Math.min(200, Number.parseInt(url.searchParams.get('limit') || '100', 10) || 100));
    const result = await env.DB.prepare(`SELECT * FROM request_logs ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`)
      .bind(...values, limit).all();
    return json(result.results || []);
  }

  if (path === '/api/settings' && request.method === 'GET') {
    const settings = await getSettings(env);
    for (const key of ['fake_threshold', 'high_fake_threshold', 'daily_listing_limit', 'max_listings_per_hood']) settings[key] = Number(settings[key]);
    try { settings.jev_weights = JSON.parse(settings.jev_weights || '{}'); } catch { settings.jev_weights = {}; }
    try { settings.bait_keywords = JSON.parse(settings.bait_keywords || '[]'); } catch { settings.bait_keywords = []; }
    return json(settings);
  }

  if (path === '/api/settings' && request.method === 'POST') {
    const input = await request.json();
    const fakeThreshold = Number(input.fake_threshold);
    const highThreshold = Number(input.high_fake_threshold);
    const dailyLimit = Number(input.daily_listing_limit);
    const hoodLimit = Number(input.max_listings_per_hood);
    if (![fakeThreshold, highThreshold].every((value) => Number.isFinite(value) && value >= 0 && value <= 1) ||
        highThreshold < fakeThreshold || !Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 30 ||
        !Number.isInteger(hoodLimit) || hoodLimit < 1 || hoodLimit > 2) {
      return json({ error: 'مقادیر تنظیمات معتبر نیستند.' }, 400);
    }
    const baitKeywords = Array.isArray(input.bait_keywords) ? input.bait_keywords : String(input.bait_keywords || '').split(/\r?\n/);
    const weights = input.jev_weights || {};
    const weightKeys = ['price_vs_district_avg', 'price_vs_size_ratio', 'description_mismatch', 'suspicious_keywords'];
    const normalizedWeights = {};
    for (const key of weightKeys) {
      const value = Number(weights[key]);
      if (!Number.isFinite(value) || value < 0 || value > 1) return json({ error: 'وزن‌های ژو باید بین صفر و یک باشند.' }, 400);
      normalizedWeights[key] = value;
    }
    const writes = [
      ['fake_threshold', String(fakeThreshold)], ['high_fake_threshold', String(highThreshold)],
      ['daily_listing_limit', String(dailyLimit)], ['max_listings_per_hood', String(hoodLimit)],
      ['bait_keywords', JSON.stringify(baitKeywords.map((item) => String(item).trim()).filter(Boolean).slice(0, 100))],
      ['jev_weights', JSON.stringify(normalizedWeights)]
    ].map(([key, value]) => env.DB.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).bind(key, value));
    await env.DB.batch(writes);
    return json({ ok: true });
  }

  if (path === '/api/force-run' && request.method === 'GET') {
    const instance = await startWorkflow(env, { source: 'manual' });
    return json({ ok: true, id: instance.id }, 202);
  }

  const retryMatch = path.match(/^\/api\/retry\/(\d+)$/);
  if (retryMatch && request.method === 'GET') {
    const listing = await env.DB.prepare('SELECT id, extraction_done FROM listings WHERE id = ?').bind(Number(retryMatch[1])).first();
    if (!listing) return json({ error: 'آگهی پیدا نشد.' }, 404);
    if (listing.extraction_done !== -1) return json({ error: 'فقط آگهی ناموفق قابل تلاش دوباره است.' }, 409);
    const instance = await startWorkflow(env, { retryListingId: listing.id });
    return json({ ok: true, id: instance.id }, 202);
  }

  if (path === '/api/retry-all-failed' && request.method === 'POST') {
    const instance = await startWorkflow(env, { retryAllFailed: true });
    return json({ ok: true, id: instance.id }, 202);
  }

  if (path === '/api/reset-listings' && request.method === 'GET') {
    await env.DB.prepare('DELETE FROM listings').run();
    await env.DB.prepare('UPDATE scrape_state SET total_scraped = 0, consecutive_empty = 0').run();
    return json({ ok: true });
  }
  return json({ error: 'مسیر پیدا نشد.' }, 404);
}

const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#f3f6fa">
  <title>دیوار — خانه‌یاب تهران</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
  <style>
    :root{color-scheme:light;--ink:#17202c;--muted:#6c7786;--line:#e1e6ed;--paper:#fff;--canvas:#f3f6fa;--blue:#0071e3;--blue-soft:#eaf3ff;--red:#c83d45;--orange:#a85d08;--green:#16804a;--gray:#687385;--shadow:0 8px 24px rgba(29,48,71,.055)}
    *{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink);font-family:Tahoma,Vazirmatn, sans-serif;font-size:14px;line-height:1.65}button,input,select,textarea{font:inherit}button{cursor:pointer}a{color:inherit}.shell{max-width:1440px;margin:auto;padding:20px 14px 56px}.topbar{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:22px}.brand h1{font-size:21px;margin:0;font-weight:700}.brand p{margin:4px 0 0;color:var(--muted);font-size:12px}.actions{display:flex;gap:8px;flex-wrap:wrap}.button{border:1px solid var(--line);background:var(--paper);color:var(--ink);border-radius:9px;padding:8px 12px;box-shadow:0 2px 6px rgba(25,45,68,.035)}.button.primary{background:var(--blue);color:#fff;border-color:var(--blue)}.button.danger{color:var(--red)}.button:disabled{opacity:.55;cursor:wait}.stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-bottom:18px}.stat{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:13px 14px;box-shadow:var(--shadow)}.stat span{color:var(--muted);font-size:12px}.stat strong{display:block;font-size:23px;line-height:1.35;margin-top:5px}.tabs{display:flex;gap:6px;overflow:auto;border-bottom:1px solid var(--line);margin-bottom:18px}.tab{white-space:nowrap;padding:10px 13px;border:0;border-bottom:2px solid transparent;background:none;color:var(--muted)}.tab.active{border-color:var(--blue);color:var(--blue);font-weight:700}.panel{display:none}.panel.active{display:block}.section-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:0 0 14px}.section-head h2{font-size:17px;margin:0}.chart-grid{display:grid;grid-template-columns:1fr;gap:12px;margin-bottom:14px}.surface{background:var(--paper);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow)}.chart-box{padding:14px;min-width:0;height:260px}.chart-box h3{font-size:13px;margin:0 0 8px}.chart-wrap{height:205px;position:relative}.table-wrap{overflow:auto}.data-table{width:100%;border-collapse:collapse;min-width:620px}.data-table th,.data-table td{text-align:right;border-bottom:1px solid var(--line);padding:11px 13px;white-space:nowrap}.data-table th{font-size:12px;color:var(--muted);font-weight:600;background:#fafbfd}.data-table tbody tr{cursor:pointer}.data-table tbody tr:hover{background:var(--blue-soft)}.filters{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px}.filter-buttons{display:flex;gap:5px;overflow:auto}.filter-button{border:1px solid var(--line);background:#fff;border-radius:8px;padding:7px 10px;white-space:nowrap;color:var(--muted)}.filter-button.active{border-color:var(--blue);background:var(--blue-soft);color:var(--blue)}select,input,textarea{border:1px solid var(--line);border-radius:8px;padding:9px;background:#fff;color:var(--ink)}.listing-grid{display:grid;grid-template-columns:1fr;gap:11px}.listing{display:grid;grid-template-columns:88px minmax(0,1fr);gap:12px;padding:11px;background:var(--paper);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow)}.listing img{width:88px;height:88px;object-fit:cover;border-radius:8px;background:#edf1f5}.listing h3{font-size:14px;margin:0 0 4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.listing p{margin:2px 0;color:var(--muted);font-size:12px}.listing-meta{display:flex;gap:9px;flex-wrap:wrap}.listing-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px}.badge{display:inline-block;border-radius:20px;padding:2px 8px;font-size:11px;background:#eef1f5;color:var(--gray)}.badge.fake{background:#ffeaec;color:var(--red)}.badge.suspicious{background:#fff1dc;color:var(--orange)}.badge.real{background:#e5f6ed;color:var(--green)}.pagination{display:flex;align-items:center;justify-content:center;gap:12px;padding:14px}.empty{padding:34px;text-align:center;color:var(--muted)}.log-filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}.log-list{display:grid;gap:8px}.log-row{display:grid;grid-template-columns:1fr;gap:3px;padding:12px;border-bottom:1px solid var(--line)}.log-row:last-child{border-bottom:0}.log-row small{color:var(--muted)}.log-error{color:var(--red)}.settings-form{padding:16px;display:grid;gap:14px}.form-grid{display:grid;grid-template-columns:1fr;gap:12px}.field{display:grid;gap:5px}.field label{font-size:12px;color:var(--muted)}.field small{color:var(--muted)}.field textarea{min-height:116px;resize:vertical}.form-actions{display:flex;align-items:center;gap:12px}.notice{color:var(--green);font-size:12px}.spinner{display:inline-block;width:14px;height:14px;border:2px solid #c8d3e0;border-top-color:var(--blue);border-radius:50%;animation:spin .7s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
    @media(min-width:768px){.shell{padding:28px 28px 64px}.brand h1{font-size:24px}.stats{grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}.stat{padding:16px 18px}.stat strong{font-size:27px}.chart-grid{grid-template-columns:1fr 1fr}.chart-box{height:310px;padding:18px}.chart-wrap{height:250px}.listing-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.log-row{grid-template-columns:160px 120px minmax(0,1fr);align-items:start}.form-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.field.wide{grid-column:1/-1}}
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar"><div class="brand"><h1>🏠 دیوار — خانه‌یاب تهران</h1><p>پایش آگهی‌های اجاره و بررسی قیمت</p></div><div class="actions"><button class="button primary" id="force-run">▶ اجرای بررسی</button><button class="button danger" id="reset-listings">پاک‌کردن آگهی‌ها</button></div></header>
    <section class="stats" aria-label="آمار آگهی‌ها">
      <div class="stat"><span>کل آگهی‌ها</span><strong id="stat-total">—</strong></div><div class="stat"><span>آگهی‌های فیک</span><strong id="stat-fake">—</strong></div><div class="stat"><span>مشکوک</span><strong id="stat-suspicious">—</strong></div><div class="stat"><span>تأییدشده</span><strong id="stat-verified">—</strong></div><div class="stat"><span>در انتظار</span><strong id="stat-pending">—</strong></div>
    </section>
    <nav class="tabs" aria-label="بخش‌های پنل"><button class="tab active" data-tab="dashboard">📊 داشبورد</button><button class="tab" data-tab="listings">📋 آگهی‌ها</button><button class="tab" data-tab="logs">📊 لاگ‌ها</button><button class="tab" data-tab="settings">⚙️ تنظیمات</button></nav>
    <section class="panel active" id="panel-dashboard"><div class="section-head"><h2>وضعیت مناطق تهران</h2></div><div class="chart-grid"><article class="surface chart-box"><h3>تعداد آگهی در هر منطقه</h3><div class="chart-wrap"><canvas id="count-chart"></canvas></div></article><article class="surface chart-box"><h3>آگهی‌های فیک در هر منطقه</h3><div class="chart-wrap"><canvas id="fake-chart"></canvas></div></article></div><div class="surface table-wrap"><table class="data-table"><thead><tr><th>منطقه</th><th>کل آگهی</th><th>میانگین قیمت</th><th>درصد فیک</th><th>آخرین بررسی</th></tr></thead><tbody id="district-rows"></tbody></table></div></section>
    <section class="panel" id="panel-listings"><div class="section-head"><h2>آگهی‌ها</h2><button class="button" id="retry-all">تلاش دوباره برای ناموفق‌ها</button></div><div class="filters"><div class="filter-buttons"><button class="filter-button active" data-label="all">همه</button><button class="filter-button" data-label="real">تأییدشده</button><button class="filter-button" data-label="suspicious">مشکوک</button><button class="filter-button" data-label="fake">فیک</button><button class="filter-button" data-label="pending">در انتظار</button></div><select id="district-filter" aria-label="فیلتر منطقه"><option value="">همه مناطق</option></select></div><div class="listing-grid" id="listing-grid"></div><div class="pagination"><button class="button" id="previous-page">قبلی</button><span id="page-indicator">۱</span><button class="button" id="next-page">بعدی</button></div></section>
    <section class="panel" id="panel-logs"><div class="section-head"><h2>گزارش درخواست‌ها</h2></div><div class="log-filters"><select id="log-service"><option value="">همه سرویس‌ها</option><option value="scraper">اسکرپر</option><option value="workers-ai">هوش مصنوعی</option><option value="jev">ژو</option><option value="system">سیستم</option></select><select id="log-status"><option value="">همه وضعیت‌ها</option><option value="success">موفق</option><option value="error">خطا</option></select></div><div class="surface log-list" id="log-list"></div></section>
    <section class="panel" id="panel-settings"><div class="section-head"><h2>تنظیمات تحلیل</h2></div><form class="surface settings-form" id="settings-form"><div class="form-grid"><div class="field"><label for="fake-threshold">آستانه مشکوک</label><input id="fake-threshold" type="number" min="0" max="1" step="0.01" required></div><div class="field"><label for="high-threshold">آستانه فیک</label><input id="high-threshold" type="number" min="0" max="1" step="0.01" required></div><div class="field"><label for="daily-limit">حد روزانه بررسی هوش مصنوعی</label><input id="daily-limit" type="number" min="1" max="30" step="1" required></div><div class="field"><label for="hood-limit">حد آگهی از هر محله در هر اجرا</label><input id="hood-limit" type="number" min="1" max="2" step="1" required></div><div class="field wide"><label for="bait-keywords">عبارت‌های هشدار، هر عبارت در یک خط</label><textarea id="bait-keywords"></textarea></div><div class="field"><label for="weight-district">وزن اختلاف با میانگین منطقه</label><input id="weight-district" type="number" min="0" max="1" step="0.01"></div><div class="field"><label for="weight-sqm">وزن قیمت هر متر</label><input id="weight-sqm" type="number" min="0" max="1" step="0.01"></div><div class="field"><label for="weight-description">وزن ناسازگاری توضیحات</label><input id="weight-description" type="number" min="0" max="1" step="0.01"></div><div class="field"><label for="weight-keywords">وزن عبارت‌های مشکوک</label><input id="weight-keywords" type="number" min="0" max="1" step="0.01"></div></div><div class="form-actions"><button class="button primary" type="submit">ذخیره تنظیمات</button><span class="notice" id="settings-notice"></span></div></form></section>
  </main>
  <script>
    const state={page:1,label:'all',district:'',charts:{}};
    const faNumber=new Intl.NumberFormat('fa-IR');
    const currency=new Intl.NumberFormat('fa-IR',{maximumFractionDigits:0});
    async function api(path,options){const response=await fetch(path,options);const data=await response.json();if(!response.ok)throw new Error(data.error||'خطا در دریافت اطلاعات');return data;}
    function formatLocalTime(value){if(!value)return '—';const normalized=value.includes('T')?value:value.replace(' ','T')+'Z';const date=new Date(normalized);return Number.isNaN(date.getTime())?'—':new Intl.DateTimeFormat('fa-IR',{dateStyle:'short',timeStyle:'short'}).format(date);}
    function badge(label){const names={fake:'فیک',suspicious:'مشکوک',real:'تأییدشده',unknown:'نامشخص'};return '<span class="badge '+label+'">'+(names[label]||names.unknown)+'</span>';}
    async function loadStats(){const s=await api('/api/stats');document.getElementById('stat-total').textContent=faNumber.format(s.total||0);document.getElementById('stat-fake').textContent=faNumber.format(s.fake||0);document.getElementById('stat-suspicious').textContent=faNumber.format(s.suspicious||0);document.getElementById('stat-verified').textContent=faNumber.format(s.verified||0);document.getElementById('stat-pending').textContent=faNumber.format(s.pending||0);}
    async function loadDistricts(){const rows=await api('/api/districts');const body=document.getElementById('district-rows');const dropdown=document.getElementById('district-filter');body.replaceChildren();dropdown.innerHTML='<option value="">همه مناطق</option>';rows.forEach(function(d){const tr=document.createElement('tr');tr.innerHTML='<td>'+d.name_fa+'</td><td>'+faNumber.format(d.count||0)+'</td><td>'+(d.avg_price?currency.format(Math.round(d.avg_price))+' تومان':'—')+'</td><td>'+faNumber.format(Math.round(d.fake_percent||0))+'٪</td><td>'+formatLocalTime(d.last_scrape)+'</td>';tr.addEventListener('click',function(){state.district=String(d.id);dropdown.value=state.district;switchTab('listings');loadListings();});body.appendChild(tr);const option=document.createElement('option');option.value=d.id;option.textContent=d.name_fa;dropdown.appendChild(option);});if(window.Chart){const labels=rows.map(function(d){return d.name_fa.replace('منطقه ','');});const counts=rows.map(function(d){return d.count||0;});const fake=rows.map(function(d){return Math.round((d.count||0)*(d.fake_percent||0)/100);});[['count-chart',counts,'#0071e3'],['fake-chart',fake,'#c83d45']].forEach(function(item){if(state.charts[item[0]])state.charts[item[0]].destroy();state.charts[item[0]]=new Chart(document.getElementById(item[0]),{type:'bar',data:{labels:labels,datasets:[{data:item[1],backgroundColor:item[2],borderRadius:4,maxBarThickness:24}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{grid:{display:false}},y:{beginAtZero:true,ticks:{precision:0}}}}});});}}
    async function loadListings(){const params=new URLSearchParams({page:String(state.page)});if(state.district)params.set('district',state.district);if(state.label!=='all')params.set('fake_label',state.label);const data=await api('/api/listings?'+params.toString());const grid=document.getElementById('listing-grid');grid.replaceChildren();if(!data.listings.length){grid.innerHTML='<div class="surface empty">آگهی‌ای برای این فیلتر پیدا نشد.</div>'; }data.listings.forEach(function(item){const article=document.createElement('article');article.className='listing';const img=document.createElement('img');img.alt='';img.loading='lazy';img.src=item.image_url||'https://placehold.co/176x176/e9eef4/738092?text=Divar';const details=document.createElement('div');const title=document.createElement('h3');title.textContent=item.title||'بدون عنوان';const meta=document.createElement('div');meta.className='listing-meta';const price=item.rent_toman||item.price_toman;const paragraph=document.createElement('p');paragraph.textContent=price?currency.format(price)+' تومان':'قیمت نامشخص';meta.appendChild(paragraph);const attributes=document.createElement('p');attributes.textContent=[item.size_m2?faNumber.format(item.size_m2)+' متر':'',item.rooms?faNumber.format(item.rooms)+' اتاق':'',item.neighborhood_name||'',item.district_name||''].filter(Boolean).join(' · ')||'جزئیات ثبت نشده';details.append(title,meta,attributes);const actions=document.createElement('div');actions.className='listing-actions';actions.innerHTML=badge(item.fake_label);if(item.extraction_done===-1){const retry=document.createElement('button');retry.className='button';retry.textContent='تلاش دوباره';retry.addEventListener('click',function(){runAction('/api/retry/'+item.id);});actions.appendChild(retry);}const open=document.createElement('a');open.className='button';open.href=item.url;open.target='_blank';open.rel='noopener noreferrer';open.textContent='باز کردن در دیوار';actions.appendChild(open);details.appendChild(actions);article.append(img,details);grid.appendChild(article);});document.getElementById('page-indicator').textContent=faNumber.format(data.page)+' از '+faNumber.format(Math.max(1,data.pages));document.getElementById('previous-page').disabled=data.page<=1;document.getElementById('next-page').disabled=data.page>=data.pages;}
    async function loadLogs(){const params=new URLSearchParams({limit:'100'});const service=document.getElementById('log-service').value;const status=document.getElementById('log-status').value;if(service)params.set('service',service);if(status)params.set('status',status);const rows=await api('/api/logs?'+params.toString());const list=document.getElementById('log-list');list.replaceChildren();if(!rows.length)list.innerHTML='<div class="empty">گزارشی ثبت نشده است.</div>';rows.forEach(function(row){const item=document.createElement('article');item.className='log-row';const time=document.createElement('small');time.textContent=formatLocalTime(row.created_at);const serviceName={scraper:'اسکرپر','workers-ai':'هوش مصنوعی',jev:'ژو',system:'سیستم',willhaben:'سرویس'}[row.service]||row.service;const serviceEl=document.createElement('strong');serviceEl.textContent=serviceName+' · '+(row.status||'خطا');const message=document.createElement('span');message.className=row.error?'log-error':'';message.textContent=row.error||row.response_snippet||row.url||'درخواست موفق';item.append(time,serviceEl,message);list.appendChild(item);});}
    async function loadSettings(){const data=await api('/api/settings');document.getElementById('fake-threshold').value=data.fake_threshold??0.6;document.getElementById('high-threshold').value=data.high_fake_threshold??0.8;document.getElementById('daily-limit').value=data.daily_listing_limit??30;document.getElementById('hood-limit').value=data.max_listings_per_hood??2;document.getElementById('bait-keywords').value=(data.bait_keywords||[]).join('\n');const w=data.jev_weights||{};document.getElementById('weight-district').value=w.price_vs_district_avg??0.4;document.getElementById('weight-sqm').value=w.price_vs_size_ratio??0.25;document.getElementById('weight-description').value=w.description_mismatch??0.2;document.getElementById('weight-keywords').value=w.suspicious_keywords??0.15;}
    function switchTab(name){document.querySelectorAll('.tab').forEach(function(button){button.classList.toggle('active',button.dataset.tab===name);});document.querySelectorAll('.panel').forEach(function(panel){panel.classList.toggle('active',panel.id==='panel-'+name);});if(name==='dashboard'&&!state.charts['count-chart'])loadDistricts();if(name==='listings')loadListings();if(name==='logs')loadLogs();if(name==='settings')loadSettings();}
    async function runAction(path,method){try{const result=await api(path,{method:method||'GET'});alert(result.id?'درخواست ثبت شد. شناسه: '+result.id:'عملیات انجام شد.');await loadStats();if(path.indexOf('/api/retry')===0)loadListings();if(path.indexOf('/api/reset-listings')===0){loadListings();loadDistricts();}}catch(error){alert(error.message);}}
    document.querySelectorAll('.tab').forEach(function(button){button.addEventListener('click',function(){switchTab(button.dataset.tab);});});
    document.getElementById('force-run').addEventListener('click',function(){runAction('/api/force-run');});
    document.getElementById('reset-listings').addEventListener('click',function(){if(confirm('همه آگهی‌ها پاک شوند؟ مناطق و محله‌ها باقی می‌مانند.'))runAction('/api/reset-listings');});
    document.querySelectorAll('.filter-button').forEach(function(button){button.addEventListener('click',function(){document.querySelectorAll('.filter-button').forEach(function(item){item.classList.remove('active');});button.classList.add('active');state.label=button.dataset.label;state.page=1;loadListings();});});
    document.getElementById('district-filter').addEventListener('change',function(event){state.district=event.target.value;state.page=1;loadListings();});
    document.getElementById('previous-page').addEventListener('click',function(){state.page=Math.max(1,state.page-1);loadListings();});document.getElementById('next-page').addEventListener('click',function(){state.page+=1;loadListings();});
    document.getElementById('log-service').addEventListener('change',loadLogs);document.getElementById('log-status').addEventListener('change',loadLogs);
    document.getElementById('retry-all').addEventListener('click',function(){runAction('/api/retry-all-failed','POST');});
    document.getElementById('settings-form').addEventListener('submit',async function(event){event.preventDefault();const notice=document.getElementById('settings-notice');notice.textContent='';const values={fake_threshold:Number(document.getElementById('fake-threshold').value),high_fake_threshold:Number(document.getElementById('high-threshold').value),daily_listing_limit:Number(document.getElementById('daily-limit').value),max_listings_per_hood:Number(document.getElementById('hood-limit').value),bait_keywords:document.getElementById('bait-keywords').value,jev_weights:{price_vs_district_avg:Number(document.getElementById('weight-district').value),price_vs_size_ratio:Number(document.getElementById('weight-sqm').value),description_mismatch:Number(document.getElementById('weight-description').value),suspicious_keywords:Number(document.getElementById('weight-keywords').value)}};try{await api('/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(values)});notice.textContent='تنظیمات ذخیره شد.';}catch(error){notice.textContent=error.message;notice.style.color='var(--red)';}});
    Promise.all([loadStats(),loadDistricts()]).catch(function(error){console.error(error);});
  </script>
</body>
</html>`;

export async function serveUI() {
  return html(DASHBOARD_HTML);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' && request.method === 'GET') return serveUI();
    if (url.pathname.startsWith('/api/')) {
      try { return await apiRoute(request, env, url); }
      catch (error) {
        await logError(env, 'system', url.pathname, error);
        return json({ error: 'خطای داخلی سرور رخ داد.' }, 500);
      }
    }
    return html(`<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><title>یافت نشد</title><body><h1>صفحه پیدا نشد.</h1></body></html>`, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(startWorkflow(env, { source: 'scheduled', cron: event.cron || '' }).catch(async (error) => {
      await logError(env, 'system', 'scheduled', error);
    }));
  }
};