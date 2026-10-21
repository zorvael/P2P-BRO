import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canAcceptGuest, createEventLimiter, isValidFileMessage, isValidTextMessage, normalizeExpiry, MAX_FILE_BYTES, MAX_MESSAGE_LENGTH } from '../src/protocol.js';
import { createRecoveryRegistry, isPeerInRoster, retryDelay, summarizePeerStats } from '../src/network.js';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
const networkSource = await readFile(new URL('../src/network.js', import.meta.url), 'utf8');

test('chat client bounds and escapes untrusted message content', () => {
  assert.match(source, /isValidTextMessage\(data\)/);
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
  assert.match(source, /isValidFileMessage\(data\)/);
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

test('rooms admit at most four participants including the host', () => {
  assert.equal(canAcceptGuest(0, 0), true);
  assert.equal(canAcceptGuest(1, 1), true);
  assert.equal(canAcceptGuest(2, 1), false);
  assert.equal(canAcceptGuest(3, 0), false);
  assert.equal(canAcceptGuest(-1, 0), false);
});

test('incoming text and file payloads have strict bounds', () => {
  assert.equal(isValidTextMessage({ type: 'message', id: 'a', text: 'hello' }), true);
  assert.equal(isValidTextMessage({ type: 'message', id: 'a', text: ' '.repeat(2) }), false);
  assert.equal(isValidTextMessage({ type: 'message', id: 'a', text: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) }), false);
  assert.equal(isValidFileMessage({ type: 'file', id: 'f', fileName: 'x.txt', size: 1, data: new ArrayBuffer(1) }), true);
  assert.equal(isValidFileMessage({ type: 'file', id: 'f', fileName: 'x.txt', size: MAX_FILE_BYTES + 1, data: new ArrayBuffer(1) }), false);
});

test('event limits use independent per-peer rolling windows', () => {
  const allow = createEventLimiter({ message: { windowMs: 1000, limit: 2 }, file: { windowMs: 5000, limit: 1 } });
  assert.equal(allow('peer-a', 'message', 100), true);
  assert.equal(allow('peer-a', 'message', 200), true);
  assert.equal(allow('peer-a', 'message', 300), false);
  assert.equal(allow('peer-b', 'message', 300), true);
  assert.equal(allow('peer-a', 'file', 300), true);
  assert.equal(allow('peer-a', 'file', 400), false);
  allow.clearPeer('peer-a');
  assert.equal(allow('peer-a', 'file', 400), true);
});

test('expiry timestamps reject stale or excessively distant values', () => {
  assert.equal(normalizeExpiry(0, 1000), 0);
  assert.equal(normalizeExpiry(2000, 1000), 2000);
  assert.equal(normalizeExpiry(1000, 1000), null);
  assert.equal(normalizeExpiry(1000 + 24 * 60 * 60 * 1000 + 60_001, 1000), null);
});

test('connection and voice cleanup fixes stay wired into the client', () => {
  assert.match(source, /state\.pending\.set\(conn\.peer, entry\)/);
  assert.match(source, /request\.connected = true/);
  assert.match(source, /button\.disabled = !state\.isHost && connectedCount\(\) === 0/);
  assert.match(source, /function retryJoinRoom\(\)/);
  assert.match(source, /Delivered to/);
});

test('phone layout stacks the header and keeps the composer inside the viewport', () => {
  assert.match(styles, /@media\(max-width:700px\)/);
  assert.match(styles, /grid-template-areas:"brand actions" "room room"/);
  assert.match(styles, /height:100dvh/);
  assert.match(styles, /\.conversation\{flex:1;min-height:0/);
  assert.match(styles, /\.messages\{position:relative;flex:1;min-height:0/);
});

test('recovery retries back off exponentially, cap at four attempts, and isolate participants', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map((attempt) => retryDelay(attempt)), [1000, 2000, 4000, 8000, 8000]);
  const recovery = createRecoveryRegistry(4);
  assert.equal(recovery.begin('peer-a'), true);
  assert.equal(recovery.begin('peer-a'), false, 'one participant cannot start duplicate recovery at once');
  assert.equal(recovery.begin('peer-b'), true, 'another participant recovers independently');
  recovery.complete('peer-b');
  assert.deepEqual(recovery.fail('peer-a'), { attempt: 1, delayMs: 1000 });
  for (let attempt = 2; attempt <= 4; attempt += 1) {
    recovery.begin('peer-a');
    assert.equal(recovery.fail('peer-a').attempt, attempt);
  }
  recovery.begin('peer-a');
  assert.deepEqual(recovery.fail('peer-a'), { attempt: 5, delayMs: null });
  recovery.complete('peer-a');
  assert.equal(recovery.attempts('peer-a'), 0);
});

test('repeated recovery failures stop after the cap and a successful reconnect resets attempts', () => {
  const recovery = createRecoveryRegistry(4);
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    assert.equal(recovery.begin('guest-1'), true);
    assert.equal(recovery.fail('guest-1').attempt, attempt);
  }
  assert.equal(recovery.begin('guest-1'), true);
  assert.deepEqual(recovery.fail('guest-1'), { attempt: 5, delayMs: null });
  recovery.complete('guest-1');
  assert.equal(recovery.attempts('guest-1'), 0);
});

test('connection recovery avoids duplicate peer connections and duplicate chat messages', () => {
  assert.match(source, /if \(existing && existing\.conn !== conn && !existing\.recovering\)/);
  assert.match(source, /state\.messages\.some\(\(message\) => message\.id === data\.id\)/);
  assert.match(source, /recovery\?\.timer && !recovery\.connecting && entry\.connected/);
});

test('connection stats use only selected path types and aggregate available media metrics', () => {
  const report = new Map([
    ['transport-1', { id: 'transport-1', type: 'transport', selectedCandidatePairId: 'pair-1' }],
    ['pair-1', { id: 'pair-1', type: 'candidate-pair', localCandidateId: 'local-1', remoteCandidateId: 'remote-1', currentRoundTripTime: 0.042, state: 'succeeded' }],
    ['local-1', { id: 'local-1', type: 'local-candidate', candidateType: 'host', address: '192.168.1.5', usernameFragment: 'secret-fragment' }],
    ['remote-1', { id: 'remote-1', type: 'remote-candidate', candidateType: 'srflx', address: '203.0.113.5' }],
    ['audio-1', { id: 'audio-1', type: 'inbound-rtp', kind: 'audio', packetsReceived: 90, packetsLost: 10, jitter: 0.018 }],
  ]);
  const summary = summarizePeerStats(report);
  assert.equal(summary.path, 'direct');
  assert.equal(summary.candidateTypes, 'host / srflx');
  assert.equal(summary.rttMs, 42);
  assert.equal(summary.packetLossPercent, 10);
  assert.equal(summary.jitterMs, 18);
  assert.equal(JSON.stringify(summary).includes('192.168.1.5'), false);
  assert.equal(JSON.stringify(summary).includes('secret-fragment'), false);
});

test('TURN path is reported only when a selected candidate pair contains a relay', () => {
  const relayStats = new Map([
    ['t', { id: 't', type: 'transport', selectedCandidatePairId: 'p' }],
    ['p', { id: 'p', type: 'candidate-pair', localCandidateId: 'l', remoteCandidateId: 'r', state: 'succeeded' }],
    ['l', { id: 'l', type: 'local-candidate', candidateType: 'relay', address: '10.0.0.2' }],
    ['r', { id: 'r', type: 'remote-candidate', candidateType: 'srflx', address: '203.0.113.8' }],
  ]);
  assert.equal(summarizePeerStats(relayStats).path, 'relayed');
  assert.equal(summarizePeerStats(new Map()).path, 'unknown');
  assert.equal(summarizePeerStats(new Map()).rttMs, null);
});

test('departed peers are removed from future voice recovery eligibility', () => {
  const roster = [{ id: 'peer-a' }, { id: 'peer-b' }];
  assert.equal(isPeerInRoster('peer-a', roster), true);
  assert.equal(isPeerInRoster('peer-a', roster.filter((person) => person.id !== 'peer-a')), false);
  assert.match(source, /if \(!isPeerInRoster\(id, state\.voiceRoster\)\)/);
});

test('dashboard recovery is per participant and never renders network addresses', () => {
  assert.match(source, /peerConnection\.getStats\(\)/);
  assert.match(networkSource, /selectedCandidatePairId/);
  assert.match(source, /Relayed via TURN/);
  assert.match(source, /Direct \(stats confirmed\)/);
  assert.match(source, /private addresses and ICE credentials are hidden/);
  assert.match(source, /scheduleVoiceRecovery\(peerId/);
  assert.match(source, /recovery: true/);
  assert.match(source, /state\.calls\.forEach\(\(call, id\) => \{ if \(!peers\.has\(id\)\)/);
  assert.match(source, /call\.close\(\);\s*state\.pendingVoiceCalls\.delete\(id\)/);
});

test('single-person notes and an opt-in offline inbox are available from the landing and chat views', () => {
  assert.match(source, /id="open-notes"/);
  assert.match(source, /id="open-inbox"/);
  assert.match(source, /id="space-btn"/);
  assert.match(source, /near-personal-notes/);
  assert.match(source, /localStorage\.setItem\('near-personal-notes'/);
  assert.match(source, /encryptInboxMessage\(mailbox/);
  assert.match(source, /INBOX_API_URL/);
  assert.match(networkSource, /selectedCandidatePairId/);
});
