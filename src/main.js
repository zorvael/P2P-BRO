import Peer from 'peerjs';
import './style.css';

const app = document.querySelector('#app');
const state = {
  peer: null,
  connections: new Map(),
  name: '',
  roomId: '',
  isHost: false,
  messages: [],
};

const esc = (value) =>
  String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);

const initials = (name) =>
  name.trim().split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase() || 'Y';

function peerOptions() {
  const options = { debug: 1 };

  if (import.meta.env.VITE_PEER_HOST) {
    options.host = import.meta.env.VITE_PEER_HOST;
    options.port = Number(import.meta.env.VITE_PEER_PORT || 443);
    options.path = import.meta.env.VITE_PEER_PATH || '/peerjs';
    options.secure = import.meta.env.VITE_PEER_SECURE !== 'false';
  }

  if (import.meta.env.VITE_ICE_SERVERS) {
    try {
      options.config = {
        iceServers: JSON.parse(import.meta.env.VITE_ICE_SERVERS),
      };
    } catch {
      console.warn('VITE_ICE_SERVERS must be valid JSON; using browser defaults.');
    }
  }

  return options;
}

function renderLanding() {
  app.innerHTML = `
    <main class="landing">
      <nav class="topbar">
        <a class="brand" href="/">
          <span class="brand-mark">n</span> near<span class="brand-dot">.</span>
        </a>
        <span class="nav-note"><i class="status-dot"></i> End-to-end encrypted by WebRTC</span>
      </nav>

      <section class="hero">
        <div class="eyebrow"><span class="sparkle">✳</span> A quieter kind of conversation</div>
        <h1>Some things are<br /><em>better shared</em> directly.</h1>
        <p class="hero-copy">
          A little private room for you and your people. No accounts, no archives —
          just a direct connection between browsers.
        </p>

        <div class="action-card">
          <div class="card-tabs">
            <button class="tab active" data-tab="create">Start a room <span>↗</span></button>
            <button class="tab" data-tab="join">Join a room <span>→</span></button>
          </div>

          <form id="room-form" class="room-form">
            <label for="display-name">YOUR NAME</label>
            <input
              id="display-name"
              maxlength="32"
              autocomplete="nickname"
              placeholder="What should we call you?"
              required
            />

            <div id="room-code-wrap" class="hidden">
              <label for="room-code">ROOM INVITE</label>
              <input id="room-code" maxlength="100" placeholder="Paste an invite link or room ID" />
            </div>

            <button class="primary-btn" type="submit">
              <span id="submit-label">Create a private room</span><span>↗</span>
            </button>
          </form>

          <p class="card-foot"><span class="lock">⌑</span> Your messages stay between you and your guests.</p>
        </div>

        <div class="hero-aside">
          <span class="aside-line"></span>
          <span>Made for the moments that matter</span>
          <span class="aside-line"></span>
        </div>
      </section>

      <footer class="landing-footer">
        <span>© 2026 near</span>
        <span>Small rooms. Real conversations.</span>
        <span>Built for the present moment&nbsp; ✳</span>
      </footer>
    </main>`;

  let mode = 'create';

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      mode = tab.dataset.tab;

      document.querySelectorAll('.tab').forEach((item) => {
        item.classList.toggle('active', item === tab);
      });

      document.querySelector('#room-code-wrap').classList.toggle('hidden', mode === 'create');
      document.querySelector('#submit-label').textContent =
        mode === 'create' ? 'Create a private room' : 'Join the conversation';
    });
  });

  document.querySelector('#room-form').addEventListener('submit', (event) => {
    event.preventDefault();
    state.name = document.querySelector('#display-name').value.trim().slice(0, 32);

    if (!state.name) return;

    if (mode === 'create') {
      createRoom();
    } else {
      joinRoom(document.querySelector('#room-code').value.trim());
    }
  });

  const roomFromUrl = new URLSearchParams(location.search).get('room');

  if (roomFromUrl) {
    document.querySelector('[data-tab="join"]').click();
    document.querySelector('#room-code').value = roomFromUrl;
  }
}

function renderRoom() {
  app.innerHTML = `
    <main class="chat-shell">
      <header class="chat-topbar">
        <a class="brand" href="/">
          <span class="brand-mark">n</span> near<span class="brand-dot">.</span>
        </a>

        <div class="room-label">
          <span class="room-symbol">✳</span>
          <div>
            <strong>your little corner</strong>
            <small id="room-subtitle">Connecting to your room…</small>
          </div>
        </div>

        <div class="top-actions">
          <button id="invite-btn" class="outline-btn">Invite someone <span>↗</span></button>
          <button id="leave-btn" class="icon-btn" title="Leave room" aria-label="Leave room">×</button>
        </div>
      </header>

      <div class="chat-layout">
        <aside class="people-panel">
          <div class="panel-heading">
            <span>IN THIS ROOM</span>
            <span id="people-count" class="count-pill">1</span>
          </div>
          <div id="people-list"></div>

          <div class="privacy-note">
            <span class="privacy-icon">⌑</span>
            <div>
              <strong>Just between you</strong>
              <p>Messages travel directly between browsers. Nothing is stored on a server.</p>
            </div>
          </div>
        </aside>

        <section class="conversation">
          <div id="connection-banner" class="connection-banner">
            <i class="status-dot"></i>
            <span id="connection-text">Setting up your private connection</span>
          </div>

          <div id="messages" class="messages">
            <div class="empty-state">
              <div class="empty-art"><span>✳</span><i></i><b>·</b></div>
              <h2>A little space, just for you.</h2>
              <p>Share an invite when you’re ready. The conversation begins when they arrive.</p>
            </div>
          </div>

          <form id="message-form" class="composer">
            <button type="button" class="composer-symbol" title="This message is sent directly">✳</button>
            <input
              id="message-input"
              maxlength="2000"
              placeholder="Write something thoughtful…"
              autocomplete="off"
              disabled
            />
            <button id="send-btn" class="send-btn" type="submit" disabled aria-label="Send message">↑</button>
          </form>

          <div class="composer-foot">
            <span>Messages are not saved after you leave.</span>
            <span><kbd>↵</kbd> to send</span>
          </div>
        </section>
      </div>

      <div id="toast" class="toast" role="status"></div>
    </main>`;

  document.querySelector('#invite-btn').addEventListener('click', shareInvite);
  document.querySelector('#leave-btn').addEventListener('click', leaveRoom);
  document.querySelector('#message-form').addEventListener('submit', sendMessage);

  document.querySelector('#message-input').addEventListener('input', (event) => {
    document.querySelector('#send-btn').disabled =
      !event.target.value.trim() || !connectedCount();
  });

  updatePeople();
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

  if (!roomId || roomId.length > 100) {
    return alertToast('That invite doesn’t look quite right.');
  }

  state.isHost = false;
  state.roomId = roomId;
  renderRoom();

  state.peer = new Peer(undefined, peerOptions());
  bindPeerEvents();

  state.peer.on('open', () => {
    const conn = state.peer.connect(roomId, {
      reliable: true,
      metadata: { name: state.name },
    });

    addConnection(conn, true);
  });
}

function bindPeerEvents() {
  state.peer.on('error', (err) => {
    const messages = {
      'peer-unavailable': 'We couldn’t find that room. Check the invite and try again.',
      network: 'The signaling service is unreachable. Check your connection and try again.',
      'server-error': 'The signaling service had a moment. Please try again shortly.',
      'browser-incompatible': 'This browser does not support WebRTC. Try a recent browser.',
    };

    const message = messages[err.type] || 'Something interrupted the connection. Please try again.';
    alertToast(message);
    document.querySelector('#connection-text').textContent = message;
  });

  state.peer.on('disconnected', () => {
    document.querySelector('#connection-text').textContent = 'Reconnecting to the room service…';

    if (state.peer && !state.peer.destroyed) {
      state.peer.reconnect();
    }
  });
}

function addConnection(conn, outgoing = false) {
  state.connections.set(conn.peer, {
    conn,
    name: 'Guest',
    connected: false,
  });

  conn.on('open', () => {
    const entry = state.connections.get(conn.peer);
    if (!entry) return;

    entry.connected = true;

    if (outgoing) {
      conn.send({ type: 'hello', name: state.name });
    }

    updatePeople();

    const count = connectedCount();
    document.querySelector('#connection-text').textContent =
      `${count} ${count === 1 ? 'person is' : 'people are'} here · connected directly`;

    document.querySelector('#connection-banner').classList.add('ready');
    renderMessages();
  });

  conn.on('data', (data) => handleData(conn.peer, data));

  conn.on('close', () => {
    state.connections.delete(conn.peer);
    updatePeople();
    renderMessages();

    if (!connectedCount()) {
      document.querySelector('#connection-text').textContent =
        state.isHost ? 'Room is open · invite someone to begin' : 'Your guest left the room';
    }
  });

  conn.on('error', () => alertToast('A guest connection was interrupted.'));
}

function handleData(peerId, data) {
  if (!data || typeof data !== 'object') return;

  const entry = state.connections.get(peerId);
  if (!entry) return;

  if (data.type === 'hello' && typeof data.name === 'string') {
    entry.name = data.name.trim().slice(0, 32) || 'Guest';
    updatePeople();
    return;
  }

  if (
    data.type !== 'message' ||
    typeof data.text !== 'string' ||
    data.text.length < 1 ||
    data.text.length > 2000
  ) {
    return;
  }

  const text = data.text.trim();
  if (!text) return;

  const senderName =
    typeof data.name === 'string' ? data.name.trim().slice(0, 32) : entry.name;

  state.messages.push({
    name: senderName || entry.name,
    text,
    time: Date.now(),
    mine: false,
  });

  renderMessages();

  if (state.isHost) {
    state.connections.forEach((other, id) => {
      if (id !== peerId && other.connected) {
        other.conn.send({
          type: 'message',
          name: senderName || entry.name,
          text,
        });
      }
    });
  }
}

function sendMessage(event) {
  event.preventDefault();

  const input = document.querySelector('#message-input');
  const text = input.value.trim();

  if (!text || text.length > 2000 || !connectedCount()) return;

  const message = { type: 'message', name: state.name, text };

  if (state.isHost) {
    state.connections.forEach((entry) => {
      if (entry.connected) entry.conn.send(message);
    });
  } else {
    const host = [...state.connections.values()].find((entry) => entry.connected);
    if (!host) return;
    host.conn.send(message);
  }

  state.messages.push({
    name: state.name,
    text,
    time: Date.now(),
    mine: true,
  });

  input.value = '';
  document.querySelector('#send-btn').disabled = true;
  renderMessages();
}

function updatePeople() {
  const guests = [...state.connections.values()].filter((entry) => entry.connected);

  const me = `
    <div class="person">
      <span class="avatar avatar-me">${esc(initials(state.name))}</span>
      <span class="person-name">${esc(state.name)} <small>you</small></span>
      <span class="person-state online"></span>
    </div>`;

  const guestRows = guests.map((entry, index) => `
    <div class="person">
      <span class="avatar avatar-${index % 4}">${esc(initials(entry.name))}</span>
      <span class="person-name">${esc(entry.name)}</span>
      <span class="person-state online"></span>
    </div>`).join('');

  document.querySelector('#people-list').innerHTML = me + guestRows;
  document.querySelector('#people-count').textContent = String(guests.length + 1);

  document.querySelector('#message-input').disabled = !guests.length;
  document.querySelector('#send-btn').disabled =
    !guests.length || !document.querySelector('#message-input').value.trim();
}

function renderMessages() {
  const panel = document.querySelector('#messages');

  if (!state.messages.length) {
    panel.innerHTML = `
      <div class="empty-state">
        <div class="empty-art"><span>✳</span><i></i><b>·</b></div>
        <h2>${connectedCount() ? 'The room is yours now.' : 'A little space, just for you.'}</h2>
        <p>
          ${connectedCount()
            ? 'Say hello. Your words travel directly between browsers.'
            : 'Share an invite when you’re ready. The conversation begins when they arrive.'}
        </p>
      </div>`;
    return;
  }

  panel.innerHTML = state.messages.map((message) => `
    <div class="message-row ${message.mine ? 'mine' : ''}">
      <span class="avatar ${message.mine ? 'avatar-me' : 'avatar-0'}">
        ${esc(initials(message.name))}
      </span>
      <div class="message-body">
        <div class="message-meta">
          <strong>${esc(message.mine ? 'You' : message.name)}</strong>
          <time>${new Date(message.time).toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
          })}</time>
        </div>
        <div class="bubble">${esc(message.text).replace(/\n/g, '<br>')}</div>
      </div>
    </div>`).join('');

  panel.scrollTop = panel.scrollHeight;
}

function connectedCount() {
  return [...state.connections.values()].filter((entry) => entry.connected).length;
}

function extractRoomId(raw) {
  try {
    if (raw.includes('://')) {
      return new URL(raw).searchParams.get('room') || raw;
    }
  } catch {
    return '';
  }

  return raw.replace(/^room:/, '').trim();
}

async function shareInvite() {
  if (!state.roomId) {
    return alertToast('Your room is still getting ready.');
  }

  const url = new URL(location.href);
  url.search = new URLSearchParams({ room: state.roomId }).toString();

  try {
    await navigator.clipboard.writeText(url.toString());
    alertToast('Invite link copied — send it to your person.');
  } catch {
    window.prompt('Copy this invite link:', url.toString());
  }
}

function alertToast(message) {
  const toast = document.querySelector('#toast');
  if (!toast) return;

  toast.textContent = message;
  toast.classList.add('show');

  clearTimeout(alertToast.timer);
  alertToast.timer = setTimeout(() => toast.classList.remove('show'), 3400);
}

function leaveRoom() {
  if (state.peer) {
    state.peer.destroy();
  }

  state.connections.clear();
  state.messages = [];
  state.peer = null;

  history.replaceState({}, '', location.pathname);
  renderLanding();
}

renderLanding();
