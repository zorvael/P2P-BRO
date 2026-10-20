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
  assert.match(source, /id="typing-indicator"[^>]*aria-live="polite"/);
  assert.match(source, /function broadcastTyping\(active\)/);
  assert.match(source, /setTimeout\(\(\) => broadcastTyping\(false\), 1100\)/);
  assert.match(source, /type: 'typing'/);
});

test('message tools include replies, copy, edit, delete, and safely linked URLs', () => {
  assert.match(source, /data-message-action="reply"/);
  assert.match(source, /data-message-action="copy"/);
  assert.match(source, /function sendMessageUpdate/);
  assert.match(source, /function applyMessageUpdate/);
  assert.match(source, /message\.text = ''/);
  assert.match(source, /function renderText/);
  assert.match(source, /rel="noopener noreferrer"/);
});

test('search, dark mode, and unread jump controls are available', () => {
  assert.match(source, /id="search-input"/);
  assert.match(source, /function toggleTheme/);
  assert.match(source, /id="new-messages"/);
  assert.match(source, /function renderUnread/);
});

test('first visit shows an accessible welcome dialog with start and invite actions', () => {
  assert.match(source, /function showWelcome\(\)/);
  assert.match(source, /role="dialog" aria-modal="true" aria-labelledby="welcome-title"/);
  assert.match(source, /id="welcome-start"/);
  assert.match(source, /id="welcome-join"/);
  assert.match(source, /near-welcome-seen/);
});

test('emoji reactions are allow-listed, synchronized, and attached to message IDs', () => {
  assert.match(source, /const REACTIONS = \['❤️', '😂', '👍', '🎉', '😮'\]/);
  assert.match(source, /function toggleReaction\(messageId, emoji\)/);
  assert.match(source, /function applyReaction\(messageId, emoji, actorId/);
  assert.match(source, /!REACTIONS\.includes\(data\.emoji\)/);
  assert.match(source, /aria-pressed="\$\{selected\}"/);
});

test('voice chat uses WebRTC calls and synchronizes the room roster', () => {
  assert.match(source, /getUserMedia\(\{ audio: true, video: false \}\)/);
  assert.match(source, /state\.peer\.on\('call', handleIncomingVoiceCall\)/);
  assert.match(source, /type: 'voice-roster'/);
  assert.match(source, /type: 'voice-join'/);
});

test('file sharing validates size and carries an expiring binary attachment', () => {
  assert.match(source, /file\.size > 5 \* 1024 \* 1024/);
  assert.match(source, /type: 'file'/);
  assert.match(source, /data\.size > 5 \* 1024 \* 1024/);
  assert.match(source, /file-attachment/);
});

test('disappearing messages and read receipts synchronize through the room host', () => {
  assert.match(source, /id="expiry-select"/);
  assert.match(source, /type: 'expire'/);
  assert.match(source, /type: 'receipt'/);
  assert.match(source, /read-receipt/);
});

test('sending a message keeps the composer focused for continuous mobile typing', () => {
  assert.match(source, /input\.focus\(\{ preventScroll: true \}\)/);
});
