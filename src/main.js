import Peer from 'peerjs';
import './style.css';

const app = document.querySelector('#app');
const state = { peer: null, connections: new Map(), pending: new Map(), name: '', roomId: '', isHost: false, messages: [], copied: false, typing: new Map(), localTyping: false, typingTimer: null, replyTo: null, editingId: null, unread: 0, search: '', expiryMs: 0, expiryTimers: new Map(), localStream: null, voiceActive: false, voiceRoster: [], calls: new Map() };
const REACTIONS = ['❤️', '😂', '👍', '🎉', '😮'];
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const initials = (name) => name.trim().split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase() || 'Y';

function peerOptions() {
  const options = { debug: 1 };
  if (import.meta.env.VITE_PEER_HOST) {
    options.host = import.meta.env.VITE_PEER_HOST;
    options.port = Number(import.meta.env.VITE_PEER_PORT || 443);
    options.path = import.meta.env.VITE_PEER_PATH || '/peerjs';
    options.secure = import.meta.env.VITE_PEER_SECURE !== 'false';
  }
  if (import.meta.env.VITE_ICE_SERVERS) {
    try { options.config = { iceServers: JSON.parse(import.meta.env.VITE_ICE_SERVERS) }; }
    catch { console.warn('VITE_ICE_SERVERS must be valid JSON; using the browser defaults.'); }
  }
  return options;
}

function renderLanding() {
  app.innerHTML = `
    <main class="landing">
      <nav class="topbar"><a class="brand" href="/"><span class="brand-mark">n</span> near<span class="brand-dot">.</span></a><span class="nav-note"><i class="status-dot"></i> End-to-end encrypted by WebRTC</span></nav>
      <section class="hero">
        <div class="eyebrow"><span class="sparkle">✳</span> A quieter kind of conversation</div>
        <h1>Some things are<br /><em>better shared</em> directly.</h1>
        <p class="hero-copy">A little private room for you and your people. No accounts, no archives — just a direct connection between browsers.</p>
        <div class="action-card">
          <div class="card-tabs"><button class="tab active" data-tab="create">Start a room <span>↗</span></button><button class="tab" data-tab="join">Join a room <span>→</span></button></div>
          <form id="room-form" class="room-form">
            <label for="display-name">YOUR NAME</label><input id="display-name" maxlength="32" autocomplete="nickname" placeholder="What should we call you?" required />
            <div id="room-code-wrap" class="hidden"><label for="room-code">ROOM INVITE</label><input id="room-code" maxlength="100" placeholder="Paste an invite link or room ID" /></div>
            <button class="primary-btn" type="submit"><span id="submit-label">Create a private room</span><span>↗</span></button>
          </form>
          <p class="card-foot"><span class="lock">⌑</span> Your messages stay between you and your guests.</p>
        </div>
        <div class="hero-aside"><span class="aside-line"></span><span>Made for the moments that matter</span><span class="aside-line"></span></div>
      </section>
      <footer class="landing-footer"><span>© 2026 near</span><span>Small rooms. Real conversations.</span><span>Built for the present moment&nbsp; ✳</span></footer>
    </main>`;
  let mode = 'create';
  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
    mode = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === tab));
    document.querySelector('#room-code-wrap').classList.toggle('hidden', mode === 'create');
    document.querySelector('#submit-label').textContent = mode === 'create' ? 'Create a private room' : 'Join the conversation';
  }));
  document.querySelector('#room-form').addEventListener('submit', (event) => {
    event.preventDefault();
    state.name = document.querySelector('#display-name').value.trim().slice(0, 32);
    if (state.name) mode === 'create' ? createRoom() : joinRoom(document.querySelector('#room-code').value.trim());
  });
  const roomFromUrl = new URLSearchParams(location.search).get('room');
  if (roomFromUrl) {
    document.querySelector('[data-tab="join"]').click();
    document.querySelector('#room-code').value = roomFromUrl;
  }
  showWelcome();
}

function showWelcome() {
  if (localStorage.getItem('near-welcome-seen') === 'yes') return;
  const layer = document.createElement('div');
  layer.className = 'welcome-layer';
  layer.innerHTML = `
    <section class="welcome-card" role="dialog" aria-modal="true" aria-labelledby="welcome-title" aria-describedby="welcome-copy">
      <button class="welcome-close" type="button" aria-label="Close welcome">×</button>
      <div class="welcome-orbit" aria-hidden="true"><span class="welcome-mark">n</span><i>✳</i><b>·</b></div>
      <span class="welcome-kicker">A PRIVATE SPACE, MADE SIMPLE</span>
      <h2 id="welcome-title">Welcome to <em>Near.</em></h2>
      <p id="welcome-copy">A little corner to catch up with your people—directly, quietly, and without making an account.</p>
      <div class="welcome-points"><span><i>✳</i> Invite-only rooms</span><span><i>↗</i> Direct browser chat</span><span><i>⌑</i> No message archive</span></div>
      <button class="welcome-primary" id="welcome-start" type="button">Get started <span>↗</span></button>
      <button class="welcome-secondary" id="welcome-join" type="button">I have an invite link <span>→</span></button>
      <small class="welcome-foot">Your conversation begins when you’re ready.</small>
    </section>`;
  document.body.append(layer);
  const close = (join = false) => {
    localStorage.setItem('near-welcome-seen', 'yes');
    layer.remove();
    if (join) document.querySelector('[data-tab="join"]').click();
    else document.querySelector('#display-name').focus();
  };
  layer.querySelector('.welcome-close').addEventListener('click', () => close());
  layer.querySelector('#welcome-start').addEventListener('click', () => close());
  layer.querySelector('#welcome-join').addEventListener('click', () => close(true));
  layer.addEventListener('click', (event) => { if (event.target === layer) close(); });
  layer.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
  layer.querySelector('#welcome-start').focus();
}

function renderRoom() {
  app.innerHTML = `
    <main class="chat-shell">
      <header class="chat-topbar"><a class="brand" href="/"><span class="brand-mark">n</span> near<span class="brand-dot">.</span></a><div class="room-label"><span class="room-symbol">✳</span><div><strong>your little corner</strong><small id="room-subtitle">Connecting to your room…</small></div></div><div class="top-actions"><button id="theme-btn" class="outline-btn" type="button" aria-label="Toggle dark mode" title="Toggle dark mode">◐</button><button id="voice-btn" class="outline-btn voice-btn" type="button" aria-label="Join voice chat">♫ <span>Voice</span></button><button id="invite-btn" class="outline-btn">Invite someone <span>↗</span></button><button id="leave-btn" class="icon-btn" title="Leave room" aria-label="Leave room">×</button></div></header>
      <div class="chat-layout"><aside class="people-panel"><div class="panel-heading"><span>IN THIS ROOM</span><span id="people-count" class="count-pill">1</span></div><div id="people-list"></div><div id="join-requests" class="join-requests"></div><div class="privacy-note"><span class="privacy-icon">⌑</span><div><strong>Just between you</strong><p>Messages travel directly between browsers. Nothing is stored on a server.</p></div></div></aside>
      <section class="conversation"><div id="connection-banner" class="connection-banner"><i class="status-dot"></i><span id="connection-text">Setting up your private connection</span><button id="search-toggle" class="search-toggle" type="button" aria-label="Search messages" title="Search messages">⌕</button></div><div id="message-search" class="message-search hidden"><input id="search-input" type="search" placeholder="Search this conversation…" aria-label="Search messages" /><button id="search-clear" type="button" aria-label="Clear search">×</button></div><div id="messages" class="messages"><div class="empty-state"><div class="empty-art"><span>✳</span><i></i><b>·</b></div><h2>A little space, just for you.</h2><p>Share an invite when you’re ready. The conversation begins when they arrive.</p></div></div><button id="new-messages" class="new-messages hidden" type="button">↓ New messages</button><div id="typing-indicator" class="typing-indicator" aria-live="polite"></div><div id="reply-preview" class="reply-preview hidden"></div><form id="message-form" class="composer"><button type="button" class="composer-symbol" title="This message is sent directly">✳</button><button id="file-btn" type="button" class="file-btn" title="Share a file" aria-label="Share a file" disabled>＋</button><input id="file-input" class="hidden" type="file" /><select id="expiry-select" class="expiry-select" aria-label="Message expiry" title="Disappearing messages"><option value="0">Keep</option><option value="60000">1 min</option><option value="3600000">1 hour</option><option value="86400000">1 day</option></select><input id="message-input" maxlength="2000" placeholder="Write something thoughtful…" autocomplete="off" disabled /><button id="send-btn" class="send-btn" type="submit" disabled aria-label="Send message">↑</button></form><div class="composer-foot"><span>Messages are not saved after you leave.</span><span><kbd>↵</kbd> to send</span></div><div id="audio-players" class="audio-players" aria-label="Voice chat audio"></div></section></div>
      <div id="toast" class="toast" role="status"></div>
    </main>`;
  document.querySelector('#invite-btn').addEventListener('click', shareInvite);
  document.querySelector('#leave-btn').addEventListener('click', leaveRoom);
  document.querySelector('#message-form').addEventListener('submit', sendMessage);
  document.querySelector('#voice-btn').addEventListener('click', toggleVoice);
  document.querySelector('#file-btn').addEventListener('click', () => document.querySelector('#file-input').click());
  document.querySelector('#file-input').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (file) await sendFile(file);
    event.target.value = '';
  });
  document.querySelector('#expiry-select').addEventListener('change', (event) => {
    state.expiryMs = Number(event.target.value) || 0;
    alertToast(state.expiryMs ? `New messages disappear after ${event.target.selectedOptions[0].text}.` : 'New messages will stay until you leave.');
  });
  document.querySelector('#theme-btn').addEventListener('click', toggleTheme);
  document.querySelector('#search-toggle').addEventListener('click', () => {
    const row = document.querySelector('#message-search');
    row.classList.toggle('hidden');
    if (!row.classList.contains('hidden')) document.querySelector('#search-input').focus();
    else setSearch('');
  });
  document.querySelector('#search-input').addEventListener('input', (event) => setSearch(event.target.value));
  document.querySelector('#search-clear').addEventListener('click', () => {
    document.querySelector('#search-input').value = '';
    setSearch('');
    document.querySelector('#search-input').focus();
  });
  document.querySelector('#new-messages').addEventListener('click', () => {
    const panel = document.querySelector('#messages');
    panel.scrollTop = panel.scrollHeight;
    state.unread = 0;
    renderUnread();
  });
  document.querySelector('#messages').addEventListener('scroll', () => {
    const panel = document.querySelector('#messages');
    if (panel.scrollHeight - panel.scrollTop - panel.clientHeight < 70 && state.unread) {
      state.unread = 0;
      renderUnread();
    }
  });
  document.querySelector('#messages').addEventListener('click', (event) => {
    const button = event.target.closest('[data-reaction]');
    if (button) toggleReaction(button.dataset.message, button.dataset.reaction);
    const action = event.target.closest('[data-message-action]');
    if (action) handleMessageAction(action.dataset.messageAction, action.dataset.message);
  });
  document.querySelector('#reply-preview').addEventListener('click', (event) => {
    if (event.target.closest('[data-cancel-reply]')) setReplyTo(null);
  });
  document.querySelector('#join-requests').addEventListener('click', (event) => {
    const button = event.target.closest('[data-join-action]');
    if (!button) return;
    if (button.dataset.joinAction === 'approve') approveGuest(button.dataset.peer);
    if (button.dataset.joinAction === 'reject') rejectGuest(button.dataset.peer);
  });
  document.querySelector('#message-input').addEventListener('input', (event) => {
    document.querySelector('#send-btn').disabled = !event.target.value.trim() || !connectedCount();
    broadcastTyping(Boolean(event.target.value.trim()));
    clearTimeout(state.typingTimer);
    if (event.target.value.trim()) state.typingTimer = setTimeout(() => broadcastTyping(false), 1100);
  });
  updatePeople();
  document.body.classList.toggle('dark', localStorage.getItem('near-theme') === 'dark');
}

function toggleTheme() {
  const enabled = !document.body.classList.contains('dark');
  document.body.classList.toggle('dark', enabled);
  localStorage.setItem('near-theme', enabled ? 'dark' : 'light');
}

function updateVoiceUI() {
  const button = document.querySelector('#voice-btn');
  if (!button) return;
  button.classList.toggle('active', state.voiceActive);
  button.innerHTML = state.voiceActive ? '♫ <span>Leave voice</span>' : '♫ <span>Voice</span>';
  button.setAttribute('aria-label', state.voiceActive ? 'Leave voice chat' : 'Join voice chat');
  button.title = state.voiceActive ? `In voice chat with ${state.voiceRoster.length} participant${state.voiceRoster.length === 1 ? '' : 's'}` : 'Join voice chat';
}

async function toggleVoice() {
  if (state.voiceActive) return stopVoice();
  if (!navigator.mediaDevices?.getUserMedia) return alertToast('Voice chat needs a browser with microphone support.');
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    state.voiceActive = true;
    updateVoiceUI();
    if (state.isHost) broadcastVoiceRoster();
    else sendToHost({ type: 'voice-join', name: state.name });
    alertToast('You joined voice chat. Your browser may ask for microphone access.');
  } catch (error) {
    state.localStream = null;
    alertToast(error?.name === 'NotAllowedError' ? 'Allow microphone access in your browser to join voice chat.' : 'Could not start the microphone. Check the device and try again.');
  }
}

function stopVoice() {
  state.voiceActive = false;
  state.calls.forEach((call) => call.close());
  state.calls.clear();
  document.querySelector('#audio-players')?.replaceChildren();
  state.localStream?.getTracks().forEach((track) => track.stop());
  state.localStream = null;
  if (state.isHost) broadcastVoiceRoster();
  else sendToHost({ type: 'voice-left', name: state.name });
  updateVoiceUI();
}

function broadcastVoiceRoster() {
  if (!state.isHost) return;
  const roster = [];
  if (state.voiceActive && state.peer?.id) roster.push({ id: state.peer.id, name: state.name });
  state.connections.forEach((entry, id) => { if (entry.connected && entry.voice) roster.push({ id, name: entry.name }); });
  state.voiceRoster = roster;
  relayToOthers(null, { type: 'voice-roster', roster });
  syncVoiceCalls();
  updateVoiceUI();
}

function syncVoiceCalls() {
  if (!state.voiceActive || !state.localStream || !state.peer) return;
  const peers = new Map(state.voiceRoster.filter((person) => person.id !== state.peer.id && state.peer.id.localeCompare(person.id) < 0).map((person) => [person.id, person.name]));
  state.calls.forEach((call, id) => { if (!peers.has(id)) { call.close(); state.calls.delete(id); removeAudio(id); } });
  peers.forEach((name, id) => {
    if (state.calls.has(id)) return;
    try {
      const call = state.peer.call(id, state.localStream, { metadata: { name: state.name } });
      if (call) registerVoiceCall(id, call, true);
    } catch { alertToast(`Could not connect voice with ${name}.`); }
  });
}

function handleIncomingVoiceCall(call) {
  if (!state.voiceActive || !state.localStream || !state.voiceRoster.some((person) => person.id === call.peer)) {
    call.close();
    return;
  }
  if (state.calls.has(call.peer)) { call.close(); return; }
  registerVoiceCall(call.peer, call, false);
  call.answer(state.localStream);
}

function registerVoiceCall(peerId, call, outgoing) {
  state.calls.set(peerId, call);
  call.on('stream', (stream) => attachAudio(peerId, stream));
  call.on('close', () => { state.calls.delete(peerId); removeAudio(peerId); });
  call.on('error', () => { state.calls.delete(peerId); removeAudio(peerId); alertToast('A voice connection was interrupted.'); });
  if (!outgoing) call.on('error', () => { state.calls.delete(peerId); removeAudio(peerId); });
}

function attachAudio(peerId, stream) {
  const container = document.querySelector('#audio-players');
  if (!container) return;
  let audio = container.querySelector(`[data-audio-peer="${CSS.escape(peerId)}"]`);
  if (!audio) {
    audio = document.createElement('audio');
    audio.autoplay = true;
    audio.playsInline = true;
    audio.dataset.audioPeer = peerId;
    container.append(audio);
  }
  audio.srcObject = stream;
  audio.play().catch(() => alertToast('Tap the page once to hear the voice chat.'));
}

function removeAudio(peerId) {
  const container = document.querySelector('#audio-players');
  container?.querySelector(`[data-audio-peer="${CSS.escape(peerId)}"]`)?.remove();
}

function sendToHost(payload) {
  const host = [...state.connections.values()].find((entry) => entry.connected);
  if (host) host.conn.send(payload);
}

async function sendFile(file) {
  if (!connectedCount()) return alertToast('Connect to someone before sharing a file.');
  if (file.size > 5 * 1024 * 1024) return alertToast('Files must be 5 MB or smaller.');
  const safeName = file.name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120) || 'shared-file';
  const buffer = await file.arrayBuffer();
  const id = makeId();
  const expiresAt = state.expiryMs ? Date.now() + state.expiryMs : 0;
  const payload = { type: 'file', id, authorId: state.peer.id, name: state.name, fileName: safeName, mime: file.type.slice(0, 120) || 'application/octet-stream', size: file.size, data: buffer, expiresAt };
    if (state.isHost) state.connections.forEach((entry) => { if (entry.connected) entry.conn.send(payload); });
  else sendToHost(payload);
  const message = makeFileMessage(payload, true);
  state.messages.push(message);
  scheduleMessageExpiry(message);
  renderMessages();
}

function makeFileMessage(data, mine) {
  const bytes = data.data instanceof ArrayBuffer ? data.data : data.data?.buffer;
  const blob = new Blob([bytes], { type: data.mime || 'application/octet-stream' });
  return { id: data.id, authorId: data.authorId, name: data.name, text: '', fileName: data.fileName, size: data.size, mime: data.mime, fileUrl: URL.createObjectURL(blob), time: Date.now(), mine, reactions: {}, expiresAt: Number(data.expiresAt) || 0 };
}

function sendReadReceipt(message) {
  if (!message || message.mine || !state.peer?.id || message.readBy?.[state.peer.id]) return;
  const payload = { type: 'receipt', messageId: message.id, actorId: state.peer.id, name: state.name };
  applyReadReceipt(payload.messageId, payload.actorId, payload.name);
  if (state.isHost) relayToOthers(null, payload);
  else sendToHost(payload);
}

function applyReadReceipt(messageId, actorId, name) {
  const message = state.messages.find((item) => item.id === messageId && item.mine);
  if (!message || !actorId) return;
  message.readBy ||= {};
  message.readBy[actorId] = name || 'Guest';
  renderMessages();
}

function scheduleMessageExpiry(message) {
  if (!message.expiresAt || message.expired) return;
  clearTimeout(state.expiryTimers.get(message.id));
  const timer = setTimeout(() => {
    if (message.mine) {
      const payload = { type: 'expire', messageId: message.id, actorId: state.peer?.id };
      if (state.isHost) relayToOthers(null, payload);
      else sendToHost(payload);
      applyMessageExpiry(message.id, message.authorId);
    } else applyMessageExpiry(message.id, message.authorId);
  }, Math.max(0, message.expiresAt - Date.now()));
  state.expiryTimers.set(message.id, timer);
}

function applyMessageExpiry(messageId, actorId) {
  const message = state.messages.find((item) => item.id === messageId);
  if (!message || message.authorId !== actorId || message.expired) return;
  message.expired = true;
  message.text = '';
  message.reactions = {};
  if (message.fileUrl) { URL.revokeObjectURL(message.fileUrl); message.fileUrl = ''; }
  clearTimeout(state.expiryTimers.get(messageId));
  state.expiryTimers.delete(messageId);
  renderMessages();
}

function setSearch(value) {
  state.search = String(value || '').slice(0, 120).toLocaleLowerCase();
  renderMessages();
}

function renderUnread() {
  const button = document.querySelector('#new-messages');
  if (!button) return;
  button.textContent = state.unread ? `↓ ${state.unread} new message${state.unread === 1 ? '' : 's'}` : '↓ New messages';
  button.classList.toggle('hidden', !state.unread);
}

function setReplyTo(message) {
  state.replyTo = message ? { id: message.id, name: message.name, text: message.text.slice(0, 2000) } : null;
  const preview = document.querySelector('#reply-preview');
  if (!preview) return;
  preview.innerHTML = state.replyTo ? `<span><strong>Replying to ${esc(state.replyTo.name)}</strong><small>${renderText(state.replyTo.text)}</small></span><button type="button" data-cancel-reply aria-label="Cancel reply">×</button>` : '';
  preview.classList.toggle('hidden', !state.replyTo);
  if (state.replyTo) document.querySelector('#message-input').focus();
}

function renderText(text) {
  const safe = esc(text);
  return safe.replace(/https?:\/\/[^\s<]+/gi, (url) => {
    const cleanUrl = url.replace(/[),.!?]+$/, '');
    return `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer">${cleanUrl}</a>${url.slice(cleanUrl.length)}`;
  }).replace(/\n/g, '<br>');
}

async function handleMessageAction(action, messageId) {
  const message = state.messages.find((item) => item.id === messageId);
  if (!message) return;
  if (action === 'reply') return setReplyTo(message);
  if (action === 'copy') {
    try { await navigator.clipboard.writeText(message.text); alertToast('Message copied.'); }
    catch { window.prompt('Copy this message:', message.text); }
    return;
  }
  if (action === 'edit' && message.mine) {
    const text = window.prompt('Edit your message:', message.text);
    if (text === null) return;
    const clean = text.trim().slice(0, 2000);
    if (!clean) return alertToast('A message can’t be empty.');
    sendMessageUpdate('edit', message, clean);
  }
  if (action === 'delete' && message.mine && window.confirm('Delete this message for everyone in the room?')) sendMessageUpdate('delete', message);
}

function sendMessageUpdate(type, message, text) {
  if (!state.peer?.id) return;
  applyMessageUpdate(type, message.id, state.peer.id, text);
  const payload = { type, messageId: message.id, actorId: state.peer.id, ...(text ? { text } : {}) };
  if (state.isHost) relayToOthers(null, payload);
  else {
    const host = [...state.connections.values()].find((entry) => entry.connected);
    if (host) host.conn.send(payload);
  }
}

function applyMessageUpdate(type, messageId, actorId, text) {
  const message = state.messages.find((item) => item.id === messageId);
  if (!message || message.authorId !== actorId) return;
  if (type === 'edit' && typeof text === 'string' && text.trim() && text.length <= 2000) {
    message.text = text.trim();
    message.edited = true;
  } else if (type === 'delete') {
    message.deleted = true;
    message.text = '';
    message.reactions = {};
    if (message.fileUrl) { URL.revokeObjectURL(message.fileUrl); message.fileUrl = ''; }
  }
  renderMessages();
}

function createRoom() {
  state.isHost = true;
  renderRoom();
  state.peer = new Peer(undefined, peerOptions());
  bindPeerEvents();
  state.peer.on('open', (id) => {
    state.roomId = id;
    document.querySelector('#room-subtitle').textContent = 'Your private room is ready';
    document.querySelector('#connection-text').textContent = 'Room is open · invite someone to begin';
    document.querySelector('#connection-banner').classList.add('ready');
    renderMessages();
  });
  state.peer.on('connection', (conn) => addConnection(conn));
}

function joinRoom(raw) {
  const roomId = extractRoomId(raw);
  if (!roomId || roomId.length > 100) return alertToast('That invite doesn’t look quite right.');
  state.isHost = false;
  state.roomId = roomId;
  renderRoom();
  state.peer = new Peer(undefined, peerOptions());
  bindPeerEvents();
  state.peer.on('open', () => {
    const conn = state.peer.connect(roomId, { reliable: true, metadata: { name: state.name } });
    addConnection(conn, true);
  });
}

function bindPeerEvents() {
  state.peer.on('call', handleIncomingVoiceCall);
  state.peer.on('error', (err) => {
    const messages = { 'peer-unavailable': 'We couldn’t find that room. Check the invite and try again.', 'network': 'The signaling service is unreachable. Check your connection and try again.', 'server-error': 'The signaling service had a moment. Please try again shortly.', 'browser-incompatible': 'This browser does not support WebRTC. Try a recent version of Chrome, Firefox, Safari, or Edge.' };
    alertToast(messages[err.type] || 'Something interrupted the connection. Please try again.');
    document.querySelector('#connection-text').textContent = messages[err.type] || 'Connection interrupted';
  });
  state.peer.on('disconnected', () => {
    document.querySelector('#connection-text').textContent = 'Reconnecting to the room service…';
    if (state.peer && !state.peer.destroyed) state.peer.reconnect();
  });
}

function addConnection(conn, outgoing = false) {
  const entry = { conn, name: outgoing ? 'Host' : 'Guest', connected: false };
  if (outgoing) state.connections.set(conn.peer, entry);
  else state.pending.set(conn.peer, { ...entry, requested: false });
  conn.on('open', () => {
    if (!outgoing) return;
    conn.send({ type: 'join-request', name: state.name });
    document.querySelector('#connection-text').textContent = 'Request sent · waiting for the host to approve';
    document.querySelector('#connection-banner').classList.add('ready');
    const emptyState = document.querySelector('#messages .empty-state');
    if (emptyState) {
      emptyState.querySelector('h2').textContent = 'Waiting for approval.';
      emptyState.querySelector('p').textContent = 'The host will let you into the room when they are ready.';
    }
  });
  conn.on('data', (data) => handleData(conn.peer, data));
  conn.on('close', () => {
    setTyping(entry.name, false);
    state.pending.delete(conn.peer);
    if (state.isHost && entry.voice) { entry.voice = false; broadcastVoiceRoster(); }
    state.connections.delete(conn.peer);
    renderJoinRequests(); updatePeople(); renderMessages();
    if (!connectedCount()) document.querySelector('#connection-text').textContent = state.isHost ? 'Room is open · invite someone to begin' : 'Your guest left the room';
  });
  conn.on('error', () => alertToast('A guest connection was interrupted.'));
}

function handleData(peerId, data) {
  if (!data || typeof data !== 'object') return;
  if (state.isHost && data.type === 'join-request') {
    const request = state.pending.get(peerId);
    if (!request) return;
    request.name = typeof data.name === 'string' ? data.name.trim().slice(0, 32) || 'Guest' : 'Guest';
    request.requested = true;
    renderJoinRequests();
    document.querySelector('#connection-text').textContent = 'Someone is asking to join your room';
    return;
  }
  const entry = state.connections.get(peerId);
  if (!entry) return;
  if (!state.isHost && data.type === 'join-approved') {
    entry.name = typeof data.name === 'string' ? data.name.trim().slice(0, 32) || 'Host' : 'Host';
    entry.connected = true;
    updatePeople();
    document.querySelector('#connection-text').textContent = 'Connected directly · you’re in the room';
    document.querySelector('#connection-banner').classList.add('ready');
    renderMessages();
    sendToHost({ type: 'voice-roster-request' });
    return;
  }
  if (!state.isHost && data.type === 'join-denied') {
    alertToast('The host didn’t approve your request.');
    entry.conn.close();
    return;
  }
  if (!entry.connected) return;
  if (state.isHost && data.type === 'voice-roster-request') { broadcastVoiceRoster(); return; }
  if (state.isHost && (data.type === 'voice-join' || data.type === 'voice-left')) {
    entry.voice = data.type === 'voice-join';
    broadcastVoiceRoster();
    return;
  }
  if (!state.isHost && data.type === 'voice-roster') {
    state.voiceRoster = Array.isArray(data.roster) ? data.roster.filter((person) => person && typeof person.id === 'string' && typeof person.name === 'string').slice(0, 20) : [];
    syncVoiceCalls(); updateVoiceUI(); return;
  }
  if (data.type === 'typing') {
    const name = state.isHost ? (entry.name || 'Someone') : (typeof data.name === 'string' ? data.name.trim().slice(0, 32) || entry.name : entry.name || 'Someone');
    setTyping(name, Boolean(data.active));
    if (state.isHost) relayToOthers(peerId, { type: 'typing', name, active: Boolean(data.active) });
    return;
  }
  if (data.type === 'message') {
    if (typeof data.text !== 'string' || data.text.length < 1 || data.text.length > 2000 || typeof data.id !== 'string' || data.id.length > 80) return;
    const text = data.text.trim();
    if (!text) return;
    const senderName = state.isHost ? (entry.name || 'Guest') : (typeof data.name === 'string' ? data.name.trim().slice(0, 32) || entry.name : entry.name || 'Guest');
    const authorId = state.isHost ? peerId : (typeof data.authorId === 'string' ? data.authorId.slice(0, 100) : peerId);
    const replyTo = data.replyTo && typeof data.replyTo.name === 'string' && typeof data.replyTo.text === 'string' ? { id: String(data.replyTo.id || '').slice(0, 80), name: data.replyTo.name.slice(0, 32), text: data.replyTo.text.slice(0, 200) } : null;
    const expiresAt = Number(data.expiresAt) || 0;
    if (expiresAt && expiresAt <= Date.now()) return;
    const message = { id: data.id, authorId, name: senderName, text, replyTo, time: Date.now(), mine: false, reactions: {}, expiresAt };
    state.messages.push(message);
    scheduleMessageExpiry(message);
    renderMessages({ incoming: true });
    sendReadReceipt(message);
    // Relay peer messages through the room host so guests can share one conversation.
    if (state.isHost) relayToOthers(peerId, { type: 'message', id: data.id, authorId, name: senderName, text, replyTo, expiresAt });
    return;
  }
  if (data.type === 'file') {
    if (typeof data.id !== 'string' || data.id.length > 80 || typeof data.fileName !== 'string' || data.fileName.length > 120 || !Number.isFinite(data.size) || data.size < 0 || data.size > 5 * 1024 * 1024 || !(data.data instanceof ArrayBuffer)) return;
    const authorId = state.isHost ? peerId : (typeof data.authorId === 'string' ? data.authorId.slice(0, 100) : peerId);
    const fileData = { ...data, authorId, name: state.isHost ? entry.name : (typeof data.name === 'string' ? data.name.slice(0, 32) : entry.name) };
    const expiresAt = Number(fileData.expiresAt) || 0;
    if (expiresAt && expiresAt <= Date.now()) return;
    const message = makeFileMessage(fileData, false);
    state.messages.push(message);
    scheduleMessageExpiry(message);
    renderMessages({ incoming: true }); sendReadReceipt(message);
    if (state.isHost) relayToOthers(peerId, fileData);
    return;
  }
  if (data.type === 'receipt') {
    if (typeof data.messageId !== 'string' || data.messageId.length > 80) return;
    const actorId = state.isHost ? peerId : (typeof data.actorId === 'string' ? data.actorId.slice(0, 100) : peerId);
    const name = state.isHost ? entry.name : (typeof data.name === 'string' ? data.name.slice(0, 32) : entry.name);
    applyReadReceipt(data.messageId, actorId, name);
    if (state.isHost) relayToOthers(peerId, { type: 'receipt', messageId: data.messageId, actorId, name });
    return;
  }
  if (data.type === 'expire') {
    if (typeof data.messageId !== 'string' || data.messageId.length > 80) return;
    const actorId = state.isHost ? peerId : (typeof data.actorId === 'string' ? data.actorId.slice(0, 100) : peerId);
    applyMessageExpiry(data.messageId, actorId);
    if (state.isHost) relayToOthers(peerId, { type: 'expire', messageId: data.messageId, actorId });
    return;
  }
  if (data.type === 'reaction') {
    if (typeof data.messageId !== 'string' || data.messageId.length > 80 || !REACTIONS.includes(data.emoji)) return;
    const actorId = state.isHost ? peerId : (typeof data.actorId === 'string' ? data.actorId.slice(0, 100) : peerId);
    const actorName = state.isHost ? entry.name : (typeof data.name === 'string' ? data.name.trim().slice(0, 32) || entry.name : entry.name);
    applyReaction(data.messageId, data.emoji, actorId, actorName, Boolean(data.active));
    if (state.isHost) relayToOthers(peerId, { type: 'reaction', messageId: data.messageId, emoji: data.emoji, actorId, name: actorName, active: Boolean(data.active) });
  }
  if (data.type === 'edit' || data.type === 'delete') {
    if (typeof data.messageId !== 'string' || data.messageId.length > 80) return;
    const actorId = state.isHost ? peerId : (typeof data.actorId === 'string' ? data.actorId.slice(0, 100) : peerId);
    if (data.type === 'edit' && (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 2000)) return;
    applyMessageUpdate(data.type, data.messageId, actorId, data.text);
    if (state.isHost) relayToOthers(peerId, { type: data.type, messageId: data.messageId, actorId, ...(data.type === 'edit' ? { text: data.text.trim() } : {}) });
  }
}

function relayToOthers(excludedPeerId, payload) {
  state.connections.forEach((other, id) => {
    if (id !== excludedPeerId && other.connected) other.conn.send(payload);
  });
}

function broadcastTyping(active) {
  if (active === state.localTyping) return;
  state.localTyping = active;
  const payload = { type: 'typing', active };
  if (state.isHost) relayToOthers(null, payload);
  else {
    const host = [...state.connections.values()].find((entry) => entry.connected);
    if (host) host.conn.send(payload);
  }
}

function setTyping(name, active) {
  if (!name) return;
  const current = state.typing.get(name);
  if (current) clearTimeout(current);
  if (active) state.typing.set(name, setTimeout(() => {
    state.typing.delete(name);
    renderTyping();
  }, 3000));
  else state.typing.delete(name);
  renderTyping();
}

function renderTyping() {
  const indicator = document.querySelector('#typing-indicator');
  if (!indicator) return;
  const names = [...state.typing.keys()];
  indicator.textContent = names.length ? `${names.slice(0, 2).join(' and ')}${names.length > 2 ? ` +${names.length - 2}` : ''} ${names.length === 1 ? 'is' : 'are'} typing…` : '';
  indicator.classList.toggle('visible', names.length > 0);
}

function renderJoinRequests() {
  const container = document.querySelector('#join-requests');
  if (!container) return;
  const requests = [...state.pending.entries()].filter(([, request]) => request.requested);
  if (!requests.length) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = `<div class="request-heading">JOIN REQUESTS <span>${requests.length}</span></div>${requests.map(([peerId, request]) => `<div class="join-request"><div class="request-copy"><strong>${esc(request.name)}</strong><small>wants to join</small></div><div class="request-actions"><button type="button" data-join-action="approve" data-peer="${esc(peerId)}">Allow</button><button type="button" data-join-action="reject" data-peer="${esc(peerId)}" aria-label="Reject ${esc(request.name)}">×</button></div></div>`).join('')}`;
}

function approveGuest(peerId) {
  const request = state.pending.get(peerId);
  if (!request || !request.requested || !request.conn.open) return;
  state.pending.delete(peerId);
  state.connections.set(peerId, { conn: request.conn, name: request.name, connected: true, voice: false });
  request.conn.send({ type: 'join-approved', name: state.name });
  renderJoinRequests();
  updatePeople();
  document.querySelector('#connection-text').textContent = `${connectedCount()} ${connectedCount() === 1 ? 'person is' : 'people are'} here · connected directly`;
  document.querySelector('#connection-banner').classList.add('ready');
  renderMessages();
}

function rejectGuest(peerId) {
  const request = state.pending.get(peerId);
  if (!request) return;
  state.pending.delete(peerId);
  request.conn.send({ type: 'join-denied' });
  renderJoinRequests();
  setTimeout(() => request.conn.close(), 250);
}

function sendMessage(event) {
  event.preventDefault();
  const input = document.querySelector('#message-input');
  const text = input.value.trim();
  if (!text || text.length > 2000 || !connectedCount()) return;
  broadcastTyping(false);
  clearTimeout(state.typingTimer);
  const replyTo = state.replyTo ? { ...state.replyTo, text: state.replyTo.text.slice(0, 200) } : null;
  const expiresAt = state.expiryMs ? Date.now() + state.expiryMs : 0;
  const message = { type: 'message', id: makeId(), authorId: state.peer.id, name: state.name, text, replyTo, expiresAt };
  if (state.isHost) state.connections.forEach((entry) => { if (entry.connected) entry.conn.send(message); });
  else {
    const host = [...state.connections.values()].find((entry) => entry.connected);
    if (!host) return;
    host.conn.send(message);
  }
  const savedMessage = { ...message, time: Date.now(), mine: true, reactions: {} };
  state.messages.push(savedMessage);
  scheduleMessageExpiry(savedMessage);
  setReplyTo(null);
  input.value = '';
  document.querySelector('#send-btn').disabled = true;
  renderMessages();
}

function updatePeople() {
  const guests = [...state.connections.values()].filter((entry) => entry.connected);
  const me = `<div class="person"><span class="avatar avatar-me">${esc(initials(state.name))}</span><span class="person-name">${esc(state.name)} <small>you</small></span><span class="person-state online"></span></div>`;
  document.querySelector('#people-list').innerHTML = me + guests.map((entry, i) => `<div class="person"><span class="avatar avatar-${i % 4}">${esc(initials(entry.name))}</span><span class="person-name">${esc(entry.name)}</span><span class="person-state online"></span></div>`).join('');
  document.querySelector('#people-count').textContent = String(guests.length + 1);
  document.querySelector('#message-input').disabled = !guests.length;
  document.querySelector('#file-btn').disabled = !guests.length;
  document.querySelector('#send-btn').disabled = !guests.length || !document.querySelector('#message-input').value.trim();
  renderJoinRequests();
}

function renderMessages({ incoming = false } = {}) {
  const panel = document.querySelector('#messages');
  if (!panel) return;
  const nearBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 70;
  if (!state.messages.length) {
    panel.innerHTML = `<div class="empty-state"><div class="empty-art"><span>✳</span><i></i><b>·</b></div><h2>${connectedCount() ? 'The room is yours now.' : 'A little space, just for you.'}</h2><p>${connectedCount() ? 'Say hello. Your words travel directly between browsers.' : 'Share an invite when you’re ready. The conversation begins when they arrive.'}</p></div>`;
    return;
  }
  const filtered = state.messages.filter((msg) => !state.search || `${msg.name} ${msg.text} ${msg.fileName || ''}`.toLocaleLowerCase().includes(state.search));
  panel.innerHTML = filtered.length ? filtered.map((msg) => {
    const reactionButtons = REACTIONS.map((emoji) => {
      const actors = msg.reactions?.[emoji] || {};
      const count = Object.keys(actors).length;
      const selected = Boolean(state.peer?.id && actors[state.peer.id]);
      return `<button type="button" class="reaction ${selected ? 'selected' : ''}" data-reaction="${emoji}" data-message="${esc(msg.id)}" aria-label="React ${emoji}${count ? `, ${count} reactions` : ''}" aria-pressed="${selected}">${emoji}${count ? `<span>${count}</span>` : ''}</button>`;
    }).join('');
    const actions = `<div class="message-actions">${!msg.deleted && !msg.expired ? `<button type="button" data-message-action="reply" data-message="${esc(msg.id)}">Reply</button>${msg.text ? `<button type="button" data-message-action="copy" data-message="${esc(msg.id)}">Copy</button>` : ''}${msg.mine ? `<button type="button" data-message-action="edit" data-message="${esc(msg.id)}">Edit</button><button type="button" data-message-action="delete" data-message="${esc(msg.id)}">Delete</button>` : ''}` : ''}</div>`;
    const quote = msg.replyTo ? `<div class="quoted-message"><strong>${esc(msg.replyTo.name)}</strong><span>${renderText(msg.replyTo.text)}</span></div>` : '';
    const file = msg.fileUrl ? `<a class="file-attachment" href="${esc(msg.fileUrl)}" download="${esc(msg.fileName)}"><span class="file-icon">↧</span><span><strong>${esc(msg.fileName)}</strong><small>${formatFileSize(msg.size)}</small></span></a>` : '';
    const bubble = msg.deleted ? '<em>This message was deleted</em>' : msg.expired ? '<em>This message expired</em>' : `${quote}${file}${msg.text ? renderText(msg.text) : ''}${msg.edited ? '<small class="edited-label"> · edited</small>' : ''}`;
    const receipt = msg.mine && msg.readBy && Object.keys(msg.readBy).length ? `<small class="read-receipt">Seen by ${esc(Object.values(msg.readBy).join(', '))}</small>` : '';
    const expiring = msg.expiresAt && !msg.expired ? '<small class="expiry-label">Disappearing</small>' : '';
    return `<div class="message-row ${msg.mine ? 'mine' : ''}"><span class="avatar ${msg.mine ? 'avatar-me' : 'avatar-0'}">${esc(initials(msg.name))}</span><div class="message-body"><div class="message-meta"><strong>${esc(msg.mine ? 'You' : msg.name)}</strong><time>${new Date(msg.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></div><div class="bubble">${bubble}</div>${expiring}${receipt}${actions}<div class="reaction-strip">${reactionButtons}</div></div></div>`;
  }).join('') : `<div class="search-empty">No messages match “${esc(state.search)}”.</div>`;
  if (incoming && !nearBottom && !state.search) { state.unread += 1; renderUnread(); }
  else if (nearBottom || !incoming) { panel.scrollTop = panel.scrollHeight; if (!incoming) { state.unread = 0; renderUnread(); } }
}

function toggleReaction(messageId, emoji) {
  if (!REACTIONS.includes(emoji) || !state.peer?.id || !connectedCount()) return;
  const message = state.messages.find((item) => item.id === messageId);
  if (!message) return;
  const active = !message.reactions?.[emoji]?.[state.peer.id];
  applyReaction(messageId, emoji, state.peer.id, state.name, active);
  const payload = { type: 'reaction', messageId, emoji, actorId: state.peer.id, name: state.name, active };
  if (state.isHost) relayToOthers(null, payload);
  else {
    const host = [...state.connections.values()].find((entry) => entry.connected);
    if (host) host.conn.send(payload);
  }
}

function applyReaction(messageId, emoji, actorId, actorName, active) {
  const message = state.messages.find((item) => item.id === messageId);
  if (!message || !actorId) return;
  message.reactions ||= {};
  message.reactions[emoji] ||= {};
  if (active) message.reactions[emoji][actorId] = actorName || 'Guest';
  else delete message.reactions[emoji][actorId];
  if (!Object.keys(message.reactions[emoji]).length) delete message.reactions[emoji];
  renderMessages();
}

function makeId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function formatFileSize(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function connectedCount() { return [...state.connections.values()].filter((entry) => entry.connected).length; }
function extractRoomId(raw) {
  try { if (raw.includes('://')) return new URL(raw).searchParams.get('room') || raw; } catch { return ''; }
  return raw.replace(/^room:/, '').trim();
}
async function shareInvite() {
  if (!state.roomId) return alertToast('Your room is still getting ready.');
  const url = new URL(location.href);
  url.search = new URLSearchParams({ room: state.roomId }).toString();
  try { await navigator.clipboard.writeText(url.toString()); alertToast('Invite link copied — send it to your person.'); }
  catch { window.prompt('Copy this invite link:', url.toString()); }
}
function alertToast(message) {
  const toast = document.querySelector('#toast');
  if (!toast) return;
  toast.textContent = message; toast.classList.add('show');
  clearTimeout(alertToast.timer); alertToast.timer = setTimeout(() => toast.classList.remove('show'), 3400);
}
function leaveRoom() {
  state.calls.forEach((call) => call.close());
  state.localStream?.getTracks().forEach((track) => track.stop());
  state.expiryTimers.forEach(clearTimeout);
  state.messages.forEach((message) => { if (message.fileUrl) URL.revokeObjectURL(message.fileUrl); });
  clearTimeout(state.typingTimer);
  state.typing.forEach(clearTimeout);
  state.typing.clear();
  state.localTyping = false;
  if (state.peer) state.peer.destroy();
  state.connections.clear(); state.pending.clear(); state.messages = []; state.peer = null;
  history.replaceState({}, '', location.pathname);
  renderLanding();
}

renderLanding();
