const ID_RE = /^[a-f0-9]{64}$/;
const MESSAGE_ID_RE = /^[0-9a-f-]{36}$/i;
const IV_RE = /^[A-Za-z0-9_-]{16}$/;
const CIPHERTEXT_RE = /^[A-Za-z0-9_-]+$/;
const MAX_BODY_BYTES = 12_000;
const MAX_ACTIVE_MESSAGES = 100;
const MAX_MESSAGES_PER_HOUR = 20;
const MESSAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GLOBAL_MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GLOBAL_MESSAGE_LIMIT = 1200;
const GLOBAL_PAGE_SIZE = 60;
const encoder = new TextEncoder();

function corsHeaders(origin, allowedOrigins) {
  const allowed = String(allowedOrigins || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(value, status, cors) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...cors } });
}

function randomBytes(length) { const bytes = new Uint8Array(length); crypto.getRandomValues(bytes); return bytes; }
function toHex(bytes) { return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join(''); }
function toBase64Url(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
async function digest(value) { return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? encoder.encode(value) : value))); }
async function passwordHash(password, salt) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return toHex(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 120_000 }, material, 256)));
}
function validNickname(value) { return typeof value === 'string' && /^[\p{L}\p{N}\p{M}_ -]{2,24}$/u.test(value.trim()); }
function validPassword(value) { return typeof value === 'string' && value.length >= 10 && value.length <= 128; }
function ageIsAdult(value, now = Date.now()) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const born = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(born.getTime()) || born.toISOString().slice(0, 10) !== value || born.getTime() > now) return false;
  const today = new Date(now);
  let age = today.getUTCFullYear() - born.getUTCFullYear();
  if (today.getUTCMonth() < born.getUTCMonth() || (today.getUTCMonth() === born.getUTCMonth() && today.getUTCDate() < born.getUTCDate())) age--;
  return age >= 18;
}
async function globalBody(request) { try { const value = await readBoundedJson(request); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; } }
async function issueSession(env, userId, now) {
  const token = toBase64Url(randomBytes(32));
  const tokenHash = await digest(token);
  await env.DB.prepare('INSERT INTO global_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').bind(tokenHash, userId, now + SESSION_TTL_MS, now).run();
  return token;
}
async function authenticatedUser(request, env, now) {
  const token = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{40,50})$/)?.[1];
  if (!token) return null;
  const tokenHash = await digest(token);
  const row = await env.DB.prepare('SELECT u.id, u.nickname FROM global_sessions s JOIN global_users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?').bind(tokenHash, now).first();
  return row || null;
}

async function handleGlobal(request, env, cors, url) {
  if (!env.DB) return json({ error: 'unavailable' }, 503, cors);
  const path = url.pathname.replace(/\/$/, '');
  const method = request.method;
  const now = Date.now();
  try {
    if (path === '/api/global/status' && method === 'GET') {
      await env.DB.prepare('SELECT COUNT(*) AS count FROM global_users').first();
      return json({ enabled: true, retentionDays: 7 }, 200, cors);
    }

    if (path === '/api/global/register' && method === 'POST') {
      const value = await globalBody(request);
      if (!value || !validNickname(value.nickname) || !validPassword(value.password) || !ageIsAdult(value.birthDate, now) || !/^[a-z]{2,3}(-[A-Z]{2})?$/.test(value.language || '') || !/^[A-Z]{2}$/.test(value.country || '') || !['woman', 'man', 'nonbinary', 'prefer_not_say'].includes(value.gender)) return json({ error: 'invalid_registration' }, 422, cors);
      if (value.accepted !== true) return json({ error: 'consent_required' }, 422, cors);
      const nickname = value.nickname.trim();
      const nicknameKey = nickname.normalize('NFKC').toLocaleLowerCase('en-US');
      const duplicate = await env.DB.prepare('SELECT id FROM global_users WHERE nickname_key = ?').bind(nicknameKey).first();
      if (duplicate) return json({ error: 'nickname_taken' }, 409, cors);
      const id = toBase64Url(randomBytes(18));
      const salt = randomBytes(16);
      const hash = await passwordHash(value.password, salt);
      await env.DB.prepare('INSERT INTO global_users (id, nickname, nickname_key, password_salt, password_hash, language, gender, country, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, nickname, nicknameKey, toBase64Url(salt), hash, value.language, value.gender, value.country, now).run();
      const token = await issueSession(env, id, now);
      return json({ token, user: { id, nickname } }, 201, cors);
    }

    if (path === '/api/global/login' && method === 'POST') {
      const value = await globalBody(request);
      if (!value || !validNickname(value.nickname) || !validPassword(value.password)) return json({ error: 'invalid_credentials' }, 422, cors);
      const nicknameKey = value.nickname.trim().normalize('NFKC').toLocaleLowerCase('en-US');
      const attempts = await env.DB.prepare('SELECT COUNT(*) AS count FROM global_auth_attempts WHERE nickname_key = ? AND created_at > ?').bind(nicknameKey, now - 15 * 60 * 1000).first();
      if (attempts.count >= 10) return json({ error: 'rate_limited' }, 429, cors);
      const row = await env.DB.prepare('SELECT id, nickname, password_salt, password_hash FROM global_users WHERE nickname_key = ?').bind(nicknameKey).first();
      if (!row) {
        await env.DB.prepare('INSERT INTO global_auth_attempts (nickname_key, created_at) VALUES (?, ?)').bind(nicknameKey, now).run();
        return json({ error: 'invalid_credentials' }, 401, cors);
      }
      const actual = await passwordHash(value.password, Uint8Array.from(atob(row.password_salt.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0)));
      if (actual !== row.password_hash) {
        await env.DB.prepare('INSERT INTO global_auth_attempts (nickname_key, created_at) VALUES (?, ?)').bind(nicknameKey, now).run();
        return json({ error: 'invalid_credentials' }, 401, cors);
      }
      await env.DB.prepare('DELETE FROM global_auth_attempts WHERE nickname_key = ?').bind(nicknameKey).run();
      return json({ token: await issueSession(env, row.id, now), user: { id: row.id, nickname: row.nickname } }, 200, cors);
    }

    const user = await authenticatedUser(request, env, now);
    if (!user) return json({ error: 'unauthorized' }, 401, cors);
    if (path === '/api/global/session' && method === 'DELETE') {
      const token = request.headers.get('Authorization').slice(7);
      await env.DB.prepare('DELETE FROM global_sessions WHERE token_hash = ?').bind(await digest(token)).run();
      return json({ ok: true }, 200, cors);
    }
    if (path === '/api/global/account' && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM global_reports WHERE reporter_id = ? OR message_id IN (SELECT id FROM global_messages WHERE user_id = ?)').bind(user.id, user.id).run();
      await env.DB.prepare('DELETE FROM global_blocks WHERE user_id = ? OR blocked_user_id = ?').bind(user.id, user.id).run();
      await env.DB.prepare('DELETE FROM global_messages WHERE user_id = ?').bind(user.id).run();
      await env.DB.prepare('DELETE FROM global_sessions WHERE user_id = ?').bind(user.id).run();
      await env.DB.prepare('DELETE FROM global_users WHERE id = ?').bind(user.id).run();
      return json({ ok: true }, 200, cors);
    }
    if (path === '/api/global/messages' && method === 'GET') {
      const before = Number(url.searchParams.get('before') || 0);
      const blocked = await env.DB.prepare('SELECT blocked_user_id FROM global_blocks WHERE user_id = ?').bind(user.id).all();
      const blockedIds = (blocked.results || []).map((row) => row.blocked_user_id);
      const result = before > 0
        ? await env.DB.prepare(`SELECT m.id, m.nickname, m.body, m.created_at AS createdAt FROM global_messages m WHERE m.id < ? AND m.created_at > ? ${blockedIds.length ? `AND m.user_id NOT IN (${blockedIds.map(() => '?').join(',')})` : ''} ORDER BY m.id DESC LIMIT ?`).bind(before, now - GLOBAL_MESSAGE_TTL_MS, ...blockedIds, GLOBAL_PAGE_SIZE).all()
        : await env.DB.prepare(`SELECT m.id, m.nickname, m.body, m.created_at AS createdAt FROM global_messages m WHERE m.created_at > ? ${blockedIds.length ? `AND m.user_id NOT IN (${blockedIds.map(() => '?').join(',')})` : ''} ORDER BY m.id DESC LIMIT ?`).bind(now - GLOBAL_MESSAGE_TTL_MS, ...blockedIds, GLOBAL_PAGE_SIZE).all();
      return json({ messages: (result.results || []).reverse() }, 200, cors);
    }
    if (path === '/api/global/messages' && method === 'POST') {
      const value = await globalBody(request);
      if (!value || typeof value.body !== 'string' || !value.body.trim() || value.body.trim().length > GLOBAL_MESSAGE_LIMIT) return json({ error: 'invalid_message' }, 422, cors);
      const rate = await env.DB.prepare('SELECT COUNT(*) AS count FROM global_messages WHERE user_id = ? AND created_at > ?').bind(user.id, now - 60_000).first();
      if (rate.count >= 10) return json({ error: 'rate_limited' }, 429, cors);
      const result = await env.DB.prepare('INSERT INTO global_messages (user_id, nickname, body, created_at) VALUES (?, ?, ?, ?)').bind(user.id, user.nickname, value.body.trim(), now).run();
      return json({ id: result.meta?.last_row_id, createdAt: now }, 201, cors);
    }
    const reportMatch = path.match(/^\/api\/global\/messages\/(\d+)\/report$/);
    if (reportMatch && method === 'POST') {
      const value = await globalBody(request);
      if (!value || !['spam', 'harassment', 'personal_info', 'other'].includes(value.reason)) return json({ error: 'invalid_report' }, 422, cors);
      const target = await env.DB.prepare('SELECT user_id FROM global_messages WHERE id = ?').bind(Number(reportMatch[1])).first();
      if (!target || target.user_id === user.id) return json({ error: 'invalid_report' }, 422, cors);
      const reports = await env.DB.prepare('SELECT COUNT(*) AS count FROM global_reports WHERE reporter_id = ? AND created_at > ?').bind(user.id, now - 60 * 60 * 1000).first();
      if (reports.count >= 10) return json({ error: 'rate_limited' }, 429, cors);
      await env.DB.prepare('INSERT OR IGNORE INTO global_reports (reporter_id, message_id, reason, created_at) VALUES (?, ?, ?, ?)').bind(user.id, Number(reportMatch[1]), value.reason, now).run();
      return json({ ok: true }, 201, cors);
    }
    const blockMatch = path.match(/^\/api\/global\/messages\/(\d+)\/block$/);
    if (blockMatch && method === 'POST') {
      const message = await env.DB.prepare('SELECT user_id FROM global_messages WHERE id = ?').bind(Number(blockMatch[1])).first();
      if (!message || message.user_id === user.id) return json({ error: 'invalid_user' }, 422, cors);
      await env.DB.prepare('INSERT OR IGNORE INTO global_blocks (user_id, blocked_user_id, created_at) VALUES (?, ?, ?)').bind(user.id, message.user_id, now).run();
      return json({ ok: true }, 201, cors);
    }
    const deleteMatch = path.match(/^\/api\/global\/messages\/(\d+)$/);
    if (deleteMatch && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM global_messages WHERE id = ? AND user_id = ?').bind(Number(deleteMatch[1]), user.id).run();
      return json({ ok: true }, 200, cors);
    }
    return json({ error: 'not_found' }, 404, cors);
  } catch {
    return json({ error: 'unavailable' }, 503, cors);
  }
}

async function readBoundedJson(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('empty');
  const chunks = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new RangeError('large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export default {
  async scheduled(_controller, env) {
    if (!env.DB) return;
    const now = Date.now();
    await env.DB.prepare('DELETE FROM inbox_messages WHERE expires_at <= ?').bind(now).run();
    await env.DB.prepare('DELETE FROM global_messages WHERE created_at <= ?').bind(now - GLOBAL_MESSAGE_TTL_MS).run();
    await env.DB.prepare('DELETE FROM global_sessions WHERE expires_at <= ?').bind(now).run();
    await env.DB.prepare('DELETE FROM global_reports WHERE created_at <= ?').bind(now - 30 * 24 * 60 * 60 * 1000).run();
    await env.DB.prepare('DELETE FROM global_auth_attempts WHERE created_at <= ?').bind(now - 60 * 60 * 1000).run();
  },
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin, env.ALLOWED_ORIGINS);
    if (origin && !cors) return new Response(null, { status: 403 });
    if (!cors && origin) return new Response(null, { status: 403 });
    if (request.method === 'OPTIONS') return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
    if (!cors) return json({ error: 'origin_not_allowed' }, 403, {});

    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/global/')) return handleGlobal(request, env, cors, url);
    const match = url.pathname.match(/^\/api\/inboxes\/([a-f0-9]{64})\/messages$/);
    if (!match) return json({ error: 'not_found' }, 404, cors);
    if (!env.DB) return json({ error: 'unavailable' }, 503, cors);
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'method_not_allowed' }, 405, cors);

    const mailboxId = match[1];
    const now = Date.now();
    try {
      await env.DB.prepare('DELETE FROM inbox_messages WHERE mailbox_id = ? AND expires_at <= ?').bind(mailboxId, now).run();

      if (request.method === 'GET') {
        const result = await env.DB.prepare('SELECT id, iv, ciphertext, created_at AS createdAt FROM inbox_messages WHERE mailbox_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT ?').bind(mailboxId, now, MAX_ACTIVE_MESSAGES).all();
        const messages = (result.results || []).reverse();
        return json({ messages }, 200, cors);
      }

      let value;
      try { value = await readBoundedJson(request); }
      catch (error) { return json({ error: error instanceof RangeError ? 'too_large' : 'invalid_json' }, error instanceof RangeError ? 413 : 400, cors); }
      if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !MESSAGE_ID_RE.test(value.id) || typeof value.iv !== 'string' || !IV_RE.test(value.iv) || typeof value.ciphertext !== 'string' || !CIPHERTEXT_RE.test(value.ciphertext) || value.ciphertext.length > 8192) {
        return json({ error: 'invalid_envelope' }, 422, cors);
      }

      const duplicate = await env.DB.prepare('SELECT id FROM inbox_messages WHERE mailbox_id = ? AND id = ?').bind(mailboxId, value.id).first();
      if (duplicate) return json({ accepted: true, duplicate: true }, 200, cors);

      const [active, recent] = await Promise.all([
        env.DB.prepare('SELECT COUNT(*) AS count FROM inbox_messages WHERE mailbox_id = ? AND expires_at > ?').bind(mailboxId, now).first(),
        env.DB.prepare('SELECT COUNT(*) AS count FROM inbox_messages WHERE mailbox_id = ? AND created_at > ?').bind(mailboxId, now - 60 * 60 * 1000).first(),
      ]);
      if (active.count >= MAX_ACTIVE_MESSAGES || recent.count >= MAX_MESSAGES_PER_HOUR) return json({ error: 'mailbox_limit' }, 429, cors);

      await env.DB.prepare('INSERT INTO inbox_messages (mailbox_id, id, iv, ciphertext, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').bind(mailboxId, value.id, value.iv, value.ciphertext, now, now + MESSAGE_TTL_MS).run();
      return json({ accepted: true }, 201, cors);
    } catch {
      return json({ error: 'unavailable' }, 503, cors);
    }
  },
};

export const limits = { MAX_BODY_BYTES, MAX_ACTIVE_MESSAGES, MAX_MESSAGES_PER_HOUR, MESSAGE_TTL_MS };
export const globalValidation = { ageIsAdult, validNickname, validPassword };
