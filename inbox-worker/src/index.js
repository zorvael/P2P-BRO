const ID_RE = /^[a-f0-9]{64}$/;
const MESSAGE_ID_RE = /^[0-9a-f-]{36}$/i;
const IV_RE = /^[A-Za-z0-9_-]{16}$/;
const CIPHERTEXT_RE = /^[A-Za-z0-9_-]+$/;
const MAX_BODY_BYTES = 12_000;
const MAX_ACTIVE_MESSAGES = 100;
const MAX_MESSAGES_PER_HOUR = 20;
const MESSAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function corsHeaders(origin, allowedOrigins) {
  const allowed = String(allowedOrigins || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(value, status, cors) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...cors } });
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
    await env.DB.prepare('DELETE FROM inbox_messages WHERE expires_at <= ?').bind(Date.now()).run();
  },
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin, env.ALLOWED_ORIGINS);
    if (origin && !cors) return new Response(null, { status: 403 });
    if (!cors && origin) return new Response(null, { status: 403 });
    if (request.method === 'OPTIONS') return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
    if (!cors) return json({ error: 'origin_not_allowed' }, 403, {});

    const url = new URL(request.url);
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
