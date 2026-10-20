export const MAX_ROOM_PARTICIPANTS = 4;
export const MAX_GUESTS = MAX_ROOM_PARTICIPANTS - 1;
export const MAX_MESSAGE_LENGTH = 2000;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_EXPIRY_MS = 24 * 60 * 60 * 1000;

export function canAcceptGuest(activeGuests, pendingGuests) {
  return Number.isInteger(activeGuests) && Number.isInteger(pendingGuests)
    && activeGuests >= 0 && pendingGuests >= 0
    && activeGuests + pendingGuests < MAX_GUESTS;
}

export function isValidTextMessage(data) {
  return Boolean(data && typeof data === 'object'
    && data.type === 'message'
    && typeof data.id === 'string' && data.id.length > 0 && data.id.length <= 80
    && typeof data.text === 'string' && data.text.trim().length > 0 && data.text.length <= MAX_MESSAGE_LENGTH);
}

export function isValidFileMessage(data) {
  return Boolean(data && typeof data === 'object'
    && data.type === 'file'
    && typeof data.id === 'string' && data.id.length > 0 && data.id.length <= 80
    && typeof data.fileName === 'string' && data.fileName.length > 0 && data.fileName.length <= 120
    && Number.isSafeInteger(data.size) && data.size >= 0 && data.size <= MAX_FILE_BYTES
    && data.data instanceof ArrayBuffer);
}

export function normalizeExpiry(value, now = Date.now()) {
  if (value === undefined || value === null || value === 0) return 0;
  if (!Number.isSafeInteger(value) || value <= now || value > now + MAX_EXPIRY_MS + 60_000) return null;
  return value;
}

export function createEventLimiter(limits) {
  const windows = new Map();
  const allow = (peerId, type, now = Date.now()) => {
    const rule = limits[type];
    if (!rule) return true;
    const key = `${peerId}:${type}`;
    const recent = (windows.get(key) || []).filter((time) => now - time < rule.windowMs);
    if (recent.length >= rule.limit) {
      windows.set(key, recent);
      return false;
    }
    recent.push(now);
    windows.set(key, recent);
    return true;
  };
  allow.clearPeer = (peerId) => {
    for (const key of windows.keys()) if (key.startsWith(`${peerId}:`)) windows.delete(key);
  };
  return allow;
}
