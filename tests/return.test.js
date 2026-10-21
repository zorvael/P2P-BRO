import test from 'node:test';
import assert from 'node:assert/strict';
import { findResumablePeer, isRoomReturnValid, ROOM_RETURN_WINDOW_MS } from '../src/return.js';

test('room return window is five minutes and expires at its deadline', () => {
  const now = 1_000_000;
  const record = { roomId: 'room-id', token: 'opaque-token', expiresAt: now + ROOM_RETURN_WINDOW_MS };
  assert.equal(ROOM_RETURN_WINDOW_MS, 300_000);
  assert.equal(isRoomReturnValid(record, now), true);
  assert.equal(isRoomReturnValid(record, record.expiresAt), false);
});

test('invalid or incomplete return records are rejected', () => {
  assert.equal(isRoomReturnValid(null), false);
  assert.equal(isRoomReturnValid({ roomId: 'room-id', token: '', expiresAt: Date.now() + 1000 }), false);
  assert.equal(isRoomReturnValid({ roomId: '', token: 'token', expiresAt: Date.now() + 1000 }), false);
});

test('a valid return token identifies its prior peer while expired tokens do not', () => {
  const tokens = new Map([['peer-old', 'guest-token'], ['peer-expired', 'stale-token']]);
  const expiries = new Map([['peer-old', 5000], ['peer-expired', 999]]);
  assert.equal(findResumablePeer(tokens, expiries, 'guest-token', 1000), 'peer-old');
  assert.equal(findResumablePeer(tokens, expiries, 'stale-token', 1000), null);
  assert.equal(findResumablePeer(tokens, expiries, 'unknown', 1000), null);
});
