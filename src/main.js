import Peer from 'peerjs';
import './style.css';
import { canAcceptGuest, createEventLimiter, isValidFileMessage, isValidTextMessage, normalizeExpiry } from './protocol.js';
import { createRecoveryRegistry, isPeerInRoster, retryDelay, safeConnectionState, summarizePeerStats } from './network.js';
import { createInboxClient, createMailbox, decryptInboxMessage, encryptInboxMessage, isValidMailbox, makeInboxLink, readInboxLink } from './offline.js';
import { isValidExperiencePacket, openExperiences } from './experiences.js';
import { findResumablePeer, isRoomReturnValid, ROOM_RETURN_WINDOW_MS } from './return.js';
import { openGlobalChat } from './global-chat.js';

const app = document.querySelector('#app');
const RETURN_WINDOW_MS = ROOM_RETURN_WINDOW_MS;
const GUEST_RETURN_KEY = 'near-room-return-v1';
const state = { peer: null, connections: new Map(), pending: new Map(), name: '', roomId: '', isHost: false, roomRoster: [], messages: [], copied: false, typing: new Map(), localTyping: false, typingTimer: null, guestReturnTimer: null, replyTo: null, editingId: null, unread: 0, search: '', expiryMs: 0, expiryTimers: new Map(), localStream: null, voiceActive: false, voiceRoster: [], calls: new Map(), pendingVoiceCalls: new Map(), voiceRecovery: createRecoveryRegistry(), voiceRetryTimers: new Map(), networkPeers: new Map(), dataRecovery: new Map(), resumeTokens: new Map(), resumeExpiry: new Map(), suspended: false, suspendedUntil: 0, suspendTimer: null, networkTimer: null, networkOpen: false, networkOnline: navigator.onLine, roomEnded: false, leaving: false, spacePollTimer: null, activeMailbox: null, experiences: null, rateLimit: createEventLimiter({ message: { windowMs: 10_000, limit: 20 }, file: { windowMs: 60_000, limit: 3 }, update: { windowMs: 10_000, limit: 40 }, experience: { windowMs: 10_000, limit: 30 } }) };
const REACTIONS = ['❤️', '😂', '👍', '🎉', '😮'];
const INBOX_API_URL = import.meta.env.VITE_INBOX_API_URL || '';
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const initials = (name) => name.trim().split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase() || 'Y';

function peerOptions() {
  const options = { debug: 0 };
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
      <nav class="topbar"><a class="brand" href="/"><span class="brand-mark">n</span> near<span class="brand-dot">.</span></a><span class="nav-note"><i class="status-dot"></i> WebRTC live rooms · private notes and inbox</span></nav>
      <section class="hero">
        <div class="eyebrow"><span class="sparkle">✳</span> A quieter kind of conversation</div>
        <h1>Some things are<br /><em>better shared</em> directly.</h1>
        <p class="hero-copy">A little private room for you and your people. No account needed: talk live, keep personal notes, or leave an encrypted note for later.</p>
        <div class="action-card">
          <div class="card-tabs"><button class="tab active" data-tab="create">Start a room <span>↗</span></button><button class="tab" data-tab="join">Join a room <span>→</span></button></div>
          <form id="room-form" class="room-form">
            <label for="display-name">YOUR NAME</label><input id="display-name" maxlength="32" autocomplete="nickname" placeholder="What should we call you?" required />
            <div id="room-code-wrap" class="hidden"><label for="room-code">ROOM INVITE</label><input id="room-code" maxlength="100" placeholder="Paste an invite link or room ID" /></div>
            <button class="primary-btn" type="submit"><span id="submit-label">Create a private room</span><span>↗</span></button>
          </form>
          <p class="card-foot"><span class="lock">⌑</span> Live room chat stays with its participants. Offline notes are encrypted before queuing.</p>
        </div>
      <section id="return-room" class="return-room hidden" aria-live="polite"></section>
        <div class="personal-actions"><button id="open-notes" type="button"><span>✎</span><strong>Your notes</strong><small>Just for you · saved on this device</small></button><button id="open-inbox" type="button"><span>↙</span><strong>Offline inbox</strong><small>Leave a note for someone who’s away</small></button><button id="open-global-chat" type="button"><span>◎</span><strong>Global chat</strong><small>One public room · open to everyone</small></button></div>
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
  document.querySelector('#open-notes').addEventListener('click', () => openPersonalSpace('notes'));
  document.querySelector('#open-inbox').addEventListener('click', () => openPersonalSpace('inbox'));
  document.querySelector('#open-global-chat').addEventListener('click', () => openGlobalChat(INBOX_API_URL));
  renderRoomReturn();
  const roomFromUrl = new URLSearchParams(location.search).get('room');
  if (roomFromUrl) {
    document.querySelector('[data-tab="join"]').click();
    document.querySelector('#room-code').value = roomFromUrl;
  }
  if (readInboxLink()) openPersonalSpace('inbox');
  else showWelcome();
}

function getGuestReturn() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(GUEST_RETURN_KEY) || 'null');
    if (!isRoomReturnValid(saved)) {
      sessionStorage.removeItem(GUEST_RETURN_KEY);
      return null;
    }
    return saved;
  } catch { return null; }
}

function saveGuestReturn() {
  if (!state.resumeToken || !state.roomId || state.isHost) return;
  try { sessionStorage.setItem(GUEST_RETURN_KEY, JSON.stringify({ roomId: state.roomId, token: state.resumeToken, name: state.name, expiresAt: Date.now() + RETURN_WINDOW_MS })); } catch {}
  clearInterval(state.guestReturnTimer);
  state.guestReturnTimer = null;
  if (!state.leaving && connectedCount()) state.guestReturnTimer = setInterval(() => {
    try { sessionStorage.setItem(GUEST_RETURN_KEY, JSON.stringify({ roomId: state.roomId, token: state.resumeToken, name: state.name, expiresAt: Date.now() + RETURN_WINDOW_MS })); } catch {}
  }, 30_000);
}

function clearGuestReturn() {
  try { sessionStorage.removeItem(GUEST_RETURN_KEY); } catch {}
}

function renderRoomReturn() {
  const panel = document.querySelector('#return-room');
  if (!panel) return;
  if (state.isHost && state.suspended && state.peer && !state.peer.destroyed) {
    document.querySelector('.landing')?.classList.add('has-suspended-room');
    panel.className = 'return-room';
    panel.innerHTML = `<div><strong>Your room is still open</strong><small>Come back within five minutes. Keep this browser tab open so your guests can stay connected.</small></div><button id="return-to-room" type="button">Return to room <span>↗</span></button>`;
    panel.querySelector('#return-to-room').addEventListener('click', resumeHostRoom);
    return;
  }
  document.querySelector('.landing')?.classList.remove('has-suspended-room');
  const saved = getGuestReturn();
  if (!saved) { panel.className = 'return-room hidden'; panel.replaceChildren(); return; }
  panel.className = 'return-room';
  panel.innerHTML = `<div><strong>Pick up where you left off</strong><small>Your return link is saved in this tab for five minutes. The host must still have the room open.</small></div><button id="return-to-room" type="button">Return as ${esc(saved.name || 'Guest')} <span>↗</span></button>`;
  panel.querySelector('#return-to-room').addEventListener('click', () => { state.name = saved.name || ''; state.resumeToken = saved.token; joinRoom(saved.roomId); });
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
      <div class="welcome-points"><span><i>✳</i> Invite-only rooms</span><span><i>↗</i> Direct browser chat</span><span><i>⌑</i> Local notes · encrypted inbox</span></div>
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

function savedMailbox() {
  try {
    const value = JSON.parse(localStorage.getItem('near-offline-inbox') || 'null');
    return isValidMailbox(value) ? value : null;
  } catch { return null; }
}

function openPersonalSpace(selectedTab = 'notes') {
  closePersonalSpace();
  const layer = document.createElement('div');
  layer.className = 'space-layer';
  layer.id = 'personal-space-layer';
  layer.innerHTML = `<section class="space-card" role="dialog" aria-modal="true" aria-labelledby="space-title"><header class="space-header"><div><span class="space-kicker">A LITTLE SPACE, JUST FOR YOU</span><h2 id="space-title">Your space</h2></div><button class="space-close" type="button" aria-label="Close your space">×</button></header><div class="space-tabs" role="tablist"><button type="button" data-space-tab="notes" role="tab">Personal notes</button><button type="button" data-space-tab="inbox" role="tab">Offline inbox</button></div><div id="space-content" class="space-content"></div></section>`;
  document.body.append(layer);
  layer.querySelector('.space-close').addEventListener('click', closePersonalSpace);
  layer.addEventListener('click', (event) => { if (event.target === layer) closePersonalSpace(); });
  layer.addEventListener('keydown', (event) => { if (event.key === 'Escape') closePersonalSpace(); });
  layer.querySelectorAll('[data-space-tab]').forEach((button) => button.addEventListener('click', () => renderPersonalSpace(button.dataset.spaceTab)));
  renderPersonalSpace(selectedTab);
}

function closePersonalSpace() {
  clearInterval(state.spacePollTimer);
  state.spacePollTimer = null;
  document.querySelector('#personal-space-layer')?.remove();
}

function renderPersonalSpace(tab) {
  clearInterval(state.spacePollTimer);
  state.spacePollTimer = null;
  const layer = document.querySelector('#personal-space-layer');
  const content = document.querySelector('#space-content');
  if (!layer || !content) return;
  layer.querySelectorAll('[data-space-tab]').forEach((button) => {
    const active = button.dataset.spaceTab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  if (tab === 'notes') {
    content.innerHTML = `<p class="space-description">A private scratchpad for thoughts, plans, and reminders.</p><label class="space-label" for="personal-note">YOUR NOTE</label><textarea id="personal-note" maxlength="20000" placeholder="Write something for yourself…"></textarea><div class="space-note-footer"><span id="note-save-state">Saved only in this browser on this device.</span><span id="note-count">0 / 20,000</span></div>`;
    const note = document.querySelector('#personal-note');
    note.value = localStorage.getItem('near-personal-notes') || '';
    const update = () => {
      localStorage.setItem('near-personal-notes', note.value);
      document.querySelector('#note-count').textContent = `${note.value.length.toLocaleString()} / 20,000`;
      document.querySelector('#note-save-state').textContent = 'Saved on this device';
    };
    note.addEventListener('input', update);
    update();
    note.focus();
    return;
  }
  const linkedMailbox = readInboxLink();
  state.activeMailbox = linkedMailbox || state.activeMailbox || savedMailbox();
  if (!INBOX_API_URL) {
    content.innerHTML = `<div class="space-not-ready"><span>↙</span><h3>One small setup step left</h3><p>Your offline inbox needs a tiny message store that stays online while you’re away. Near has no server today, so the inbox can’t receive messages until its optional inbox service is deployed and connected.</p><small>Messages will be encrypted in your browser before the service stores them. The service will not receive your message text or encryption key.</small></div>`;
    return;
  }
  if (!state.activeMailbox) {
    content.innerHTML = `<div class="space-not-ready"><span>↙</span><h3>Create your private inbox</h3><p>Make a one-time invite link. People with the link can leave encrypted notes for you, even when you’re offline.</p><button id="create-inbox" class="space-primary" type="button">Create inbox invite <span>↗</span></button><small>Keep the link private. It contains the key needed to read messages.</small></div>`;
    document.querySelector('#create-inbox').addEventListener('click', async () => {
      state.activeMailbox = createMailbox();
      localStorage.setItem('near-offline-inbox', JSON.stringify(state.activeMailbox));
      await copyInboxInvite(state.activeMailbox);
      renderPersonalSpace('inbox');
    });
    return;
  }

  const mailbox = state.activeMailbox;
  content.innerHTML = `<div class="inbox-tools"><div><strong>Private inbox</strong><small id="inbox-status">Checking for messages…</small></div><div><button id="copy-inbox-link" type="button">Copy invite</button><button id="refresh-inbox" type="button" aria-label="Refresh inbox">↻</button></div></div><div id="inbox-messages" class="inbox-messages" aria-live="polite"></div><form id="offline-message-form" class="offline-message-form"><label class="space-label" for="offline-sender">YOUR NAME</label><input id="offline-sender" maxlength="32" placeholder="Your name" autocomplete="name" required /><label class="space-label" for="offline-text">LEAVE AN OFFLINE NOTE</label><textarea id="offline-text" maxlength="2000" placeholder="They’ll see it when they open their inbox…" required></textarea><div class="offline-compose-footer"><small>Encrypted on this device before sending.</small><button class="space-primary" type="submit">Leave note <span>↗</span></button></div></form><small class="space-privacy">Inbox links are private capabilities: anyone who has the link can send and read messages in that inbox. Messages expire after 30 days.</small>`;
  const client = createInboxClient(INBOX_API_URL);
  let loading = false;
  const load = async () => {
    if (loading || !document.querySelector('#inbox-messages')) return;
    loading = true;
    document.querySelector('#inbox-status').textContent = 'Checking for messages…';
    try {
      const result = await client.list(mailbox);
      const messages = await Promise.all((Array.isArray(result.messages) ? result.messages : []).map((item) => decryptInboxMessage(mailbox, item)));
      const received = messages.filter(Boolean);
      document.querySelector('#inbox-status').textContent = received.length ? `${received.length} encrypted note${received.length === 1 ? '' : 's'} · refreshed just now` : 'No notes yet · this inbox is ready';
      document.querySelector('#inbox-messages').innerHTML = received.length ? received.map((item) => `<article class="inbox-message"><header><strong>${esc(item.sender)}</strong><time>${item.receivedAt ? new Date(item.receivedAt).toLocaleString() : new Date(item.sentAt).toLocaleString()}</time></header><p>${esc(item.text).replace(/\n/g, '<br>')}</p></article>`).join('') : `<div class="inbox-empty"><span>✳</span><strong>A little space, just for you.</strong><small>New notes will appear here when someone leaves one.</small></div>`;
    } catch (error) {
      document.querySelector('#inbox-status').textContent = error.message || 'Could not reach the inbox right now.';
    } finally { loading = false; }
  };
  document.querySelector('#copy-inbox-link').addEventListener('click', () => copyInboxInvite(mailbox));
  document.querySelector('#refresh-inbox').addEventListener('click', load);
  document.querySelector('#offline-message-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    const text = document.querySelector('#offline-text').value.trim();
    if (!text) return;
    button.disabled = true;
    try {
      const envelope = await encryptInboxMessage(mailbox, { sender: document.querySelector('#offline-sender').value, text });
      await client.send(mailbox, envelope);
      document.querySelector('#offline-text').value = '';
      alertToast('Encrypted note delivered to the inbox.');
      await load();
    } catch (error) { alertToast(error.message || 'Could not leave that note.'); }
    finally { button.disabled = false; }
  });
  load();
  state.spacePollTimer = setInterval(load, 15_000);
}

async function copyInboxInvite(mailbox) {
  try {
    const link = makeInboxLink(mailbox, location.href);
    await navigator.clipboard.writeText(link);
    alertToast('Private inbox invite copied. Keep it to people you trust.');
  } catch {
    alertToast('Could not copy the inbox invite. Check clipboard permissions.');
  }
}

function renderRoom() {
  app.innerHTML = `
    <main class="chat-shell">
      <header class="chat-topbar"><a class="brand" href="/"><span class="brand-mark">n</span> near<span class="brand-dot">.</span></a><div class="room-label"><span class="room-symbol">✳</span><div><strong>your little corner</strong><small id="room-subtitle">Connecting to your room…</small></div></div><div class="top-actions"><button id="theme-btn" class="outline-btn" type="button" aria-label="Toggle dark mode" title="Toggle dark mode">◐</button><button id="voice-btn" class="outline-btn voice-btn" type="button" aria-label="Join voice chat">♫ <span>Voice</span></button><button id="experiences-btn" class="outline-btn" type="button">Experiences</button><button id="space-btn" class="outline-btn" type="button">Your space</button><button id="invite-btn" class="outline-btn">Invite someone <span>↗</span></button><button id="leave-btn" class="icon-btn" title="Step away; return within five minutes" aria-label="Step away; return within five minutes">×</button></div></header>
      <div class="chat-layout"><aside class="people-panel"><div class="panel-heading"><span>IN THIS ROOM</span><span id="people-count" class="count-pill">1</span></div><div id="people-list"></div><div id="join-requests" class="join-requests"></div><div class="privacy-note"><span class="privacy-icon">⌑</span><div><strong>Just between you</strong><p>Messages travel directly between browsers. Nothing is stored on a server.</p></div></div></aside>
      <section class="conversation"><div id="connection-banner" class="connection-banner"><i class="status-dot"></i><span id="connection-text">Setting up your private connection</span><button id="retry-btn" class="retry-btn hidden" type="button">Retry</button><button id="network-toggle" class="network-toggle" type="button" aria-expanded="false" aria-controls="network-dashboard">Network</button><button id="search-toggle" class="search-toggle" type="button" aria-label="Search messages" title="Search messages">⌕</button></div><section id="network-dashboard" class="network-dashboard hidden" aria-label="Live connection details"><div class="network-dashboard-heading"><div><strong>Live connection details</strong><small>Peer connection metrics · private addresses and ICE credentials are hidden</small></div><button id="network-close" type="button" aria-label="Close connection details">×</button></div><div id="network-rows" class="network-rows"></div></section><div id="message-search" class="message-search hidden"><input id="search-input" type="search" placeholder="Search this conversation…" aria-label="Search messages" /><button id="search-clear" type="button" aria-label="Clear search">×</button></div><div id="messages" class="messages"><div class="empty-state"><div class="empty-art"><span>✳</span><i></i><b>·</b></div><h2>A little space, just for you.</h2><p>Share an invite when you’re ready. The conversation begins when they arrive.</p></div></div><button id="new-messages" class="new-messages hidden" type="button">↓ New messages</button><div id="typing-indicator" class="typing-indicator" aria-live="polite"></div><div id="reply-preview" class="reply-preview hidden"></div><form id="message-form" class="composer"><button type="button" class="composer-symbol" title="This message is sent directly">✳</button><button id="file-btn" type="button" class="file-btn" title="Share a file" aria-label="Share a file" disabled>＋</button><input id="file-input" class="hidden" type="file" /><select id="expiry-select" class="expiry-select" aria-label="Message expiry" title="Disappearing messages"><option value="0">Keep</option><option value="60000">1 min</option><option value="3600000">1 hour</option><option value="86400000">1 day</option></select><input id="message-input" maxlength="2000" placeholder="Write something thoughtful…" autocomplete="off" disabled /><button id="send-btn" class="send-btn" type="submit" disabled aria-label="Send message">↑</button></form><div class="composer-foot"><span>Messages are not saved after you leave.</span><span><kbd>↵</kbd> to send</span></div><div id="audio-players" class="audio-players" aria-label="Voice chat audio"></div></section></div>
      <div id="toast" class="toast" role="status"></div>
    </main>`;
  document.querySelector('#invite-btn').addEventListener('click', shareInvite);
  document.querySelector('#leave-btn').addEventListener('click', () => state.isHost ? suspendHostRoom() : leaveRoom());
  document.querySelector('#message-form').addEventListener('submit', sendMessage);
  document.querySelector('#voice-btn').addEventListener('click', toggleVoice);
  document.querySelector('#space-btn').addEventListener('click', () => openPersonalSpace('notes'));
  document.querySelector('#experiences-btn').addEventListener('click', openRoomExperiences);
  document.querySelector('#retry-btn').addEventListener('click', retryJoinRoom);
  document.querySelector('#network-toggle').addEventListener('click', toggleNetworkDashboard);
  document.querySelector('#network-close').addEventListener('click', toggleNetworkDashboard);
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
  startNetworkMonitor();
  document.body.classList.toggle('dark', localStorage.getItem('near-theme') === 'dark');
}

function toggleTheme() {
  const enabled = !document.body.classList.contains('dark');
  document.body.classList.toggle('dark', enabled);
  localStorage.setItem('near-theme', enabled ? 'dark' : 'light');
}

function createRoomExperiences() {
  return openExperiences({
    roomId: state.roomId,
    name: state.name,
    isHost: state.isHost,
    peers: () => state.isHost ? [...state.connections].filter(([, entry]) => entry.connected).map(([id, entry]) => ({ id, name: entry.name })) : state.roomRoster.filter((person) => person.id !== state.peer?.id),
    send: (packet) => {
      const payload = { type: 'experience', ...packet };
      if (state.isHost) relayToOthers(null, payload);
      else sendToHost(payload);
    },
    onBookmark: () => alertToast(state.voiceActive ? 'Call moment bookmarked. No audio or video was recorded.' : 'Room moment bookmarked.')
  });
}

function openRoomExperiences() {
  if (!state.experiences) state.experiences = createRoomExperiences();
  state.experiences.open();
}

function broadcastRoomRoster() {
  if (!state.isHost || !state.peer?.id) return;
  const roster = [{ id: state.peer.id, name: state.name }, ...[...state.connections].filter(([, entry]) => entry.connected).map(([id, entry]) => ({ id, name: entry.name }))].slice(0, 4);
  relayToOthers(null, { type: 'room-roster', roster });
}

function updateVoiceUI() {
  const button = document.querySelector('#voice-btn');
  if (!button) return;
  button.classList.toggle('active', state.voiceActive);
  button.innerHTML = state.voiceActive ? '♫ <span>Leave voice</span>' : '♫ <span>Voice</span>';
  button.setAttribute('aria-label', state.voiceActive ? 'Leave voice chat' : 'Join voice chat');
  button.title = state.voiceActive ? `In voice chat with ${state.voiceRoster.length} participant${state.voiceRoster.length === 1 ? '' : 's'}` : 'Join voice chat';
  button.disabled = !state.isHost && connectedCount() === 0;
}

function ensureNetworkPeer(peerId, name = 'Guest') {
  let record = state.networkPeers.get(peerId);
  if (!record) {
    record = { name: name || 'Guest', chat: { state: 'connecting', ice: 'new', metrics: null }, voice: { state: 'off', ice: 'unknown', metrics: null }, recovery: '' };
    state.networkPeers.set(peerId, record);
  } else if (name) record.name = name;
  return record;
}

function toggleNetworkDashboard() {
  state.networkOpen = !state.networkOpen;
  const panel = document.querySelector('#network-dashboard');
  const button = document.querySelector('#network-toggle');
  panel?.classList.toggle('hidden', !state.networkOpen);
  button?.setAttribute('aria-expanded', String(state.networkOpen));
  renderNetworkDashboard();
}

function renderNetworkDashboard() {
  const rows = document.querySelector('#network-rows');
  if (!rows) return;
  const peers = [...state.networkPeers.entries()];
  if (!peers.length) {
    rows.innerHTML = `<p class="network-empty">No peer connections yet. Connection details will appear when someone joins.</p>`;
    return;
  }
  rows.innerHTML = peers.map(([peerId, record]) => {
    const metric = record.voice.metrics || record.chat.metrics;
    const metricMode = record.voice.metrics ? 'Voice stats' : record.chat.metrics ? 'Chat stats' : 'Stats unavailable';
    const chatState = state.dataRecovery.get(peerId)?.active ? 'recovering' : record.chat.state;
    const voiceState = record.voice.state;
    const route = metric?.path === 'direct' ? 'Direct (stats confirmed)' : metric?.path === 'relayed' ? 'Relayed via TURN' : 'Unknown (stats unavailable)';
    const rtt = metric?.rttMs === null || metric?.rttMs === undefined ? 'Unavailable' : `${metric.rttMs} ms${metric.rttSource === 'remote-report' ? ' · remote report' : ''}`;
    const loss = metric?.packetLossPercent === null || metric?.packetLossPercent === undefined ? 'Unavailable' : `${metric.packetLossPercent}%`;
    const jitter = metric?.jitterMs === null || metric?.jitterMs === undefined ? 'Unavailable' : `${metric.jitterMs} ms`;
    const candidateTypes = metric?.candidateTypes || 'Unavailable';
    return `<article class="network-peer"><div class="network-peer-heading"><strong>${esc(record.name)}</strong><span>${state.networkOnline ? 'Network online' : 'Device offline'}</span></div><div class="network-states"><span>Chat <b>${esc(statusLabel(chatState))}</b></span><span>Voice <b>${esc(statusLabel(voiceState))}</b></span></div><div class="network-metrics"><span><small>Path</small><b>${esc(route)}</b></span><span><small>RTT</small><b>${esc(rtt)}</b></span><span><small>Packet loss</small><b>${esc(loss)}</b></span><span><small>Jitter</small><b>${esc(jitter)}</b></span><span><small>Candidate types</small><b>${esc(candidateTypes)}</b></span></div><small class="network-source">${metricMode} · values come from this browser’s WebRTC stats</small>${record.recovery ? `<small class="network-recovery">${esc(record.recovery)}</small>` : ''}</article>`;
  }).join('');
}

function setPeerNetworkState(peerId, kind, { stateName, iceState, name } = {}) {
  const record = ensureNetworkPeer(peerId, name);
  if (stateName) record[kind].state = safeConnectionState(stateName);
  if (iceState) record[kind].ice = safeConnectionState(iceState);
  renderNetworkDashboard();
}

function startNetworkMonitor() {
  clearInterval(state.networkTimer);
  if (!state.networkListenersBound) {
    state.networkListenersBound = true;
    window.addEventListener('offline', () => {
      state.networkOnline = false;
      renderNetworkDashboard();
    });
    window.addEventListener('online', () => {
      state.networkOnline = true;
      renderNetworkDashboard();
      state.dataRecovery.forEach((recovery, peerId) => {
        if (recovery.active && !recovery.timer) scheduleDataRecovery(peerId, 'Network restored', 0);
      });
      state.voiceRoster.forEach((person) => {
        const voice = state.networkPeers.get(person.id)?.voice;
        if (voice && voice.state !== 'connected') failVoiceAttempt(person.id, 'Network restored', 0);
      });
    });
  }
  state.networkOnline = navigator.onLine;
  state.networkTimer = setInterval(() => {
    for (const [peerId, entry] of [...state.connections, ...state.pending]) {
      pollConnectionStats(peerId, 'chat', entry.conn?.peerConnection, entry.name);
    }
    for (const [peerId, call] of state.calls) pollConnectionStats(peerId, 'voice', call.peerConnection);
    for (const [peerId, call] of state.pendingVoiceCalls) pollConnectionStats(peerId, 'voice', call.peerConnection);
  }, 2500);
}

async function pollConnectionStats(peerId, kind, peerConnection, name) {
  if (!peerConnection || typeof peerConnection.getStats !== 'function') return;
  const record = ensureNetworkPeer(peerId, name);
  const link = record[kind];
  if (link.statsPending) return;
  link.statsPending = true;
  try {
    const report = await peerConnection.getStats();
    link.metrics = summarizePeerStats(report);
    link.state = safeConnectionState(peerConnection.connectionState || peerConnection.iceConnectionState);
    link.ice = safeConnectionState(peerConnection.iceConnectionState);
  } catch {
    link.metrics ||= null;
  } finally {
    link.statsPending = false;
    renderNetworkDashboard();
  }
}

function statusLabel(status) {
  return ({ new: 'Starting', connecting: 'Connecting', checking: 'Checking route', connected: 'Connected', completed: 'Connected', disconnected: 'Reconnecting', failed: 'Failed', closed: 'Closed', unknown: 'Unavailable', off: 'Not in voice' })[status] || 'Unavailable';
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

function stopVoice(notifyHost = true) {
  state.voiceActive = false;
  state.calls.forEach((call) => call.close());
  state.pendingVoiceCalls.forEach((call) => call.close());
  state.calls.clear();
  state.pendingVoiceCalls.clear();
  state.voiceRetryTimers.forEach(clearTimeout);
  state.voiceRetryTimers.clear();
  state.networkPeers.forEach((record, peerId) => { record.voice.state = 'off'; record.recovery = ''; state.voiceRecovery.clear(peerId); });
  document.querySelector('#audio-players')?.replaceChildren();
  state.localStream?.getTracks().forEach((track) => track.stop());
  state.localStream = null;
  if (state.isHost) broadcastVoiceRoster();
  else if (notifyHost) sendToHost({ type: 'voice-left', name: state.name });
  updateVoiceUI();
  renderNetworkDashboard();
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
  state.calls.forEach((call, id) => { if (!peers.has(id)) { call.close(); state.calls.delete(id); removeAudio(id); const record = state.networkPeers.get(id); if (record) record.voice.state = 'off'; state.voiceRecovery.clear(id); } });
  state.pendingVoiceCalls.forEach((call, id) => {
    if (!isPeerInRoster(id, state.voiceRoster)) {
      call.close();
      state.pendingVoiceCalls.delete(id);
      const timer = state.voiceRetryTimers.get(id);
      if (timer) clearTimeout(timer);
      state.voiceRetryTimers.delete(id);
      state.voiceRecovery.clear(id);
    }
  });
  peers.forEach((name, id) => {
    if (state.calls.has(id) || state.pendingVoiceCalls.has(id)) return;
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
  const existing = state.calls.get(call.peer);
  const pending = state.pendingVoiceCalls.get(call.peer);
  if (pending && pending !== call) { call.close(); return; }
  if (existing && call.metadata?.recovery !== true) { call.close(); return; }
  registerVoiceCall(call.peer, call, false, { replacement: Boolean(existing) });
  call.answer(state.localStream);
}

function registerVoiceCall(peerId, call, outgoing, { replacement = false } = {}) {
  if (replacement) state.pendingVoiceCalls.set(peerId, call);
  else state.calls.set(peerId, call);
  const record = ensureNetworkPeer(peerId);
  record.voice.state = replacement ? 'connecting' : 'checking';
  const pc = call.peerConnection;
  const onState = () => {
    const ice = pc?.iceConnectionState || 'unknown';
    record.voice.ice = safeConnectionState(ice);
    if (ice === 'connected' || ice === 'completed') {
      record.voice.state = 'connected';
      const timer = state.voiceRetryTimers.get(peerId);
      if (timer) { clearTimeout(timer); state.voiceRetryTimers.delete(peerId); }
    } else if (ice === 'disconnected' || ice === 'failed') {
      record.voice.state = 'recovering';
      if (isVoiceRecoveryLeader(peerId)) {
        const wait = ice === 'disconnected' ? 3500 : 0;
        failVoiceAttempt(peerId, ice === 'failed' ? 'Voice path failed' : 'Voice connection interrupted', wait);
      }
    } else if (ice === 'checking') record.voice.state = 'checking';
    renderNetworkDashboard();
  };
  call.on('iceStateChanged', (ice) => {
    record.voice.ice = safeConnectionState(ice);
    if (ice === 'connected' || ice === 'completed') {
      record.voice.state = 'connected';
      const timer = state.voiceRetryTimers.get(peerId);
      if (timer) { clearTimeout(timer); state.voiceRetryTimers.delete(peerId); }
    } else if (ice === 'disconnected' || ice === 'failed') {
      record.voice.state = 'recovering';
      if (isVoiceRecoveryLeader(peerId)) failVoiceAttempt(peerId, `Voice ${ice}`, ice === 'disconnected' ? 3500 : 0);
    }
    renderNetworkDashboard();
  });
  pc?.addEventListener?.('connectionstatechange', onState);
  pc?.addEventListener?.('iceconnectionstatechange', onState);
  call.on('stream', (stream) => {
    const previous = state.calls.get(peerId);
    state.calls.set(peerId, call);
    if (state.pendingVoiceCalls.get(peerId) === call) state.pendingVoiceCalls.delete(peerId);
    state.voiceRecovery.complete(peerId);
    const timer = state.voiceRetryTimers.get(peerId);
    if (timer) { clearTimeout(timer); state.voiceRetryTimers.delete(peerId); }
    record.voice.state = 'connected';
    record.voice.ice = safeConnectionState(pc?.iceConnectionState || 'connected');
    record.recovery = '';
    attachAudio(peerId, stream);
    if (previous && previous !== call) previous.close();
    renderNetworkDashboard();
  });
  call.on('close', () => {
    const wasPending = state.pendingVoiceCalls.get(peerId) === call;
    if (wasPending) state.pendingVoiceCalls.delete(peerId);
    const wasCurrent = state.calls.get(peerId) === call;
    if (wasCurrent) state.calls.delete(peerId);
    if (!state.calls.has(peerId)) removeAudio(peerId);
    if (wasPending || wasCurrent) {
      const stillInVoice = state.voiceActive && state.voiceRoster.some((person) => person.id === peerId);
      if (stillInVoice && isVoiceRecoveryLeader(peerId)) failVoiceAttempt(peerId, 'Voice call closed');
      else if (!stillInVoice) record.voice.state = 'off';
    }
    renderNetworkDashboard();
  });
  call.on('error', () => {
    if (state.pendingVoiceCalls.get(peerId) === call) state.pendingVoiceCalls.delete(peerId);
    if (state.calls.get(peerId) === call) state.calls.delete(peerId);
    if (!state.calls.has(peerId)) removeAudio(peerId);
    if (state.voiceActive && state.voiceRoster.some((person) => person.id === peerId) && isVoiceRecoveryLeader(peerId)) failVoiceAttempt(peerId, 'Voice connection interrupted');
    renderNetworkDashboard();
  });
  onState();
}

function isVoiceRecoveryLeader(peerId) {
  return Boolean(state.peer?.id && state.peer.id.localeCompare(peerId) < 0);
}

function scheduleVoiceRecovery(peerId, reason, delayMs = null) {
  if (!state.voiceActive || !state.localStream || state.roomEnded || !isVoiceRecoveryLeader(peerId)) return;
  if (state.voiceRetryTimers.has(peerId) || state.pendingVoiceCalls.has(peerId)) return;
  const attempt = Math.max(1, state.voiceRecovery.attempts(peerId));
  const record = ensureNetworkPeer(peerId);
  if (attempt > 4) {
    record.voice.state = 'failed';
    record.recovery = 'Voice could not reconnect after 4 attempts.';
    renderNetworkDashboard();
    return;
  }
  record.voice.state = 'recovering';
  record.recovery = `${reason}. Retry ${attempt} of 4.`;
  const timer = setTimeout(() => {
    state.voiceRetryTimers.delete(peerId);
    if (!state.voiceActive || !state.localStream || state.roomEnded || state.pendingVoiceCalls.has(peerId)) return;
    const call = state.peer?.call(peerId, state.localStream, { metadata: { name: state.name, recovery: true, attempt } });
    if (!call) return failVoiceAttempt(peerId, 'Could not start a replacement voice call');
    state.voiceRecovery.begin(peerId);
    registerVoiceCall(peerId, call, true, { replacement: true });
    renderNetworkDashboard();
  }, Math.max(0, delayMs ?? retryDelay(attempt)));
  state.voiceRetryTimers.set(peerId, timer);
  renderNetworkDashboard();
}

function failVoiceAttempt(peerId, reason, delayOverride = null) {
  if (state.voiceRetryTimers.has(peerId)) return;
  const retry = state.voiceRecovery.fail(peerId);
  if (retry.delayMs === null) {
    const record = ensureNetworkPeer(peerId);
    record.voice.state = 'failed';
    record.recovery = `Voice could not reconnect after ${retry.attempt - 1} attempts.`;
    renderNetworkDashboard();
    return;
  }
  scheduleVoiceRecovery(peerId, reason, delayOverride ?? retry.delayMs);
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
  state.suspended = false;
  clearTimeout(state.suspendTimer);
  state.isHost = true;
  state.roomRoster = [];
  state.roomEnded = false;
  state.leaving = false;
  renderRoom();
  state.peer = new Peer(undefined, peerOptions());
  bindPeerEvents();
  state.peer.on('open', (id) => {
    state.roomId = id;
    window.nearPeerId = id;
    state.experiences = createRoomExperiences();
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
  state.roomRoster = [];
  state.roomEnded = false;
  state.leaving = false;
  state.suspended = false;
  state.roomId = roomId;
  state.experiences = createRoomExperiences();
  renderRoom();
  state.peer = new Peer(undefined, peerOptions());
  bindPeerEvents();
  state.peer.on('open', (id) => {
    window.nearPeerId = id;
    connectToRoom();
  });
}

function connectToRoom(automatic = false) {
  if (!state.peer || state.peer.destroyed || !state.roomId) return;
  const conn = state.peer.connect(state.roomId, { reliable: true, metadata: { name: state.name } });
  addConnection(conn, true, { automatic });
}

function retryJoinRoom() {
  if (state.isHost || !state.roomId) return;
  const button = document.querySelector('#retry-btn');
  button.disabled = true;
  document.querySelector('#connection-text').textContent = 'Trying to reconnect…';
  if (state.peer && !state.peer.destroyed) {
    const current = state.connections.get(state.roomId);
    if (current?.connected) { current.connected = false; current.recovering = true; current.conn.close(); }
    scheduleDataRecovery(state.roomId, 'Manual retry', 0);
  }
  else {
    state.peer = new Peer(undefined, peerOptions());
    bindPeerEvents();
    state.peer.on('open', () => scheduleDataRecovery(state.roomId, 'Manual retry', 0));
  }
  setTimeout(() => { if (button.isConnected) button.disabled = false; }, 2500);
}

function bindPeerEvents() {
  state.peer.on('call', handleIncomingVoiceCall);
  state.peer.on('error', (err) => {
    const messages = { 'peer-unavailable': 'Couldn’t find this room. It may be closed or the invite may be old; ask the host for a fresh link.', 'network': 'The signaling service is unreachable. Check your connection and try again.', 'server-error': 'The signaling service had a moment. Please try again shortly.', 'browser-incompatible': 'This browser does not support WebRTC. Try a recent version of Chrome, Firefox, Safari, or Edge.' };
    alertToast(messages[err.type] || 'Something interrupted the connection. Please try again.');
    document.querySelector('#connection-text').textContent = messages[err.type] || 'Connection interrupted';
    document.querySelector('#retry-btn')?.classList.toggle('hidden', state.isHost || !['peer-unavailable', 'network', 'server-error'].includes(err.type));
  });
  state.peer.on('disconnected', () => {
    document.querySelector('#connection-text').textContent = 'Reconnecting to the room service…';
    if (state.peer && !state.peer.destroyed) state.peer.reconnect();
  });
}

function addConnection(conn, outgoing = false, options = {}) {
  const existing = state.connections.get(conn.peer) || state.pending.get(conn.peer);
  if (existing && existing.conn !== conn && !existing.recovering) {
    conn.close();
    return;
  }
  if (!outgoing && !canAcceptGuest(connectedCount(), state.pending.size)) {
    const deny = () => { try { conn.send({ type: 'join-denied', reason: 'full' }); } catch {} setTimeout(() => conn.close(), 200); };
    if (conn.open) deny(); else conn.on('open', deny);
    return;
  }
  const entry = { conn, name: outgoing ? 'Host' : 'Guest', connected: false, voice: false, requested: false, outgoing, recovering: Boolean(options.automatic) };
  const network = ensureNetworkPeer(conn.peer, entry.name);
  network.chat.state = 'connecting';
  network.recovery = options.automatic ? 'Restoring chat connection…' : '';
  if (outgoing) state.connections.set(conn.peer, entry);
  else state.pending.set(conn.peer, entry);
  conn.on('open', () => {
    if (!outgoing) return;
    conn.send({ type: 'join-request', name: state.name, ...(state.resumeToken ? { resumeToken: state.resumeToken } : {}) });
    document.querySelector('#connection-text').textContent = 'Request sent · waiting for the host to approve';
    document.querySelector('#connection-banner').classList.add('ready');
    network.chat.state = 'connecting';
    renderNetworkDashboard();
    if (options.automatic) {
      const recovery = state.dataRecovery.get(conn.peer);
      if (recovery) recovery.handshakeTimer = setTimeout(() => { if (!entry.connected) conn.close(); }, 9000);
    }
    const emptyState = document.querySelector('#messages .empty-state');
    if (emptyState) {
      emptyState.querySelector('h2').textContent = 'Waiting for approval.';
      emptyState.querySelector('p').textContent = 'The host will let you into the room when they are ready.';
    }
  });
  conn.on('data', (data) => handleData(conn.peer, data));
  conn.on('iceStateChanged', (iceState) => {
    network.chat.ice = safeConnectionState(iceState);
    if (iceState === 'connected' || iceState === 'completed') {
      network.chat.state = 'connected';
      const recovery = state.dataRecovery.get(conn.peer);
      if (recovery?.disconnectTimer) { clearTimeout(recovery.disconnectTimer); recovery.disconnectTimer = null; }
      if (recovery?.timer && !recovery.connecting && entry.connected) {
        clearTimeout(recovery.timer);
        recovery.timer = null;
        recovery.active = false;
        state.dataRecovery.delete(conn.peer);
        network.recovery = '';
      }
    } else if (iceState === 'disconnected') {
      network.chat.state = 'disconnected';
      const recovery = state.dataRecovery.get(conn.peer) || { attempt: 0, timer: null, handshakeTimer: null, disconnectTimer: null, active: false, connecting: false };
      state.dataRecovery.set(conn.peer, recovery);
      clearTimeout(recovery.disconnectTimer);
      recovery.disconnectTimer = setTimeout(() => {
        recovery.disconnectTimer = null;
        if (state.connections.get(conn.peer) === entry && entry.connected && conn.peerConnection?.iceConnectionState === 'disconnected') conn.close();
      }, 3500);
    } else if (iceState === 'failed') {
      network.chat.state = 'failed';
      conn.close();
    }
    renderNetworkDashboard();
  });
  conn.on('close', () => {
    setTyping(entry.name, false);
    if (state.pending.get(conn.peer) === entry) state.pending.delete(conn.peer);
    state.rateLimit.clearPeer(conn.peer);
    const stillCurrent = state.connections.get(conn.peer) === entry;
    if (stillCurrent && entry.recovering && !entry.intentionalRemoteLeave && !state.leaving && !state.roomEnded && !state.peer?.destroyed) {
      const recovery = state.dataRecovery.get(conn.peer);
      if (recovery) { recovery.connecting = false; clearTimeout(recovery.handshakeTimer); recovery.handshakeTimer = null; }
      network.chat.state = 'recovering';
      scheduleDataRecovery(conn.peer, 'Recovery attempt did not connect');
      updatePeople();
      renderNetworkDashboard();
      return;
    }
    if (stillCurrent && entry.connected && !entry.intentionalRemoteLeave && !state.leaving && !state.roomEnded && !state.peer?.destroyed) {
      entry.connected = false;
      entry.recovering = true;
      network.chat.state = 'recovering';
      network.recovery = 'Restoring chat connection…';
      if (state.isHost) scheduleHostRecoveryExpiry(conn.peer, entry);
      else { saveGuestReturn(); scheduleDataRecovery(conn.peer, 'Chat connection closed'); }
      updatePeople();
      renderMessages();
      renderNetworkDashboard();
      return;
    }
    const wasInVoice = entry.voice;
    entry.voice = false;
    if (stillCurrent) state.connections.delete(conn.peer);
    if (state.isHost && stillCurrent) state.experiences?.participantLeft?.(conn.peer);
    if (state.isHost && stillCurrent) broadcastRoomRoster();
    network.chat.state = entry.intentionalRemoteLeave ? 'closed' : 'failed';
    network.recovery = '';
    if (state.isHost && entry.intentionalRemoteLeave) {
      scheduleHostRecoveryExpiry(conn.peer, entry);
      state.networkPeers.delete(conn.peer);
    }
    if (state.calls.has(conn.peer) && entry.intentionalRemoteLeave) state.calls.get(conn.peer).close();
    if (state.isHost && wasInVoice) broadcastVoiceRoster();
    if (!state.isHost && state.voiceActive && (entry.intentionalRemoteLeave || state.roomEnded)) stopVoice(false);
    renderJoinRequests(); updatePeople(); renderMessages(); renderNetworkDashboard();
    if (!connectedCount() && entry.connected) document.querySelector('#connection-text').textContent = state.isHost ? 'Room is open · invite someone to begin' : 'Your guest left the room';
  });
  conn.on('error', () => { network.chat.state = 'failed'; renderNetworkDashboard(); alertToast('A guest connection was interrupted.'); });
}

function scheduleDataRecovery(peerId, reason, delayOverride = null) {
  if (state.isHost || state.leaving || state.roomEnded || !state.roomId || !state.peer || state.peer.destroyed) return;
  const recovery = state.dataRecovery.get(peerId) || { attempt: 0, timer: null, handshakeTimer: null, disconnectTimer: null, active: false, connecting: false };
  state.dataRecovery.set(peerId, recovery);
  recovery.active = true;
  if (recovery.timer || recovery.connecting) return;
  if (!state.networkOnline) {
    ensureNetworkPeer(peerId).recovery = 'Waiting for your device to reconnect to the internet.';
    renderNetworkDashboard();
    return;
  }
  const attempt = delayOverride === 0 ? Math.max(1, recovery.attempt + 1) : recovery.attempt + 1;
  if (attempt > 4) {
    recovery.active = false;
    const entry = state.connections.get(peerId);
    if (entry?.recovering) { entry.voice = false; state.connections.delete(peerId); }
    const network = ensureNetworkPeer(peerId);
    network.chat.state = 'failed';
    network.recovery = 'Chat could not reconnect after 4 attempts. Ask the host for a new invite.';
    updatePeople();
    renderNetworkDashboard();
    return;
  }
  recovery.attempt = attempt;
  const wait = delayOverride === null ? retryDelay(attempt) : Math.max(0, delayOverride);
  const network = ensureNetworkPeer(peerId);
  network.chat.state = 'recovering';
  network.recovery = `${reason}. Retry ${attempt} of 4${wait ? ` in ${Math.ceil(wait / 1000)}s` : ' now'}.`;
  document.querySelector('#connection-text').textContent = 'Connection interrupted · reconnecting…';
  recovery.timer = setTimeout(() => {
    recovery.timer = null;
    if (state.leaving || state.roomEnded || !state.peer || state.peer.destroyed) return;
    if (!state.networkOnline) return scheduleDataRecovery(peerId, 'Waiting for internet', 0);
    const current = state.connections.get(peerId);
    if (current?.connected && !current.recovering) {
      recovery.active = false;
      recovery.attempt = 0;
      state.dataRecovery.delete(peerId);
      const network = ensureNetworkPeer(peerId);
      network.chat.state = 'connected';
      network.recovery = '';
      renderNetworkDashboard();
      return;
    }
    recovery.connecting = true;
    const conn = state.peer.connect(peerId, { reliable: true, metadata: { name: state.name } });
    addConnection(conn, true, { automatic: true });
    recovery.handshakeTimer = setTimeout(() => { if (recovery.connecting && !state.connections.get(peerId)?.connected) conn.close(); }, 12000);
  }, wait);
  renderNetworkDashboard();
}

function scheduleHostRecoveryExpiry(peerId, entry) {
  const recovery = state.dataRecovery.get(peerId) || { attempt: 0, timer: null, active: true };
  state.dataRecovery.set(peerId, recovery);
  recovery.active = true;
  if (recovery.expiryTimer) clearTimeout(recovery.expiryTimer);
  recovery.expiryTimer = setTimeout(() => {
    recovery.expiryTimer = null;
    if (state.resumeTokens.has(peerId)) {
      state.resumeTokens.delete(peerId);
      state.resumeExpiry.delete(peerId);
    }
    if (state.connections.get(peerId) !== entry || (!entry.recovering && !entry.intentionalRemoteLeave)) return;
    entry.voice = false;
    state.connections.delete(peerId);
    state.experiences?.participantLeft?.(peerId);
    recovery.active = false;
    const network = ensureNetworkPeer(peerId, entry.name);
    network.chat.state = 'failed';
    network.recovery = 'Guest could not reconnect.';
    if (state.calls.has(peerId)) state.calls.get(peerId).close();
    broadcastVoiceRoster();
    broadcastRoomRoster();
    updatePeople();
    renderNetworkDashboard();
    const token = state.resumeTokens.get(peerId);
    if (token) {
      state.resumeTokens.delete(peerId);
      state.resumeExpiry.delete(peerId);
    }
  }, RETURN_WINDOW_MS);
  state.resumeExpiry.set(peerId, Infinity);
}

function handleData(peerId, data) {
  if (!data || typeof data !== 'object') return;
  if (state.isHost && data.type === 'join-request') {
    const request = state.pending.get(peerId);
    if (!request) return;
    request.name = typeof data.name === 'string' ? data.name.trim().slice(0, 32) || 'Guest' : 'Guest';
    request.resumeToken = typeof data.resumeToken === 'string' ? data.resumeToken.slice(0, 100) : '';
    request.requested = true;
    if (request.resumeToken) {
      const priorId = findResumablePeer(state.resumeTokens, state.resumeExpiry, request.resumeToken);
      if (priorId) {
        if (priorId !== peerId) {
          const priorEntry = state.connections.get(priorId);
          if (priorEntry && priorEntry !== request) { priorEntry.intentionalRemoteLeave = true; priorEntry.conn.close(); state.connections.delete(priorId); }
          state.resumeTokens.delete(priorId);
          state.resumeExpiry.delete(priorId);
          const priorRecovery = state.dataRecovery.get(priorId);
          clearTimeout(priorRecovery?.expiryTimer);
          state.dataRecovery.delete(priorId);
          request.resumeToken = state.resumeTokens.get(priorId) || data.resumeToken;
        }
        approveGuest(peerId, { automatic: true, resumeToken: data.resumeToken });
        return;
      }
    }
    renderJoinRequests();
    const connectionText = document.querySelector('#connection-text');
    if (connectionText) connectionText.textContent = 'Someone is asking to join your room';
    return;
  }
  const entry = state.connections.get(peerId);
  if (!entry) return;
  if (state.isHost && data.type === 'leave-room') {
    entry.intentionalRemoteLeave = true;
    entry.conn.close();
    return;
  }
  if (!state.isHost && data.type === 'room-closing') {
    state.roomEnded = true;
    clearGuestReturn();
    clearInterval(state.guestReturnTimer);
    state.guestReturnTimer = null;
    const connectionText = document.querySelector('#connection-text');
    if (connectionText) connectionText.textContent = 'The host closed this room.';
    alertToast('The host closed this room.');
    entry.intentionalRemoteLeave = true;
    entry.conn.close();
    renderNetworkDashboard();
    return;
  }
  if (!state.isHost && data.type === 'join-approved') {
    entry.name = typeof data.name === 'string' ? data.name.trim().slice(0, 32) || 'Host' : 'Host';
    state.resumeToken = typeof data.resumeToken === 'string' ? data.resumeToken.slice(0, 100) : state.resumeToken;
    entry.connected = true;
    entry.recovering = false;
    saveGuestReturn();
    const recovery = state.dataRecovery.get(peerId);
    if (recovery) {
      clearTimeout(recovery.timer);
      clearTimeout(recovery.handshakeTimer);
      clearTimeout(recovery.disconnectTimer);
    }
    state.dataRecovery.delete(peerId);
    const network = ensureNetworkPeer(peerId, entry.name);
    network.chat.state = 'connected';
    network.recovery = '';
    updatePeople();
    document.querySelector('#connection-text').textContent = 'Connected directly · you’re in the room';
    document.querySelector('#connection-banner').classList.add('ready');
    document.querySelector('#retry-btn').classList.add('hidden');
    renderNetworkDashboard();
    renderMessages();
    sendToHost({ type: 'voice-roster-request' });
    sendToHost({ type: 'experience', feature: 'system', action: 'sync-request', eventId: makeId() });
    return;
  }
  if (!state.isHost && data.type === 'join-denied') {
    alertToast(data.reason === 'full' ? 'This room is full (maximum 4 people).' : 'The host didn’t approve your request.');
    entry.intentionalRemoteLeave = true;
    entry.conn.close();
    return;
  }
  if (!entry.connected) return;
  const limitedType = data.type === 'message' ? 'message' : data.type === 'file' ? 'file' : data.type === 'experience' ? 'experience' : ['reaction', 'edit', 'delete', 'expire'].includes(data.type) ? 'update' : null;
  if (limitedType && !state.rateLimit(peerId, limitedType)) { alertToast('Too many actions in a short time. Please slow down.'); return; }
  if (state.isHost && data.type === 'voice-roster-request') { broadcastVoiceRoster(); return; }
  if (!state.isHost && data.type === 'room-roster') {
    state.roomRoster = Array.isArray(data.roster) ? data.roster.filter((person) => person && typeof person.id === 'string' && typeof person.name === 'string').slice(0, 4) : [];
    state.experiences?.render?.();
    return;
  }
  if (data.type === 'experience') {
    if (!isValidExperiencePacket(data)) return;
    if (state.isHost && data.feature === 'system' && data.action === 'sync-request') {
      const snapshot = state.experiences?.snapshot?.();
      if (snapshot) entry.conn.send({ type: 'experience', feature: 'system', action: 'snapshot', snapshot, eventId: makeId() });
      return;
    }
    if (data.feature === 'system' && data.action === 'snapshot') {
      if (!state.isHost && data.snapshot && entry.connected) state.experiences?.restore?.(data.snapshot);
      return;
    }
    if (state.isHost) {
      if (data.feature === 'moment' && data.action === 'add' && data.item) data.item = { ...data.item, authorId: peerId, name: entry.name || 'Guest' };
      if (data.feature === 'moment' && data.action === 'delete' && data.authorId !== peerId) return;
      if (data.feature === 'pass' && data.action === 'story' && data.line) data.line = { ...data.line, name: entry.name || 'Guest' };
      if (data.feature === 'pass' && data.action === 'stroke' && data.stroke) data.stroke = { ...data.stroke, name: entry.name || 'Guest' };
    }
    state.experiences?.receive?.(data, peerId);
    if (state.isHost && !(data.feature === 'mirror' && ['submit', 'reveal', 'category'].includes(data.action))) relayToOthers(peerId, data);
    return;
  }
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
    if (!isValidTextMessage(data) || state.messages.some((message) => message.id === data.id)) return;
    const text = data.text.trim();
    if (!text) return;
    const senderName = state.isHost ? (entry.name || 'Guest') : (typeof data.name === 'string' ? data.name.trim().slice(0, 32) || entry.name : entry.name || 'Guest');
    const authorId = state.isHost ? peerId : (typeof data.authorId === 'string' ? data.authorId.slice(0, 100) : peerId);
    const replyTo = data.replyTo && typeof data.replyTo.name === 'string' && typeof data.replyTo.text === 'string' ? { id: String(data.replyTo.id || '').slice(0, 80), name: data.replyTo.name.slice(0, 32), text: data.replyTo.text.slice(0, 200) } : null;
    const expiresAt = normalizeExpiry(data.expiresAt);
    if (expiresAt === null) return;
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
    if (!isValidFileMessage(data) || state.messages.some((message) => message.id === data.id)) return;
    const authorId = state.isHost ? peerId : (typeof data.authorId === 'string' ? data.authorId.slice(0, 100) : peerId);
    const fileData = { ...data, authorId, name: state.isHost ? entry.name : (typeof data.name === 'string' ? data.name.slice(0, 32) : entry.name) };
    const expiresAt = normalizeExpiry(fileData.expiresAt);
    if (expiresAt === null) return;
    fileData.expiresAt = expiresAt;
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

function approveGuest(peerId, { automatic = false, resumeToken: suppliedToken = '' } = {}) {
  const request = state.pending.get(peerId);
  if (!request || !request.requested || !request.conn.open) return;
  const previous = state.connections.get(peerId);
  const resumeToken = suppliedToken || state.resumeTokens.get(peerId) || request.resumeToken || makeId();
  state.resumeTokens.set(peerId, resumeToken);
  state.resumeExpiry.set(peerId, Date.now() + RETURN_WINDOW_MS);
  state.pending.delete(peerId);
  request.connected = true;
  request.recovering = false;
  request.voice = Boolean(previous?.voice && state.voiceRoster.some((person) => person.id === peerId));
  state.connections.set(peerId, request);
  request.conn.send({ type: 'join-approved', name: state.name, resumeToken });
  const recovery = state.dataRecovery.get(peerId);
  if (recovery) {
    clearTimeout(recovery.expiryTimer);
    clearTimeout(recovery.timer);
    clearTimeout(recovery.handshakeTimer);
  }
  state.dataRecovery.delete(peerId);
  const network = ensureNetworkPeer(peerId, request.name);
  network.chat.state = 'connected';
  network.recovery = '';
  renderJoinRequests();
  updatePeople();
  broadcastRoomRoster();
  const connectionText = document.querySelector('#connection-text');
  if (connectionText) connectionText.textContent = `${connectedCount()} ${connectedCount() === 1 ? 'person is' : 'people are'} here · connected directly`;
  document.querySelector('#connection-banner')?.classList.add('ready');
  renderNetworkDashboard();
  if (automatic) alertToast(`${request.name} reconnected.`);
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
  input.focus({ preventScroll: true });
}

function updatePeople() {
  if (!document.querySelector('#people-list')) return;
  const guests = [...state.connections.values()].filter((entry) => entry.connected);
  const me = `<div class="person"><span class="avatar avatar-me">${esc(initials(state.name))}</span><span class="person-name">${esc(state.name)} <small>you</small></span><span class="person-state online"></span></div>`;
  document.querySelector('#people-list').innerHTML = me + guests.map((entry, i) => `<div class="person"><span class="avatar avatar-${i % 4}">${esc(initials(entry.name))}</span><span class="person-name">${esc(entry.name)}</span><span class="person-state online"></span></div>`).join('');
  document.querySelector('#people-count').textContent = String(guests.length + 1);
  document.querySelector('#message-input').disabled = !guests.length;
  document.querySelector('#file-btn').disabled = !guests.length;
  document.querySelector('#send-btn').disabled = !guests.length || !document.querySelector('#message-input').value.trim();
  updateVoiceUI();
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
    const receipt = msg.mine && msg.readBy && Object.keys(msg.readBy).length ? `<small class="read-receipt">Delivered to ${esc(Object.values(msg.readBy).join(', '))}</small>` : '';
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
  if (!toast) {
    const card = document.querySelector('.space-card');
    if (!card) return;
    let feedback = card.querySelector('.space-feedback');
    if (!feedback) { feedback = document.createElement('p'); feedback.className = 'space-feedback'; card.append(feedback); }
    feedback.textContent = message;
    return;
  }
  toast.textContent = message; toast.classList.add('show');
  clearTimeout(alertToast.timer); alertToast.timer = setTimeout(() => toast.classList.remove('show'), 3400);
}
function suspendHostRoom() {
  if (!state.isHost || !state.peer || state.peer.destroyed || state.suspended) return;
  state.suspended = true;
  state.suspendedUntil = Date.now() + RETURN_WINDOW_MS;
  stopVoice(false);
  state.experiences?.close?.();
  clearInterval(state.networkTimer);
  state.networkTimer = null;
  state.suspendTimer = setTimeout(() => leaveRoom(), RETURN_WINDOW_MS);
  history.replaceState({}, '', location.pathname);
  renderLanding();
}

function resumeHostRoom() {
  if (!state.isHost || !state.peer || state.peer.destroyed || !state.suspended || Date.now() >= state.suspendedUntil) return;
  clearTimeout(state.suspendTimer);
  state.suspendTimer = null;
  state.suspended = false;
  state.suspendedUntil = 0;
  renderRoom();
  document.querySelector('#room-subtitle').textContent = 'Your private room is open again';
  updatePeople();
  renderMessages();
  renderNetworkDashboard();
  document.querySelector('#connection-text').textContent = `${connectedCount()} ${connectedCount() === 1 ? 'person is' : 'people are'} here · room restored`;
  document.querySelector('#connection-banner').classList.add('ready');
}

function leaveRoom() {
  state.leaving = true;
  clearTimeout(state.suspendTimer);
  state.suspendTimer = null;
  state.experiences?.close?.();
  state.experiences = null;
  if (state.isHost) relayToOthers(null, { type: 'room-closing' });
  else { saveGuestReturn(); sendToHost({ type: 'leave-room' }); }
  clearInterval(state.networkTimer);
  clearInterval(state.guestReturnTimer);
  state.guestReturnTimer = null;
  state.dataRecovery.forEach((recovery) => { clearTimeout(recovery.timer); clearTimeout(recovery.handshakeTimer); clearTimeout(recovery.disconnectTimer); clearTimeout(recovery.expiryTimer); });
  state.voiceRetryTimers.forEach(clearTimeout);
  state.voiceRetryTimers.clear();
  state.dataRecovery.clear();
  state.calls.forEach((call) => call.close());
  state.pendingVoiceCalls.forEach((call) => call.close());
  state.localStream?.getTracks().forEach((track) => track.stop());
  state.expiryTimers.forEach(clearTimeout);
  state.messages.forEach((message) => { if (message.fileUrl) URL.revokeObjectURL(message.fileUrl); });
  clearTimeout(state.typingTimer);
  state.typing.forEach(clearTimeout);
  state.typing.clear();
  state.localTyping = false;
  state.voiceActive = false;
  state.voiceRoster = [];
  state.roomRoster = [];
  state.localStream = null;
  if (state.peer) state.peer.destroy();
  window.nearPeerId = null;
  state.connections.clear(); state.pending.clear(); state.calls.clear(); state.pendingVoiceCalls.clear(); state.networkPeers.clear(); state.resumeTokens.clear(); state.resumeExpiry.clear(); state.messages = []; state.peer = null;
  state.suspended = false; state.suspendedUntil = 0;
  state.networkTimer = null;
  history.replaceState({}, '', location.pathname);
  renderLanding();
}

renderLanding();
