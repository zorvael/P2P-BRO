const SESSION_KEY = 'near-global-chat-session-v1';
const MAX_MESSAGE = 1200;
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
function toIsoBirthDate(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length !== 8) return '';
  const day = digits.slice(0, 2);
  const month = digits.slice(2, 4);
  const year = digits.slice(4, 8);
  const iso = `${year}-${month}-${day}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : '';
}

function api(baseUrl, path, { token, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${baseUrl.replace(/\/$/, '')}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }).then(async (response) => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const messages = {
        unavailable: 'Global chat service is not ready. The site owner must deploy its Worker and database migration.',
        nickname_taken: 'That nickname is already in use. Try another one.',
        invalid_credentials: 'Nickname or password did not match.',
        unauthorized: 'Your session expired. Sign in again.',
        rate_limited: 'Please wait a moment before sending another message.',
        invalid_registration: 'Check your details. You must be 18 or older and use a 10+ character password.',
        invalid_message: 'Messages must contain 1–1,200 characters.',
      };
      throw new Error(messages[payload.error] || 'Could not complete that action. Please try again.');
    }
    return payload;
  });
}

export function openGlobalChat(baseUrl) {
  document.querySelector('#global-chat-layer')?.remove();
  const layer = document.createElement('div');
  layer.id = 'global-chat-layer';
  layer.className = 'global-chat-layer';
  layer.innerHTML = `<section class="global-chat-card" role="dialog" aria-modal="true" aria-labelledby="global-title"><header class="global-head"><div><span class="global-kicker">OPEN ROOM · PUBLIC FEED</span><h2 id="global-title">Global chat</h2></div><button class="global-close" type="button" aria-label="Close global chat">×</button></header><div class="global-content" id="global-content"></div><p class="global-error" id="global-error" role="status" aria-live="polite"></p></section>`;
  document.body.append(layer);
  const content = layer.querySelector('#global-content');
  const errorEl = layer.querySelector('#global-error');
  let token = '';
  let user = null;
  let timer = null;
  let busy = false;
  let loadingMessages = false;
  let messages = [];
  const close = () => { clearInterval(timer); layer.remove(); };
  const showError = (message = '') => { errorEl.textContent = message; };
  layer.querySelector('.global-close').addEventListener('click', close);
  layer.addEventListener('click', (event) => { if (event.target === layer) close(); });
  layer.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });

  const renderNotice = () => {
    content.innerHTML = `<div class="global-notice"><span class="global-symbol">◎</span><h3>Before you join</h3><p>This is one shared public feed. Everyone signed in can read your posts. Messages travel to and are stored by the Global Chat service for up to 7 days; they are <strong>not end-to-end encrypted</strong>.</p><ul><li>Use a nickname. Don’t post your password, phone number, address, live location, financial details, or anything you wouldn’t share publicly.</li><li>Contact details and meeting people are your choice and responsibility. Think carefully; never feel pressured.</li><li>Block and report controls are available. Reports are stored for review, but there is no staffed live moderation guarantee.</li><li>Accounts use a nickname and password. There is no email, phone, or password recovery. Your date of birth is checked for 18+ and not saved.</li></ul><label class="global-consent"><input id="global-consent" type="checkbox"><span>I’m 18 or older, understand this is a public service, and choose to continue.</span></label><button id="global-continue" class="space-primary" type="button" disabled>Continue to Global Chat ↗</button><small class="global-privacy">The service can read public message text and receives routine connection metadata such as IP address. Don’t treat this as anonymous or private.</small></div>`;
    const consent = content.querySelector('#global-consent');
    const button = content.querySelector('#global-continue');
    consent.addEventListener('change', () => { button.disabled = !consent.checked; });
    button.addEventListener('click', () => { sessionStorage.setItem('near-global-consent-v1', 'yes'); renderAuth(); });
    consent.focus();
  };

  const renderAuth = () => {
    content.innerHTML = `<div class="global-tabs"><button type="button" class="active" data-auth-tab="login">Sign in</button><button type="button" data-auth-tab="register">Create account</button></div><p class="global-auth-copy">No phone or email. Keep your password private; there is no account recovery.</p><form id="global-auth-form" class="global-auth-form"><label>Nickname<input name="nickname" minlength="2" maxlength="24" autocomplete="username" required placeholder="2–24 letters or numbers"></label><label>Password<input name="password" type="password" minlength="10" maxlength="128" autocomplete="current-password" required placeholder="At least 10 characters"></label><div id="global-extra-fields" hidden><label>Date of birth<input name="birthDate" type="text" inputmode="numeric" autocomplete="bday" maxlength="10" pattern="[0-9]{2}/[0-9]{2}/[0-9]{4}" placeholder="DD/MM/YYYY" aria-describedby="birth-date-help" required><small id="birth-date-help">Day / month / year, for example 25/08/2006.</small></label><div class="global-row"><label>Language<select name="language"><option value="en">English</option><option value="hi">हिन्दी</option></select></label><label>Country code<input name="country" minlength="2" maxlength="2" pattern="[A-Za-z]{2}" required placeholder="IN"></label></div><label>Gender<select name="gender"><option value="prefer_not_say">Prefer not to say</option><option value="woman">Woman</option><option value="man">Man</option><option value="nonbinary">Non-binary</option></select></label></div><button class="space-primary" type="submit" id="global-auth-submit">Sign in ↗</button></form><small class="global-privacy">Your profile details are stored by the service. You can use a nickname and leave gender undisclosed.</small>`;
    let mode = 'login';
    const extra = content.querySelector('#global-extra-fields');
    const form = content.querySelector('#global-auth-form');
    const birthDateInput = form.querySelector('[name="birthDate"]');
    birthDateInput.addEventListener('input', () => {
      const digits = birthDateInput.value.replace(/\D/g, '').slice(0, 8);
      birthDateInput.value = digits.replace(/^(\d{2})(\d)/, '$1/$2').replace(/^(\d{2}\/\d{2})(\d)/, '$1/$2');
    });
    const switchMode = (next) => {
      mode = next;
      content.querySelectorAll('[data-auth-tab]').forEach((item) => { item.classList.toggle('active', item.dataset.authTab === next); });
      extra.hidden = mode !== 'register';
      extra.querySelectorAll('input,select').forEach((item) => { item.required = mode === 'register' && item.name !== 'gender'; });
      form.querySelector('[name="password"]').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
      content.querySelector('#global-auth-submit').textContent = mode === 'register' ? 'Create account ↗' : 'Sign in ↗';
    };
    content.querySelectorAll('[data-auth-tab]').forEach((item) => item.addEventListener('click', () => switchMode(item.dataset.authTab)));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (busy) return;
      busy = true;
      showError('');
      const formData = new FormData(form);
      const nickname = String(formData.get('nickname') || '').trim();
      const password = String(formData.get('password') || '');
      const body = { nickname, password };
      if (mode === 'register') {
        const birthDate = toIsoBirthDate(formData.get('birthDate'));
        if (!birthDate) { showError('Enter a valid date as DD/MM/YYYY.'); busy = false; return; }
        Object.assign(body, {
          birthDate, language: formData.get('language'), country: String(formData.get('country') || '').toUpperCase(),
          gender: formData.get('gender'), accepted: true,
        });
      }
      try {
        const result = await api(baseUrl, `/api/global/${mode}`, { method: 'POST', body });
        token = result.token;
        user = result.user;
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token, user }));
        renderFeed();
        await loadMessages();
        timer = setInterval(loadMessages, 4000);
      } catch (error) { showError(error.message); }
      finally { busy = false; }
    });
  };

  const renderFeed = () => {
    content.innerHTML = `<div class="global-feed-head"><div><strong>Public group chat</strong><small>Signed in as ${escapeHtml(user.nickname)}</small></div><div><button id="global-delete-account" type="button">Delete account</button> <button id="global-signout" type="button">Sign out</button></div></div><div class="global-feed" id="global-feed" aria-live="polite"></div><form id="global-compose" class="global-compose"><label class="sr-only" for="global-message">Write a public message</label><textarea id="global-message" name="body" maxlength="${MAX_MESSAGE}" rows="2" placeholder="Write a public message…" required></textarea><div><small><span id="global-count">0</span> / ${MAX_MESSAGE} · visible to everyone</small><button class="space-primary" type="submit">Send ↗</button></div></form><small class="global-privacy">Messages are stored for up to 7 days. This feed is separate from private rooms and calls.</small>`;
    content.querySelector('#global-signout').addEventListener('click', async () => {
      clearInterval(timer); timer = null;
      try { await api(baseUrl, '/api/global/session', { token, method: 'DELETE' }); } catch {}
      sessionStorage.removeItem(SESSION_KEY); token = ''; user = null; messages = []; renderAuth();
    });
    content.querySelector('#global-delete-account').addEventListener('click', async () => {
      if (!window.confirm('Delete your account and remove your messages, reports, and blocks? This cannot be undone.')) return;
      try { await api(baseUrl, '/api/global/account', { token, method: 'DELETE' }); }
      catch (error) { showError(error.message); return; }
      clearInterval(timer); timer = null; sessionStorage.removeItem(SESSION_KEY); token = ''; user = null; messages = []; renderAuth();
    });
    const textarea = content.querySelector('#global-message');
    textarea.addEventListener('input', () => { content.querySelector('#global-count').textContent = String(textarea.value.length); });
    textarea.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); content.querySelector('#global-compose').requestSubmit(); } });
    content.querySelector('#global-compose').addEventListener('submit', async (event) => {
      event.preventDefault();
      const body = textarea.value.trim();
      if (!body || busy) return;
      busy = true;
      const send = content.querySelector('#global-compose button'); send.disabled = true;
      try { await api(baseUrl, '/api/global/messages', { token, method: 'POST', body: { body } }); textarea.value = ''; content.querySelector('#global-count').textContent = '0'; await loadMessages(); }
      catch (error) { showError(error.message); }
      finally { busy = false; if (send.isConnected) send.disabled = false; }
    });
  };

  const loadMessages = async () => {
    if (!token || loadingMessages || !content.querySelector('#global-feed')) return;
    loadingMessages = true;
    try {
      const result = await api(baseUrl, '/api/global/messages', { token });
      messages = Array.isArray(result.messages) ? result.messages : [];
      const feed = content.querySelector('#global-feed');
      if (!feed) return;
      feed.innerHTML = messages.length ? messages.map((item) => `<article class="global-message"><header><strong>${escapeHtml(item.nickname)}</strong><time>${new Date(item.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</time></header><p>${escapeHtml(item.body).replace(/\n/g, '<br>')}</p><div class="global-message-actions">${item.nickname === user.nickname ? `<button type="button" data-delete="${item.id}">Delete</button>` : `<button type="button" data-report="${item.id}">Report</button><button type="button" data-block="${item.id}">Block this person</button>`}</div></article>`).join('') : `<div class="global-empty"><span>◎</span><strong>The public room is quiet</strong><small>Start a respectful conversation. Your message will be visible to everyone here.</small></div>`;
      feed.querySelectorAll('[data-delete]').forEach((button) => button.addEventListener('click', async () => {
        try { await api(baseUrl, `/api/global/messages/${button.dataset.delete}`, { token, method: 'DELETE' }); await loadMessages(); } catch (error) { showError(error.message); }
      }));
      feed.querySelectorAll('[data-report]').forEach((button) => button.addEventListener('click', async () => {
        const reason = window.prompt('Why report this message? Type spam, harassment, personal_info, or other.', 'other');
        if (!['spam', 'harassment', 'personal_info', 'other'].includes(reason)) return;
        try { await api(baseUrl, `/api/global/messages/${button.dataset.report}/report`, { token, method: 'POST', body: { reason } }); button.textContent = 'Reported'; button.disabled = true; } catch (error) { showError(error.message); }
      }));
      feed.querySelectorAll('[data-block]').forEach((button) => button.addEventListener('click', async () => {
        if (!window.confirm('Hide this person’s future messages from your feed?')) return;
        try { await api(baseUrl, `/api/global/messages/${button.dataset.block}/block`, { token, method: 'POST', body: {} }); await loadMessages(); }
        catch (error) { showError(error.message); }
      }));
      feed.scrollTop = feed.scrollHeight;
      showError('');
    } catch (error) {
      if (error.message === 'Your session expired. Sign in again.') {
        clearInterval(timer);
        timer = null;
        sessionStorage.removeItem(SESSION_KEY);
        token = '';
        user = null;
        messages = [];
        renderAuth();
        showError(error.message);
        return;
      }
      showError(error.message);
    } finally {
      loadingMessages = false;
    }
  };

  const restore = () => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
      if (saved?.token && saved?.user?.nickname) { token = saved.token; user = saved.user; renderFeed(); loadMessages(); timer = setInterval(loadMessages, 4000); return; }
    } catch { sessionStorage.removeItem(SESSION_KEY); }
    renderAuth();
  };
  if (!baseUrl) {
    content.innerHTML = `<div class="global-notice"><span class="global-symbol">↗</span><h3>Global Chat needs its service</h3><p>This website is hosted on GitHub Pages, which cannot store a live shared public chat by itself. The Cloudflare Worker and D1 database have to be deployed and connected before this feature can go online.</p><small class="global-privacy">No messages are being sent or stored from this screen.</small></div>`;
  } else {
    content.innerHTML = `<div class="global-notice"><span class="global-symbol">◎</span><h3>Connecting to Global Chat</h3><p>Checking whether the shared chat service is ready…</p></div>`;
    api(baseUrl, '/api/global/status').then((result) => {
      if (!result.enabled || !layer.isConnected) return;
      if (sessionStorage.getItem('near-global-consent-v1') === 'yes') restore();
      else renderNotice();
    }).catch(() => {
      if (!layer.isConnected) return;
      content.innerHTML = `<div class="global-notice"><span class="global-symbol">↗</span><h3>Global Chat is not ready yet</h3><p>The shared service or its database migration has not been deployed. The site owner needs to update the Cloudflare Worker, apply its D1 migration, and connect the Worker URL to the website.</p><small class="global-privacy">No messages are being sent or stored from this screen.</small></div>`;
    });
  }
}
