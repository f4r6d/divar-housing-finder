import { canAcquireLease, formatLease } from './chain.js';

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
  if (!env?.DB) return;
  try {
    await env.DB.prepare(
      'INSERT INTO request_logs (service, url, status, error, response_snippet) VALUES (?, ?, ?, ?, ?)'
    ).bind(service, url || null, status, String(error?.message || error || 'Unknown error').slice(0, 1000), responseSnippet.slice(0, 1000)).run();
  } catch (logFailure) {
    console.error('Failed to write request error log', logFailure);
  }
}

export async function logSuccess(env, service, url, message, status = 200) {
  if (!env?.DB) return;
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

export async function getSettings(env) {
  const rows = await env.DB.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries((rows.results || []).map(({ key, value }) => [key, value]));
}

const LEASE_KEY = 'workflow_running';

export async function readWorkflowLease(env) {
  const row = await env.DB.prepare('SELECT value FROM system_state WHERE key = ?').bind(LEASE_KEY).first();
  return String(row?.value || '0');
}

// Entry points reject when a different chain holds a fresh lease; a stale lease is takeover-able.
export async function isWorkflowBusy(env, staleMs) {
  const value = await readWorkflowLease(env);
  return !canAcquireLease(value, Date.now(), staleMs);
}

// Atomic acquisition: only overwrites when the token is free/legacy/stale. Returns true when this
// run took the lease. INSERT branch handles the missing-key case.
export async function acquireWorkflowLease(env, runId, staleMs) {
  const value = formatLease(runId, Date.now());
  const cutoff = Date.now() - staleMs;
  const row = await env.DB.prepare(`
    INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    WHERE system_state.value IS NULL OR system_state.value = '0' OR system_state.value NOT LIKE 'run:%'
      OR CAST(substr(system_state.value, -13) AS INTEGER) < ?
    RETURNING value
  `).bind(LEASE_KEY, value, cutoff).first();
  return Boolean(row);
}

// Child first step renews the lease. Succeeds only when the token belongs to this run, or is
// free/legacy/stale. A foreign fresh chain blocks the renewal so the child can bail without writes.
export async function renewWorkflowLease(env, runId, staleMs) {
  const value = formatLease(runId, Date.now());
  const cutoff = Date.now() - staleMs;
  const pattern = `run:${runId}:%`;
  const row = await env.DB.prepare(`
    UPDATE system_state SET value = ?, updated_at = datetime('now')
    WHERE key = ?
      AND ( value = '0' OR value IS NULL OR value NOT LIKE 'run:%'
        OR CAST(substr(value, -13) AS INTEGER) < ?
        OR value LIKE ? )
    RETURNING value
  `).bind(value, LEASE_KEY, cutoff, pattern).first();
  return Boolean(row);
}

// Finalize resets the lease to free, but only if this run still owns it (a newer chain is untouched).
export async function releaseWorkflowLease(env, runId) {
  await env.DB.prepare(`
    UPDATE system_state SET value = '0', updated_at = datetime('now')
    WHERE key = ? AND value LIKE ?
  `).bind(LEASE_KEY, `run:${runId}:%`).run();
}

export async function ownsWorkflowLease(env, runId) {
  return (await readWorkflowLease(env)).startsWith(`run:${runId}:`);
}

// Observability mirror only (never the source of correctness). Crash after this write but before the
// child is created is harmless: recovery re-derives work from the DB queues.
export async function writeChainState(env, state) {
  await env.DB.prepare(`
    INSERT INTO system_state (key, value, updated_at) VALUES ('chain_state', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).bind(JSON.stringify(state)).run();
}