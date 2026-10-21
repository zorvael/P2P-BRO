const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ID_PATTERN = /^[a-f0-9]{64}$/;

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(base64 + '='.repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function createMailbox(cryptoApi = globalThis.crypto) {
  if (!cryptoApi?.getRandomValues) throw new Error('Secure random numbers are unavailable in this browser.');
  const id = [...cryptoApi.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const key = toBase64Url(cryptoApi.getRandomValues(new Uint8Array(32)));
  return { id, key };
}

export function isValidMailbox(mailbox) {
  return Boolean(mailbox && ID_PATTERN.test(mailbox.id) && typeof mailbox.key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(mailbox.key));
}

export function makeInboxLink(mailbox, currentUrl = globalThis.location?.href) {
  if (!isValidMailbox(mailbox) || !currentUrl) throw new Error('A valid inbox and page URL are required.');
  const url = new URL(currentUrl);
  url.search = new URLSearchParams({ inbox: mailbox.id }).toString();
  url.hash = new URLSearchParams({ key: mailbox.key }).toString();
  return url.toString();
}

export function readInboxLink(currentUrl = globalThis.location?.href) {
  if (!currentUrl) return null;
  try {
    const url = new URL(currentUrl);
    const mailbox = { id: url.searchParams.get('inbox') || '', key: new URLSearchParams(url.hash.slice(1)).get('key') || '' };
    return isValidMailbox(mailbox) ? mailbox : null;
  } catch {
    return null;
  }
}

export async function encryptInboxMessage(mailbox, { sender, text }, cryptoApi = globalThis.crypto) {
  if (!isValidMailbox(mailbox)) throw new Error('This inbox link is invalid.');
  const safeSender = String(sender || 'Someone').trim().slice(0, 32) || 'Someone';
  const safeText = String(text || '').trim();
  if (!safeText || safeText.length > 2000) throw new Error('Write a message between 1 and 2,000 characters.');
  const key = await cryptoApi.subtle.importKey('raw', fromBase64Url(mailbox.key), 'AES-GCM', false, ['encrypt']);
  const iv = cryptoApi.getRandomValues(new Uint8Array(12));
  const cleartext = encoder.encode(JSON.stringify({ sender: safeSender, text: safeText, sentAt: Date.now() }));
  const ciphertext = await cryptoApi.subtle.encrypt({ name: 'AES-GCM', iv }, key, cleartext);
  return { id: cryptoApi.randomUUID(), iv: toBase64Url(iv), ciphertext: toBase64Url(new Uint8Array(ciphertext)) };
}

export async function decryptInboxMessage(mailbox, envelope, cryptoApi = globalThis.crypto) {
  try {
    if (!isValidMailbox(mailbox) || !envelope || !/^[A-Za-z0-9_-]{16}$/.test(envelope.iv) || typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length > 8192) return null;
    const key = await cryptoApi.subtle.importKey('raw', fromBase64Url(mailbox.key), 'AES-GCM', false, ['decrypt']);
    const plaintext = await cryptoApi.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(envelope.iv) }, key, fromBase64Url(envelope.ciphertext));
    const value = JSON.parse(decoder.decode(plaintext));
    if (typeof value.sender !== 'string' || typeof value.text !== 'string' || !value.text || value.text.length > 2000 || !Number.isFinite(value.sentAt)) return null;
    return { id: String(envelope.id || ''), sender: value.sender.slice(0, 32), text: value.text, sentAt: value.sentAt, receivedAt: Number(envelope.createdAt) || 0 };
  } catch {
    return null;
  }
}

export function createInboxClient(baseUrl, fetchImpl = globalThis.fetch) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('Offline inbox service is not configured yet.');
  const parsed = new URL(base);
  if (!['https:', 'http:'].includes(parsed.protocol) || (parsed.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(parsed.hostname))) throw new Error('Inbox service must use HTTPS.');

  async function request(mailbox, path = '', options = {}) {
    if (!isValidMailbox(mailbox)) throw new Error('This inbox link is invalid.');
    const response = await fetchImpl(`${base}/api/inboxes/${mailbox.id}/messages${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    if (!response.ok) {
      if (response.status === 429) throw new Error('This inbox is receiving messages too quickly. Try again later.');
      if (response.status === 413 || response.status === 422) throw new Error('That message could not be accepted. Check its length and try again.');
      if (response.status === 503) throw new Error('The inbox service is temporarily unavailable.');
      throw new Error('Could not reach this inbox. Check the connection and try again.');
    }
    return response.json();
  }

  return {
    list(mailbox) { return request(mailbox); },
    send(mailbox, envelope) { return request(mailbox, '', { method: 'POST', body: JSON.stringify(envelope) }); },
  };
}
