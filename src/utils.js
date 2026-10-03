export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

export function escHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

export function normalizeDigits(value) {
  return String(value ?? '').replace(/[۰-۹٠-٩]/g, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x06f0 && code <= 0x06f9 ? code - 0x06f0 : code - 0x0660);
  });
}

export function parseLocalizedNumber(value) {
  const normalized = normalizeDigits(value).replace(/[٬،,\s]/g, '');
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

export async function logError(env, service, url, error, status = 0, responseSnippet = '') {
  try {
    await env.DB.prepare(
      'INSERT INTO request_logs (service, url, status, error, response_snippet) VALUES (?, ?, ?, ?, ?)'
    ).bind(service, url || null, status, String(error?.message || error || 'Unknown error').slice(0, 1000), responseSnippet.slice(0, 1000)).run();
  } catch (logFailure) {
    console.error('Failed to write request error log', logFailure);
  }
}

export async function logSuccess(env, service, url, message, status = 200) {
  try {
    await env.DB.prepare(
      'INSERT INTO request_logs (service, url, status, error, response_snippet) VALUES (?, ?, ?, NULL, ?)'
    ).bind(service, url || null, status, String(message || '').slice(0, 1000)).run();
  } catch (error) {
    console.error('Failed to write request success log', error);
  }
}

export async function isAiQuotaExhausted(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM system_state WHERE key = 'ai_quota_until'").first();
    return Number(row?.value || 0) > Date.now();
  } catch (error) {
    await logError(env, 'system', null, error);
    return false;
  }
}

export async function markAiQuotaExhausted(env) {
  const until = String(Date.now() + 24 * 60 * 60 * 1000);
  try {
    await env.DB.prepare(
      "INSERT INTO system_state (key, value, updated_at) VALUES ('ai_quota_until', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
    ).bind(until).run();
  } catch (error) {
    await logError(env, 'system', null, error);
  }
}

export async function getSettings(env) {
  const rows = await env.DB.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries((rows.results || []).map(({ key, value }) => [key, value]));
}