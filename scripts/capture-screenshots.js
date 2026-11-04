import fs from 'fs';
import { execSync } from 'child_process';
import { dashboardHtml } from '../src/dashboard.js';

const mockNeighborhoods = [
  { id: 1, slug: 'central-janat-abad', name_fa: 'جنت‌آباد مرکزی', count: 420, avg_deposit: 850000000, median_deposit: 800000000, median_deposit_per_sqm: 10000000, avg_rent: 22000000, median_rent: 20000000, fake_count: 14, suspicious_count: 22, last_scraped_at: '2026-11-04 10:00:00' },
  { id: 2, slug: 'south-janat-abad', name_fa: 'جنت‌آباد جنوبی', count: 380, avg_deposit: 950000000, median_deposit: 900000000, median_deposit_per_sqm: 11200000, avg_rent: 25000000, median_rent: 24000000, fake_count: 8, suspicious_count: 15, last_scraped_at: '2026-11-04 10:00:00' },
  { id: 3, slug: 'north-janat-abad', name_fa: 'جنت‌آباد شمالی', count: 310, avg_deposit: 780000000, median_deposit: 750000000, median_deposit_per_sqm: 9300000, avg_rent: 18000000, median_rent: 18000000, fake_count: 5, suspicious_count: 12, last_scraped_at: '2026-11-04 10:00:00' },
  { id: 4, slug: 'shahin', name_fa: 'شاهین', count: 260, avg_deposit: 820000000, median_deposit: 800000000, median_deposit_per_sqm: 10500000, avg_rent: 20000000, median_rent: 19000000, fake_count: 7, suspicious_count: 9, last_scraped_at: '2026-11-04 10:00:00' },
  { id: 5, slug: 'sardar-e-jangal', name_fa: 'سردارجنگل', count: 240, avg_deposit: 1100000000, median_deposit: 1000000000, median_deposit_per_sqm: 12500000, avg_rent: 28000000, median_rent: 26000000, fake_count: 6, suspicious_count: 14, last_scraped_at: '2026-11-04 10:00:00' },
  { id: 6, slug: 'kooy-e-ferdos', name_fa: 'فردوس', count: 490, avg_deposit: 1200000000, median_deposit: 1100000000, median_deposit_per_sqm: 13700000, avg_rent: 30000000, median_rent: 28000000, fake_count: 11, suspicious_count: 18, last_scraped_at: '2026-11-04 10:00:00' }
];

const mockListings = [
  {
    id: 101,
    title: 'آپارتمان ۸۵ متری دو خوابه فول امکانات',
    neighborhood_name: 'جنت‌آباد مرکزی',
    deposit_toman: 600000000,
    rent_toman: 18000000,
    size_m2: 85,
    rooms: 2,
    description: 'نورگیر عالی، دسترسی عالی به بزرگراه همت و ستاری، دارای پارکینگ و آسانسور.',
    fake_label: 'real',
    scraped_at: '2026-11-04 10:05:00',
    url: 'https://divar.ir'
  },
  {
    id: 102,
    title: 'فرصت استثنایی رهن کامل زیر قیمت منطقه',
    neighborhood_name: 'فردوس',
    deposit_toman: 350000000,
    rent_toman: 0,
    size_m2: 90,
    rooms: 2,
    description: 'فوری فقط امروز! ودیعه بسیار مناسب، تخلیه فوری به دلیل مهاجرت مالک.',
    fake_label: 'fake',
    fake_reason: 'انحراف قیمت شدید: نسبت ودیعه هر متر به میانگین محله ۳۸٪ است.',
    scraped_at: '2026-11-04 10:12:00',
    url: 'https://divar.ir'
  },
  {
    id: 103,
    title: 'اجاره هم‌خانه خانم دانشجو یا کارمند',
    neighborhood_name: 'سردارجنگل',
    deposit_toman: 50000000,
    rent_toman: 4000000,
    size_m2: 20,
    rooms: 1,
    description: 'یک نفر هم‌اتاقی خانم موجه، آپارتمان مبله کامل در محدوده سردارجنگل.',
    fake_label: 'hamkhane',
    fake_reason: 'آگهی هم‌خانه است و اجارهٔ مستقل محسوب نمی‌شود.',
    scraped_at: '2026-11-04 10:15:00',
    url: 'https://divar.ir'
  },
  {
    id: 104,
    title: '۷۵ متر شاهین شمالی بازسازی شده',
    neighborhood_name: 'شاهین',
    deposit_toman: 500000000,
    rent_toman: 12000000,
    size_m2: 75,
    rooms: 2,
    description: 'کابینت های‌گلاس، خوش‌نقشه و آفتاب‌گیر، آماده تحویل.',
    fake_label: 'suspicious',
    fake_reason: 'نسبت ودیعهٔ هر متر به میانگین محله ۵۵٪ است.',
    scraped_at: '2026-11-04 10:20:00',
    url: 'https://divar.ir'
  },
  {
    id: 105,
    title: 'رهن کامل ۱۱۰ متری جنت‌آباد جنوبی',
    neighborhood_name: 'جنت‌آباد جنوبی',
    deposit_toman: 950000000,
    rent_toman: 0,
    size_m2: 110,
    rooms: 2,
    description: 'آپارتمان تک‌واحدی، پارکینگ و انباری، سند تک‌برگ.',
    fake_label: 'real',
    scraped_at: '2026-11-04 10:24:00',
    url: 'https://divar.ir'
  },
  {
    id: 106,
    title: 'اجاره ۶۰ متری با ودیعه فوق‌العاده کم',
    neighborhood_name: 'فردوس',
    deposit_toman: 120000000,
    rent_toman: 9000000,
    size_m2: 60,
    rooms: 1,
    description: 'فقط امروز، مالک سفر رفته، ودیعه واقعاً مناسب.',
    fake_label: 'fake',
    fake_reason: 'ودیعهٔ هر متر ۲۲٪ میانگین محله و وجود دو عبارت طعمه.',
    scraped_at: '2026-11-04 10:28:00',
    url: 'https://divar.ir'
  },
  {
    id: 107,
    title: 'آپارتمان ۹۵ متری سردارجنگل با ویو',
    neighborhood_name: 'سردارجنگل',
    deposit_toman: 1100000000,
    rent_toman: 25000000,
    size_m2: 95,
    rooms: 2,
    description: 'طبقه پنجم، آسانسور، پارکینگ، نور جنوبی.',
    fake_label: 'real',
    scraped_at: '2026-11-04 10:31:00',
    url: 'https://divar.ir'
  },
  {
    id: 108,
    title: '۷۰ متری نزدیک مترو، ودیعه توافقی',
    neighborhood_name: 'جنت‌آباد شمالی',
    deposit_toman: 300000000,
    rent_toman: 16000000,
    size_m2: 70,
    rooms: 1,
    description: 'قیمت توافقی، دسترسی عالی، مناسب زوج جوان.',
    fake_label: 'suspicious',
    fake_reason: 'نسبت ودیعهٔ هر متر به میانگین محله ۵۸٪ است.',
    scraped_at: '2026-11-04 10:35:00',
    url: 'https://divar.ir'
  }
];

const mockLogs = [
  { id: 1, service: 'neighborhood-discovery', created_at: '2026-11-04 10:00:00', error: null, response_snippet: 'Discovered 453 Tehran neighborhoods' },
  { id: 2, service: 'scraper', created_at: '2026-11-04 10:01:30', error: null, response_snippet: 'Got 30 listings from central-janat-abad' },
  { id: 3, service: 'workers-ai', created_at: '2026-11-04 10:02:15', error: null, response_snippet: 'Extracted listing 101' },
  { id: 4, service: 'jev', created_at: '2026-11-04 10:02:20', error: null, response_snippet: 'Evaluated listing 101' },
  { id: 5, service: 'system', created_at: '2026-11-04 10:03:00', error: null, response_snippet: 'Workflow complete: source=auto, evaluated=25' }
];

const mockAnalytics = {
  days: 30,
  overall: {
    count: 2100,
    fake_count: 51,
    suspicious_count: 90,
    hamkhane_count: 32,
    pending: 0,
    average_deposit: 920000000,
    median_deposit: 850000000,
    average_rent: 23500000,
    median_rent: 22000000,
    median_deposit_per_sqm: 11000000
  },
  selected: {
    name_fa: 'همهٔ محله‌ها',
    count: 2100,
    average_deposit: 920000000,
    median_deposit: 850000000,
    average_rent: 23500000,
    median_rent: 22000000,
    median_deposit_per_sqm: 11000000,
    fake_count: 51,
    suspicious_count: 90
  },
  top_neighborhoods: mockNeighborhoods.slice(0, 5),
  daily: [
    { day: '2026-10-28', median_deposit: 820000000 },
    { day: '2026-10-29', median_deposit: 830000000 },
    { day: '2026-10-30', median_deposit: 840000000 },
    { day: '2026-10-31', median_deposit: 840000000 },
    { day: '2026-11-01', median_deposit: 850000000 },
    { day: '2026-11-02', median_deposit: 850000000 },
    { day: '2026-11-03', median_deposit: 850000000 },
    { day: '2026-11-04', median_deposit: 850000000 }
  ]
};

const mockQuota = {
  date: '2026-11-04',
  limit: 500,
  used: 120,
  auto_used: 110,
  manual_used: 10,
  auto_limit: 400,
  manual_limit: 100,
  manual_remaining: 90,
  remaining: 380,
  manual_searches: 1,
  quota_exhausted: false
};

const mockSettings = {
  daily_listing_limit: 500,
  fake_threshold: 0.6,
  high_fake_threshold: 0.8,
  auto_neighborhoods: ['central-janat-abad', 'south-janat-abad', 'north-janat-abad', 'shahin', 'sardar-e-jangal', 'kooy-e-ferdos'],
  bait_keywords: ['قیمت توافقی', 'زیر قیمت', 'فوری', 'فرصت استثنایی', 'فقط امروز']
};

const chartShim = String.raw`<script>
window.Chart=function(canvas,cfg){
  function setup(){
    var rect=canvas.getBoundingClientRect();
    var dpr=window.devicePixelRatio||1;
    canvas.width=Math.max(1,Math.round(rect.width*dpr));
    canvas.height=Math.max(1,Math.round(rect.height*dpr));
    var ctx=canvas.getContext('2d');
    ctx.setTransform(dpr,0,0,dpr,0,0);
    return {ctx:ctx,w:rect.width,h:rect.height};
  }
  function compact(value){
    var n=Number(value)||0;
    if(n>=1e9)return (n/1e9).toFixed(1).replace('.0','')+' میلیارد';
    if(n>=1e6)return Math.round(n/1e6)+' میلیون';
    if(n>=1e3)return Math.round(n/1e3)+' هزار';
    return String(Math.round(n));
  }
  function shortLabel(label){
    var parts=String(label||'').trim().split(/\s+/);
    return parts.length>1?parts[parts.length-1]:String(label||'');
  }
  function draw(){
    var box=setup(),ctx=box.ctx,w=box.w,h=box.h;
    if(!w||!h)return;
    var data=cfg.data||{},labels=data.labels||[],ds=(data.datasets||[])[0]||{data:[]},values=ds.data||[];
    ctx.clearRect(0,0,w,h);
    var padL=10,padR=10,padT=20,padB=26,plotW=Math.max(1,w-padL-padR),plotH=Math.max(1,h-padT-padB);
    var max=Math.max.apply(null,values.concat([1]));
    ctx.strokeStyle='#e1e6ed';ctx.lineWidth=1;
    for(var line=0;line<=4;line+=1){var gy=padT+plotH*line/4;ctx.beginPath();ctx.moveTo(padL,gy);ctx.lineTo(w-padR,gy);ctx.stroke();}
    ctx.font='10px Tahoma,Vazirmatn,sans-serif';ctx.textAlign='center';
    if(cfg.type==='bar'){
      var step=plotW/Math.max(1,values.length),barW=Math.min(34,step*0.55);
      values.forEach(function(value,index){
        var x=padL+step*index+(step-barW)/2;
        var barH=plotH*(Number(value)||0)/max;
        ctx.fillStyle='#5a9df0';
        ctx.fillRect(x,padT+plotH-barH,barW,barH);
        ctx.fillStyle='#6c7786';
        ctx.fillText(shortLabel(labels[index]),padL+step*index+step/2,h-9);
        ctx.fillStyle='#17202c';
        ctx.fillText(compact(value),padL+step*index+step/2,padT+plotH-barH-5);
      });
    } else {
      var points=values.map(function(value,index){
        return {x:padL+(values.length<=1?plotW/2:plotW*index/(values.length-1)),y:padT+plotH-plotH*(Number(value)||0)/max};
      });
      if(points.length){
        ctx.strokeStyle='#0071e3';ctx.lineWidth=2;ctx.beginPath();
        points.forEach(function(point,index){if(index===0)ctx.moveTo(point.x,point.y);else ctx.lineTo(point.x,point.y);});
        ctx.stroke();
        points.forEach(function(point){ctx.fillStyle='#0071e3';ctx.beginPath();ctx.arc(point.x,point.y,3,0,Math.PI*2);ctx.fill();});
      }
      ctx.fillStyle='#6c7786';
      var labelStep=Math.max(1,Math.ceil(values.length/6));
      var lastX=-999;
      values.forEach(function(value,index){
        if(index%labelStep!==0&&index!==values.length-1)return;
        var lx=padL+(values.length<=1?plotW/2:plotW*index/(values.length-1));
        lx=Math.min(w-padR-32,Math.max(padL+32,lx));
        if(index!==0&&Math.abs(lx-lastX)<52)return;
        ctx.fillText(String(labels[index]||''),lx,h-9);
        lastX=lx;
      });
    }
  }
  draw();
  window.addEventListener('resize',draw);
  this.destroy=function(){window.removeEventListener('resize',draw);};
};
</script>`;

function buildHtmlForTab(tabName, after = '') {
  let html = dashboardHtml();
  // Replace the CDN script with an offline canvas renderer so screenshots are deterministic
  html = html.replace(
    '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>',
    chartShim
  );

  // Inject client-side router and mockApi
  const injection = `
<script>
window.mockApi = async function(path) {
  var url = new URL(path, 'http://localhost');
  if (path.includes('/api/neighborhoods')) {
    return { neighborhoods: ${JSON.stringify(mockNeighborhoods)}, total: 6, page: 1, pages: 1 };
  }
  if (path.includes('/api/analytics')) {
    var slug = url.searchParams.get('neighborhood');
    var hood = slug ? ${JSON.stringify(mockNeighborhoods)}.find(function(item) { return item.slug === slug; }) : null;
    if (hood) {
      return Object.assign({}, ${JSON.stringify(mockAnalytics)}, {
        selected: {
          name_fa: hood.name_fa,
          count: hood.count,
          average_deposit: hood.avg_deposit,
          median_deposit: hood.median_deposit,
          median_deposit_per_sqm: hood.median_deposit_per_sqm,
          average_rent: hood.avg_rent,
          median_rent: hood.median_rent,
          fake_count: hood.fake_count,
          suspicious_count: hood.suspicious_count
        }
      });
    }
    return ${JSON.stringify(mockAnalytics)};
  }
  if (path.includes('/api/listings')) {
    var label = url.searchParams.get('label');
    var hoodName = url.searchParams.get('neighborhood');
    var rows = ${JSON.stringify(mockListings)}.filter(function(item) {
      if (label && item.fake_label !== label) return false;
      if (hoodName && item.neighborhood_name !== hoodName) return false;
      return true;
    });
    return { listings: rows, total: rows.length, page: 1, pages: 1 };
  }
  if (path.includes('/api/quota')) return ${JSON.stringify(mockQuota)};
  if (path.includes('/api/settings')) return ${JSON.stringify(mockSettings)};
  if (path.includes('/api/logs')) return ${JSON.stringify(mockLogs)};
  return {};
};
</script>
`;
  html = html.replace('</head>', `${injection}</head>`);

  // Override api function
  html = html.replace(
    'async function api(path,options){',
    'async function api(path,options){if(window.mockApi)return window.mockApi(path,options);'
  );

  // Auto trigger the target tab (and optional interaction) after data loads
  const trigger = `refresh().then(()=>{ showTab('${tabName}'); setTimeout(()=>{ ${after} }, 120); }).catch(e=>console.error(e));`;
  html = html.replace(
    'refresh().then(()=>{const initialTab=new URL(location.href).searchParams.get(\'tab\');if(initialTab)showTab(initialTab)}).catch(error=>console.error(error));',
    trigger
  );
  html = html.replace(
    'refresh().catch(error=>console.error(error));',
    trigger
  );

  return html;
}

const tabs = [
  { tab: 'overview', file: 'docs/screenshots/01-overview.png', size: '1280,1720' },
  { tab: 'listings', file: 'docs/screenshots/02-listings.png', size: '1280,1200' },
  { tab: 'manual', file: 'docs/screenshots/03-manual-run.png', size: '1280,950' },
  { tab: 'settings', file: 'docs/screenshots/04-settings.png', size: '1280,1150' },
  { tab: 'logs', file: 'docs/screenshots/05-logs.png', size: '1280,950' },
  {
    tab: 'overview',
    file: 'docs/screenshots/06-overview-selected.png',
    size: '1280,1500',
    after: "var card=document.querySelector('.top-card'); if(card) card.click();"
  },
  {
    tab: 'listings',
    file: 'docs/screenshots/07-listings-filtered.png',
    size: '1280,1000',
    after: "var label=document.getElementById('listing-label'); label.value='fake'; label.dispatchEvent(new Event('change'));"
  }
];

for (const item of tabs) {
  const html = buildHtmlForTab(item.tab, item.after || '');
  const tempPath = `/tmp/preview-${item.file.split('/').pop().replace('.png', '')}.html`;
  fs.writeFileSync(tempPath, html, 'utf8');

  const profile = `/tmp/chrome-prof-${Date.now()}`;
  const cmd = `google-chrome --headless=new --disable-gpu --no-sandbox --disable-background-networking --disable-default-apps --disable-extensions --disable-sync --disable-translate --no-first-run --safebrowsing-disable-auto-update --virtual-time-budget=4000 --user-data-dir="${profile}" --window-size=${item.size || '1280,950'} --screenshot=${item.file} "file://${tempPath}"`;
  try {
    execSync(cmd, { stdio: 'inherit' });
    console.log(`Captured ${item.file}`);
  } catch (e) {
    console.error(`Error capturing ${item.file}:`, e.message);
  } finally {
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}
console.log('All screenshots done!');
