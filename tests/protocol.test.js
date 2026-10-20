import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('chat client bounds and escapes untrusted message content', () => {
  assert.match(source, /data\.text\.length > 2000/);
  assert.match(source, /replace\(\/\[&<>"'\]/);
  assert.match(source, /maxlength="2000"/);
});

test('invite links carry a room ID and guests request room access', () => {
  assert.match(source, /new URLSearchParams\(\{ room: state\.roomId \}\)/);
  assert.match(source, /type: 'join-request', name: state\.name/);
  assert.match(source, /function extractRoomId/);
});

test('guest messages are relayed by the host and client cleanup closes peers', () => {
  assert.match(source, /if \(state\.isHost\) state\.connections\.forEach/);
  assert.match(source, /state\.peer\.destroy\(\)/);
});

test('guests must request access and hosts approve or reject before chat is enabled', () => {
  assert.match(source, /type: 'join-request'/);
  assert.match(source, /type: 'join-approved'/);
  assert.match(source, /type: 'join-denied'/);
  assert.match(source, /function approveGuest/);
  assert.match(source, /function rejectGuest/);
  assert.match(source, /if \(!entry\.connected\) return/);
});

test('typing status is announced and clears automatically after typing stops', () => {
  assert.match(source, /id="typing-indicator" aria-live="polite"/);
  assert.match(source, /function broadcastTyping\(active\)/);
  assert.match(source, /setTimeout\(\(\) => broadcastTyping\(false\), 1100\)/);
  assert.match(source, /type: 'typing'/);
});

test('emoji reactions are allow-listed, synchronized, and attached to message IDs', () => {
  assert.match(source, /const REACTIONS = \['❤️', '😂', '👍', '🎉', '😮'\]/);
  assert.match(source, /function toggleReaction\(messageId, emoji\)/);
  assert.match(source, /function applyReaction\(messageId, emoji, actorId/);
  assert.match(source, /!REACTIONS\.includes\(data\.emoji\)/);
  assert.match(source, /aria-pressed="\$\{selected\}"/);
});
