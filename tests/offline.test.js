import test from 'node:test';
import assert from 'node:assert/strict';
import { createInboxClient, createMailbox, decryptInboxMessage, encryptInboxMessage, makeInboxLink, readInboxLink } from '../src/offline.js';
import inboxWorker from '../inbox-worker/src/index.js';

const origin = 'https://zorvael.github.io';
const mailboxPath = (id) => `https://near-inbox.example/api/inboxes/${id}/messages`;

test('offline inbox links keep the decryption key in the URL fragment', () => {
  const mailbox = createMailbox();
  const link = makeInboxLink(mailbox, `${origin}/P2P-BRO/`);
  const url = new URL(link);
  assert.equal(url.searchParams.get('inbox'), mailbox.id);
  assert.equal(url.search.includes(mailbox.key), false);
  assert.deepEqual(readInboxLink(link), mailbox);
  assert.equal(readInboxLink(`${origin}/?inbox=not-a-secret`), null);
});

test('offline messages encrypt and decrypt in the browser, and reject tampering', async () => {
  const mailbox = createMailbox();
  const envelope = await encryptInboxMessage(mailbox, { sender: ' Alex ', text: 'hello after your call' });
  const serialized = JSON.stringify(envelope);
  assert.equal(serialized.includes('hello after your call'), false);
  const opened = await decryptInboxMessage(mailbox, { ...envelope, createdAt: 1234 });
  assert.equal(opened.text, 'hello after your call');
  assert.equal(opened.sender, 'Alex');
  assert.equal(opened.receivedAt, 1234);
  const altered = { ...envelope, ciphertext: `${envelope.ciphertext[0] === 'A' ? 'B' : 'A'}${envelope.ciphertext.slice(1)}` };
  assert.equal(await decryptInboxMessage(mailbox, altered), null);
});

test('inbox client sends only encrypted envelope content and never puts its key in the API URL', async () => {
  const mailbox = createMailbox();
  let call;
  const client = createInboxClient('https://near-inbox.example/', async (url, options) => {
    call = { url, options };
    return Response.json({ accepted: true }, { status: 201 });
  });
  const envelope = await encryptInboxMessage(mailbox, { sender: 'Sam', text: 'secret note body' });
  await client.send(mailbox, envelope);
  assert.equal(call.url, mailboxPath(mailbox.id));
  assert.equal(call.url.includes(mailbox.key), false);
  assert.equal(call.options.body.includes('secret note body'), false);
});

function makeD1() {
  const rows = [];
  return {
    rows,
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this; },
        async run() {
          if (sql.startsWith('DELETE')) {
            const hasMailbox = sql.includes('mailbox_id = ?');
            const [mailbox, now] = hasMailbox ? this.args : [null, this.args[0]];
            for (let i = rows.length - 1; i >= 0; i -= 1) if ((!hasMailbox || rows[i].mailbox_id === mailbox) && rows[i].expires_at <= now) rows.splice(i, 1);
          } else if (sql.startsWith('INSERT')) {
            const [mailbox_id, id, iv, ciphertext, created_at, expires_at] = this.args;
            rows.push({ mailbox_id, id, iv, ciphertext, created_at, expires_at });
          }
          return { success: true };
        },
        async first() {
          if (sql.includes('AND id = ?')) return rows.find((row) => row.mailbox_id === this.args[0] && row.id === this.args[1]) || null;
          const [mailbox, bound] = this.args;
          const matching = rows.filter((row) => row.mailbox_id === mailbox && (sql.includes('expires_at > ?') ? row.expires_at > bound : row.created_at > bound));
          return { count: matching.length };
        },
        async all() {
          const [mailbox, now, limit] = this.args;
          return { results: rows.filter((row) => row.mailbox_id === mailbox && row.expires_at > now).sort((a, b) => b.created_at - a.created_at).slice(0, limit).map((row) => ({ id: row.id, iv: row.iv, ciphertext: row.ciphertext, createdAt: row.created_at })) };
        },
      };
    },
  };
}

test('inbox Worker accepts encrypted envelopes, deduplicates retries, and returns ciphertext only', async () => {
  const db = makeD1();
  const env = { DB: db, ALLOWED_ORIGINS: origin };
  const mailbox = createMailbox();
  const envelope = await encryptInboxMessage(mailbox, { sender: 'Sam', text: 'not for the server' });
  const request = () => new Request(mailboxPath(mailbox.id), { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(envelope) });
  const first = await inboxWorker.fetch(request(), env);
  assert.equal(first.status, 201);
  const retry = await inboxWorker.fetch(request(), env);
  assert.equal(retry.status, 200);
  assert.equal(db.rows.length, 1);
  assert.equal(JSON.stringify(db.rows).includes('not for the server'), false);
  const listed = await inboxWorker.fetch(new Request(mailboxPath(mailbox.id), { headers: { Origin: origin } }), env);
  assert.equal(listed.status, 200);
  const result = await listed.json();
  assert.equal(result.messages.length, 1);
  assert.equal(await decryptInboxMessage(mailbox, result.messages[0]).then((item) => item.text), 'not for the server');
});

test('inbox Worker rejects unapproved origins and oversized payloads', async () => {
  const env = { DB: makeD1(), ALLOWED_ORIGINS: origin };
  const mailbox = createMailbox();
  const blocked = await inboxWorker.fetch(new Request(mailboxPath(mailbox.id), { headers: { Origin: 'https://other.example' } }), env);
  assert.equal(blocked.status, 403);
  const oversized = await inboxWorker.fetch(new Request(mailboxPath(mailbox.id), { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: crypto.randomUUID(), iv: 'A'.repeat(16), ciphertext: 'A'.repeat(13_000) }) }), env);
  assert.equal(oversized.status, 413);
});

test('scheduled Worker cleanup physically deletes messages after their expiry', async () => {
  const db = makeD1();
  db.rows.push({ mailbox_id: 'a'.repeat(64), id: crypto.randomUUID(), expires_at: Date.now() - 1 });
  await inboxWorker.scheduled({}, { DB: db });
  assert.equal(db.rows.length, 0);
});
