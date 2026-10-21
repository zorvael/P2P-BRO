export const ROOM_RETURN_WINDOW_MS = 5 * 60 * 1000;

export function findResumablePeer(resumeTokens, expiries, token, now = Date.now()) {
  if (typeof token !== 'string' || !token) return null;
  for (const [peerId, knownToken] of resumeTokens) {
    if (knownToken === token && (expiries.get(peerId) || 0) > now) return peerId;
  }
  return null;
}

export function isRoomReturnValid(record, now = Date.now()) {
  return Boolean(record && typeof record.roomId === 'string' && record.roomId.length > 0 && typeof record.token === 'string' && record.token.length > 0 && Number.isFinite(record.expiresAt) && record.expiresAt > now);
}
