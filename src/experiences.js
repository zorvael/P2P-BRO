const CAPSULES_KEY = 'near-time-capsules-v1';
const MAX_EXPERIENCE_BYTES = 24_000;
const MAX_STROKES = 160;
const MAX_POINTS = 160;

export const TRUST_QUESTIONS = {
  friendship: ['What small thing makes you feel appreciated?', 'What does a good friend do when life gets busy?'],
  gettingToKnowYou: ['What is something you could talk about for hours?', 'What kind of day helps you feel most like yourself?'],
  reflection: ['What is one thing you are proud of lately?', 'What would you like to make more room for this month?'],
  light: ['What fictional place would you visit for a day?', 'What tiny hill are you willing to die on?'],
};

export function isValidExperiencePacket(packet) {
  if (!packet || typeof packet !== 'object' || packet.type !== 'experience' || typeof packet.feature !== 'string' || typeof packet.action !== 'string') return false;
  try { return JSON.stringify(packet).length <= MAX_EXPERIENCE_BYTES; } catch { return false; }
}

export function capsuleStatus(capsule, now = Date.now()) {
  if (!capsule || capsule.openedAt) return 'opened';
  const target = Date.parse(capsule.unlockAt);
  if (!Number.isFinite(target)) return 'sealed';
  return target <= now ? 'ready to unlock' : 'waiting';
}

export function createCapsule({ title, content, unlockAt, kind = 'text', photoData = '' }, now = Date.now()) {
  const target = Date.parse(unlockAt);
  if (typeof title !== 'string' || !title.trim() || title.length > 80) throw new Error('Add a short capsule title.');
  if (typeof content !== 'string' || content.length > 5000 || (!content.trim() && !photoData)) throw new Error('Write a message or attach a small photo.');
  if (!Number.isFinite(target) || target <= now) throw new Error('Choose a future date and time.');
  if (!['text', 'photo'].includes(kind)) throw new Error('Unsupported capsule type.');
  if (photoData && (typeof photoData !== 'string' || photoData.length > 250_000 || !/^data:image\/(?:jpeg|png|webp);base64,/.test(photoData))) throw new Error('Photo must be a JPG, PNG, or WebP smaller than 180 KB.');
  return { id: globalThis.crypto?.randomUUID?.() || `${now}-${Math.random().toString(36).slice(2)}`, title: title.trim(), content, kind, photoData, unlockAt: new Date(target).toISOString(), createdAt: new Date(now).toISOString(), openedAt: '' };
}

export function createTrustGate(getParticipants) {
  let category = 'friendship';
  let revealed = false;
  const submissions = new Map();
  const currentParticipants = () => [...new Set(getParticipants())].slice(0, 4);
  const revealWhenReady = () => {
    const participants = currentParticipants();
    if (revealed || !participants.every((id) => submissions.has(id))) return null;
    revealed = true;
    return { category, answers: Object.fromEntries(participants.map((id) => [id, submissions.get(id)])) };
  };
  return {
    setCategory(value) {
      if (revealed || submissions.size || !Object.hasOwn(TRUST_QUESTIONS, value)) return false;
      category = value;
      return true;
    },
    submit({ participant, category: submittedCategory, answers }) {
      if (revealed || !currentParticipants().includes(participant) || submissions.has(participant) || submittedCategory !== category || !Array.isArray(answers) || answers.length !== 2 || answers.some((answer) => typeof answer !== 'string' || answer.length > 500)) return { accepted: false, reveal: null };
      submissions.set(participant, [...answers]);
      return { accepted: true, reveal: revealWhenReady() };
    },
    leave(participant) {
      submissions.delete(participant);
      return revealWhenReady();
    },
    status() { return { category, submitted: [...submissions.keys()], revealed }; },
  };
}

function readCapsules() {
  try {
    const saved = JSON.parse(localStorage.getItem(CAPSULES_KEY) || '[]');
    return Array.isArray(saved) ? saved.filter((item) => item && typeof item.id === 'string' && typeof item.unlockAt === 'string' && typeof item.content === 'string') : [];
  } catch { return []; }
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

export function openExperiences({ roomId, name, peers = [], send = () => {}, isHost = false, onBookmark = () => {} }) {
  let capsules = readCapsules();
  let selected = 'capsule';
  let selectedCategory = 'friendship';
  let clock;
  let connection;
  let offlineChannel;
  let roomState = { moments: [], story: [], strokes: [], trust: null };
  const seen = new Set();
  const trustGate = createTrustGate(() => [localPeerId(), ...participantPeers().filter((peer) => peer.id !== localPeerId()).map((peer) => peer.id)]);
  const layer = document.createElement('div');
  layer.className = 'experiences-layer';
  layer.innerHTML = `<section class="experiences-card" role="dialog" aria-modal="true" aria-labelledby="experiences-title"><header class="experiences-heading"><div><span class="space-kicker">A LITTLE MORE TOGETHER</span><h2 id="experiences-title">Experiences</h2></div><button type="button" class="space-close" aria-label="Close experiences">×</button></header><nav class="experience-tabs" aria-label="Experiences">${[['capsule','Time capsule'],['moment','Shared moment'],['pass','Pass the moment'],['mirror','Trust mirror'],['offline','Internet-free']].map(([id,label])=>`<button type="button" data-experience-tab="${id}">${label}</button>`).join('')}</nav><div class="experience-content"></div></section>`;
  const content = layer.querySelector('.experience-content');
  const tabs = layer.querySelector('.experience-tabs');
  const participantPeers = () => typeof peers === 'function' ? peers() : peers;

  function close() {
    clearInterval(clock);
    if (offlineChannel) offlineChannel.close();
    if (connection) connection.close();
    layer.remove();
  }
  layer.querySelector('.space-close').addEventListener('click', close);
  layer.addEventListener('click', (event) => { if (event.target === layer) close(); });
  layer.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
  tabs.addEventListener('click', (event) => {
    const button = event.target.closest('[data-experience-tab]');
    if (button) render(button.dataset.experienceTab);
  });

  function render(tab = selected) {
    if (!layer.isConnected) return;
    selected = tab;
    clearInterval(clock);
    tabs.querySelectorAll('button').forEach((button) => {
      const active = button.dataset.experienceTab === selected;
      button.classList.toggle('active', active);
      button.setAttribute('aria-current', String(active));
    });
    if (selected === 'capsule') renderCapsule();
    if (selected === 'moment') renderMoment();
    if (selected === 'pass') renderPass();
    if (selected === 'mirror') renderMirror();
    if (selected === 'offline') renderOffline();
  }

  function renderCapsule() {
    content.innerHTML = `<div class="experience-intro"><span class="experience-icon">⌛</span><div><h3>A note for a future day</h3><p>Personal prototype · kept in this browser only. The countdown is cosmetic; your device clock controls the unlock, so this is not a secure lock.</p></div></div><form id="capsule-form" class="experience-form"><label>CAPSULE TITLE<input name="title" maxlength="80" placeholder="A birthday note, a prediction…" required /></label><label>UNLOCK DATE AND TIME<input name="unlockAt" type="datetime-local" required /></label><label>YOUR MESSAGE<textarea name="content" maxlength="5000" placeholder="Write to your future self…"></textarea></label><label>OPTIONAL PHOTO<input name="photo" type="file" accept="image/jpeg,image/png,image/webp" /></label><small class="experience-disclaimer">A photo must be JPG, PNG, or WebP under 180 KB. Photos are saved only in this browser.</small><button class="space-primary" type="submit">Seal on this device ↗</button></form><div class="capsule-list">${capsules.length ? capsules.map((capsule) => capsuleCard(capsule)).join('') : '<p class="experience-empty">No capsules yet. Make a small promise to your future self.</p>'}</div>`;
    content.querySelector('#capsule-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      try {
        const file = data.get('photo');
        const photoData = file?.size ? await new Promise((resolve, reject) => { if (file.size > 180_000 || !/^image\/(?:jpeg|png|webp)$/.test(file.type)) return reject(new Error('Photo must be a JPG, PNG, or WebP smaller than 180 KB.')); const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Could not read that photo.')); reader.readAsDataURL(file); }) : '';
        const capsule = createCapsule({ title: data.get('title'), content: data.get('content'), unlockAt: data.get('unlockAt'), kind: photoData ? 'photo' : 'text', photoData });
        capsules.unshift(capsule);
        localStorage.setItem(CAPSULES_KEY, JSON.stringify(capsules));
        render('capsule');
      } catch (error) { feedback(error.message); }
    });
    content.querySelectorAll('[data-capsule-open]').forEach((button) => button.addEventListener('click', () => {
      const capsule = capsules.find((item) => item.id === button.dataset.capsuleOpen);
      if (!capsule || capsuleStatus(capsule) !== 'ready to unlock') return feedback('This capsule is still waiting for its date.');
      capsule.openedAt = new Date().toISOString();
      localStorage.setItem(CAPSULES_KEY, JSON.stringify(capsules));
      render('capsule');
    }));
    content.querySelectorAll('[data-capsule-delete]').forEach((button) => button.addEventListener('click', () => {
      capsules = capsules.filter((item) => item.id !== button.dataset.capsuleDelete);
      localStorage.setItem(CAPSULES_KEY, JSON.stringify(capsules)); render('capsule');
    }));
    clock = setInterval(() => content.querySelectorAll('[data-countdown]').forEach((node) => {
      const item = capsules.find((capsule) => capsule.id === node.dataset.countdown);
      if (item) node.textContent = capsuleStatus(item) === 'waiting' ? countdown(item.unlockAt) : capsuleStatus(item);
    }), 1000);
  }

  function capsuleCard(capsule) {
    const status = capsuleStatus(capsule);
    return `<article class="capsule-card"><div><small>${escapeHtml(status.toUpperCase())} · ${new Date(capsule.unlockAt).toLocaleString()}</small><h4>${escapeHtml(capsule.title)}</h4><p>${status === 'opened' ? escapeHtml(capsule.content) : 'Your words are kept on this device.'}</p>${status === 'opened' && capsule.photoData ? `<img class="capsule-photo" src="${escapeHtml(capsule.photoData)}" alt="Photo saved in ${escapeHtml(capsule.title)}" />` : ''}<b data-countdown="${escapeHtml(capsule.id)}">${status === 'waiting' ? countdown(capsule.unlockAt) : status}</b></div><div class="experience-actions">${status === 'ready to unlock' ? `<button type="button" data-capsule-open="${escapeHtml(capsule.id)}">Open capsule</button>` : ''}<button type="button" data-capsule-delete="${escapeHtml(capsule.id)}">Delete</button></div></article>`;
  }

  function renderMoment() {
    const canShare = Boolean(roomId);
    content.innerHTML = `<div class="experience-intro"><span class="experience-icon">✳</span><div><h3>Keep one moment</h3><p>Nothing is recorded. Add a bookmark and an optional note to this live room’s shared timeline.</p></div></div><div class="moment-tools"><button class="space-primary" id="bookmark-moment" type="button" ${canShare ? '' : 'disabled'}>✳ Bookmark now</button><button class="experience-secondary" id="export-moments" type="button">Export timeline</button></div><form id="moment-form" class="experience-form"><label>ADD A NOTE<input name="text" maxlength="500" placeholder="What should everyone remember?" required /></label><button class="experience-secondary" type="submit" ${canShare ? '' : 'disabled'}>Add to shared timeline</button></form><div class="moment-list">${roomState.moments.length ? roomState.moments.map((item) => `<article class="moment-item"><time>${new Date(item.at).toLocaleString()}</time><strong>${escapeHtml(item.name)}</strong><p>${escapeHtml(item.text)}</p>${item.authorId === localPeerId() ? `<button type="button" data-moment-delete="${escapeHtml(item.id)}">Remove</button>` : ''}</article>`).join('') : '<p class="experience-empty">No moments yet. Bookmark something you want to remember.</p>'}</div><small class="experience-disclaimer">Shared only with connected room participants through the room host. Contributions are temporary and disappear when the room ends.</small>`;
    content.querySelector('#bookmark-moment').addEventListener('click', () => { onBookmark(); addMoment('✳ A moment was bookmarked.'); });
    content.querySelector('#moment-form').addEventListener('submit', (event) => { event.preventDefault(); const text = new FormData(event.currentTarget).get('text').trim(); if (text) addMoment(text); });
    content.querySelector('#export-moments').addEventListener('click', exportMoments);
    content.querySelectorAll('[data-moment-delete]').forEach((button) => button.addEventListener('click', () => publish({ feature: 'moment', action: 'delete', id: button.dataset.momentDelete, authorId: localPeerId(), eventId: randomId() })));
  }

  function renderPass() {
    content.innerHTML = `<div class="experience-intro"><span class="experience-icon">↗</span><div><h3>Pass the moment</h3><p>A tiny turn-based story for the live room. Each connected person adds a line in sequence.</p></div></div><div class="pass-turn"><small>ROOM STORY · ${roomState.story.length} LINES</small>${roomState.story.length ? roomState.story.map((line, i) => `<p><b>${i + 1}. ${escapeHtml(line.name)}</b> ${escapeHtml(line.text)}</p>`).join('') : '<p class="experience-empty">Start a story together. The next person gets the next turn.</p>'}</div><form id="story-form" class="experience-form"><label>YOUR NEXT LINE<textarea name="text" maxlength="240" placeholder="Continue the story in one sentence…" required></textarea></label><button class="space-primary" type="submit" ${roomId ? '' : 'disabled'}>Pass the moment →</button></form><div class="canvas-wrap"><div><h4>Collaborative doodle</h4><small>Draw and submit a stroke to the room. No drawing is sent until you submit.</small></div><canvas id="moment-canvas" width="700" height="260" aria-label="Collaborative drawing canvas"></canvas><button class="experience-secondary" id="submit-stroke" type="button">Share my stroke</button></div><small class="experience-disclaimer">Room updates are temporary in memory. If all peers leave, the story and drawing are gone.</small>`;
    const form = content.querySelector('#story-form');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = new FormData(form).get('text').trim();
      if (!text || roomState.story.length >= 100) return;
      const turn = roomState.story.length;
      publish({ feature: 'pass', action: 'story', line: { id: randomId(), name, text, at: Date.now() } });
    });
    const canvas = content.querySelector('#moment-canvas');
    drawStrokes(canvas, roomState.strokes);
    let activeStroke = [];
    let drawing = false;
    const point = (event) => { const rect = canvas.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }; };
    canvas.addEventListener('pointerdown', (event) => { drawing = true; activeStroke = [point(event)]; canvas.setPointerCapture(event.pointerId); });
    canvas.addEventListener('pointermove', (event) => { if (drawing && activeStroke.length < MAX_POINTS) { activeStroke.push(point(event)); drawStrokes(canvas, [...roomState.strokes, { points: activeStroke }]); } });
    canvas.addEventListener('pointerup', () => { drawing = false; });
    content.querySelector('#submit-stroke').addEventListener('click', () => {
      if (activeStroke.length < 2) return feedback('Draw a short line before sharing it.');
      publish({ feature: 'pass', action: 'stroke', stroke: { id: randomId(), name, points: activeStroke.slice(0, MAX_POINTS) } }); activeStroke = [];
    });
  }

  function renderMirror() {
    const questions = TRUST_QUESTIONS.friendship;
    const participants = [{ id: localPeerId(), name }, ...participantPeers().filter((peer) => peer.id !== localPeerId())].slice(0, 4);
    const submitted = roomState.trust?.submitted || [];
    const revealed = roomState.trust?.revealed;
    content.innerHTML = `<div class="experience-intro"><span class="experience-icon">◌</span><div><h3>Trust mirror</h3><p>Optional reflection. No scores or judgments. Answers are held by the room host in memory and revealed only after every participant submits.</p></div></div><label class="space-label" for="trust-category">QUESTION SET · CHOSEN BY ROOM HOST</label><select id="trust-category" class="experience-select" ${isHost ? '' : 'disabled'}>${Object.entries(TRUST_QUESTIONS).map(([key]) => `<option value="${key}" ${key === selectedCategory ? 'selected' : ''}>${({ friendship:'Friendship', gettingToKnowYou:'Getting to know you', reflection:'Personal reflection', light:'Lighthearted' })[key]}</option>`).join('')}</select><div class="trust-questions">${(TRUST_QUESTIONS[selectedCategory] || questions).map((question, index) => `<label>${escapeHtml(question)}<textarea data-answer="${index}" maxlength="500" placeholder="Skip by leaving this blank"></textarea></label>`).join('')}</div><label class="trust-consent"><input id="trust-consent" type="checkbox" ${submitted.includes(localPeerId()) || revealed ? 'disabled' : ''} /><span>I’m choosing to participate. I understand the room host can view submitted answers.</span></label><button id="submit-trust" class="space-primary" type="button" ${submitted.includes(localPeerId()) || revealed ? 'disabled' : ''}>Submit answers privately</button><div class="trust-status">${revealed ? `<h4>Everyone has chosen to share</h4>${participants.map((person) => `<article><strong>${escapeHtml(person.name)}</strong>${revealed[person.id]?.map((answer, i) => `<p><small>${escapeHtml(TRUST_QUESTIONS[roomState.trust?.category]?.[i] || '')}</small><br>${escapeHtml(answer || 'Skipped')}</p>`).join('') || '<p>Answers not available.</p>'}</article>`).join('')}` : `<p>${submitted.length} of ${participants.length} participants have submitted. Nothing is revealed until all have submitted.</p>`}</div><small class="experience-disclaimer">Participation is voluntary. Skip by leaving an answer blank or leave the room.</small>`;
    const trustSubmit = content.querySelector('#submit-trust');
    trustSubmit.disabled = submitted.includes(localPeerId()) || Boolean(revealed);
    content.querySelector('#trust-consent').addEventListener('change', (event) => { trustSubmit.disabled = !event.target.checked || submitted.includes(localPeerId()) || Boolean(revealed); });
    content.querySelector('#trust-category').addEventListener('change', (event) => {
      if (roomState.trust?.submitted?.length) { feedback('The question set is fixed after the first answer is submitted.'); render('mirror'); return; }
      if (isHost && !trustGate.setCategory(event.target.value)) { feedback('The question set is already fixed.'); render('mirror'); return; }
      selectedCategory = event.target.value;
      publish({ feature: 'mirror', action: 'category', category: selectedCategory });
      render('mirror');
    });
    content.querySelector('#submit-trust').addEventListener('click', () => {
      if (!content.querySelector('#trust-consent').checked) return feedback('Confirm you understand the host can see the response before submitting.');
      const category = content.querySelector('#trust-category').value;
      const answers = [...content.querySelectorAll('[data-answer]')].map((input) => input.value.trim().slice(0, 500));
      if (!answers.some(Boolean)) return feedback('Add an answer or skip this reflection.');
      roomState.trust ||= { submitted: [], answers: {}, revealed: null, category };
      if (isHost) acceptTrust({ feature: 'mirror', action: 'submit', category, answers, participant: localPeerId(), name });
      else { roomState.trust.submitted.push(localPeerId()); roomState.trust.category = category; send({ feature: 'mirror', action: 'submit', category, answers, participant: localPeerId(), name }); }
      render('mirror');
      feedback('Your answers are submitted. The group sees them only when everyone has submitted.');
    });
  }

  function renderOffline() {
    content.innerHTML = `<div class="experience-intro"><span class="experience-icon">⌁</span><div><h3>Internet-free room</h3><p>Experimental local WebRTC data channel. This uses no STUN or TURN server and does not discover nearby devices. You must exchange connection text yourself.</p></div></div><ol class="offline-instructions"><li>Both devices open Near over HTTPS and stay on this screen.</li><li>One device creates an offer and shares it privately with the other person.</li><li>The other device pastes the offer, creates an answer, and sends that answer back.</li><li>The first device pastes the answer. A direct local route may still be unavailable on some networks.</li></ol><div class="offline-controls"><button class="space-primary" id="offline-offer" type="button">Create offer</button><button class="experience-secondary" id="offline-answer" type="button">Answer an offer</button></div><label class="space-label" for="offline-sdp">CONNECTION TEXT <small>(contains temporary connection data)</small></label><textarea id="offline-sdp" class="offline-sdp" spellcheck="false" placeholder="Offer or answer appears here. Share it only with the intended person."></textarea><div class="offline-controls"><button class="experience-secondary" id="offline-connect" type="button">Apply answer</button><button class="experience-secondary" id="offline-copy" type="button">Copy connection text</button><button class="experience-secondary" id="offline-close" type="button">Close local link</button></div><p id="offline-status" class="offline-status">Not connected · no files are uploaded. Keep this tab open during setup.</p><div id="offline-chat" class="offline-chat"></div><form id="offline-form" class="experience-form"><label>LOCAL MESSAGE<input name="text" maxlength="1000" placeholder="Message nearby over the local data channel…" required /></label><button class="space-primary" type="submit" disabled>Send locally</button></form><small class="experience-disclaimer">The page itself must already be available on each device. Local connectivity depends on browser and network support; no universal Wi-Fi Direct or Bluetooth discovery is available here. Messages/files are not saved after disconnect.</small>`;
    const sdp = content.querySelector('#offline-sdp');
    const status = content.querySelector('#offline-status');
    const form = content.querySelector('#offline-form');
    const sendButton = form.querySelector('button');
    const log = (text) => { const line = document.createElement('p'); line.textContent = text; content.querySelector('#offline-chat').append(line); };
    const updateStatus = () => { if (offlineChannel?.readyState === 'open') { status.textContent = 'Connected · local WebRTC data channel'; sendButton.disabled = false; } else { status.textContent = offlineChannel?.readyState === 'connecting' ? 'Connecting locally…' : 'Not connected · no files are uploaded. Keep this tab open during setup.'; sendButton.disabled = true; } };
    const waitIce = (pc) => new Promise((resolve, reject) => { if (pc.iceGatheringState === 'complete') return resolve(); const timeout = setTimeout(() => { pc.removeEventListener('icegatheringstatechange', done); reject(new Error('ICE candidate gathering timed out')); }, 12_000); const done = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(timeout); pc.removeEventListener('icegatheringstatechange', done); resolve(); } }; pc.addEventListener('icegatheringstatechange', done); });
    const channel = (dataChannel) => { offlineChannel = dataChannel; dataChannel.onopen = updateStatus; dataChannel.onclose = updateStatus; dataChannel.onmessage = (event) => { try { const packet = JSON.parse(event.data); if (packet.type === 'text' && typeof packet.text === 'string' && packet.text.length <= 1000) log(`Them: ${packet.text}`); else if (packet.type === 'file' && packet.name && packet.data && packet.data.length < 1_400_000) { const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([Uint8Array.from(atob(packet.data), (c) => c.charCodeAt(0))], { type: 'application/octet-stream' })); link.download = String(packet.name).slice(0, 100); link.textContent = `Download ${link.download}`; content.querySelector('#offline-chat').append(link); } } catch {} }; };
    const createConnection = () => { connection?.close(); const pc = new RTCPeerConnection({ iceServers: [] }); pc.ondatachannel = (event) => channel(event.channel); pc.oniceconnectionstatechange = updateStatus; return pc; };
    content.querySelector('#offline-offer').addEventListener('click', async () => { try { connection = createConnection(); channel(connection.createDataChannel('near-local', { ordered: true })); await connection.setLocalDescription(await connection.createOffer()); await waitIce(connection); sdp.value = JSON.stringify(connection.localDescription); status.textContent = 'Offer ready. Share it privately, then paste back the answer.'; } catch { feedback('This browser could not create a local WebRTC offer.'); } });
    content.querySelector('#offline-answer').addEventListener('click', async () => { try { const offer = JSON.parse(sdp.value); if (!offer?.type || typeof offer.sdp !== 'string' || offer.sdp.length > 20_000) throw new Error(); connection = createConnection(); await connection.setRemoteDescription(offer); await connection.setLocalDescription(await connection.createAnswer()); await waitIce(connection); sdp.value = JSON.stringify(connection.localDescription); status.textContent = 'Answer ready. Send it back to the person who made the offer.'; } catch { feedback('Paste a valid offer first.'); } });
    content.querySelector('#offline-connect').addEventListener('click', async () => { try { const answer = JSON.parse(sdp.value); if (!answer?.type || typeof answer.sdp !== 'string' || answer.sdp.length > 20_000) throw new Error(); await connection?.setRemoteDescription(answer); updateStatus(); } catch { feedback('Could not apply that answer. Check the copied connection text.'); } });
    content.querySelector('#offline-copy').addEventListener('click', () => navigator.clipboard.writeText(sdp.value).then(() => feedback('Connection text copied. Share it only with the intended person.')).catch(() => feedback('Clipboard access is unavailable.')));
    content.querySelector('#offline-close').addEventListener('click', () => { offlineChannel?.close(); connection?.close(); offlineChannel = null; connection = null; updateStatus(); });
    form.addEventListener('submit', (event) => { event.preventDefault(); const text = new FormData(form).get('text').trim(); if (!offlineChannel || offlineChannel.readyState !== 'open' || !text) return; try { offlineChannel.send(JSON.stringify({ type: 'text', text })); log(`You: ${text}`); form.reset(); } catch { feedback('Message could not be sent.'); } });
  }

  function localPeerId() { return window.nearPeerId || (isHost ? roomId : 'me'); }
  function publish(packet) { packet.eventId ||= randomId(); if (!isValidExperiencePacket({ type: 'experience', ...packet })) return feedback('That update is too large to share.'); if (seen.has(packet.eventId)) return; seen.add(packet.eventId); apply(packet); send(packet); }
  function addMoment(text) { publish({ feature: 'moment', action: 'add', item: { id: randomId(), authorId: localPeerId(), name, text: text.slice(0, 500), at: Date.now() } }); }
  function apply(packet) {
    if (!packet || typeof packet !== 'object') return;
    if (packet.eventId) { if (seen.has(packet.eventId)) return; seen.add(packet.eventId); }
    if (packet.feature === 'moment' && packet.action === 'add' && packet.item && typeof packet.item.text === 'string' && packet.item.text.length <= 500 && !roomState.moments.some((item) => item.id === packet.item.id)) roomState.moments.push(packet.item);
    if (packet.feature === 'moment' && packet.action === 'delete') roomState.moments = roomState.moments.filter((item) => item.id !== packet.id || item.authorId !== packet.authorId);
    if (packet.feature === 'pass' && packet.action === 'story' && packet.line && typeof packet.line.text === 'string' && packet.line.text.length <= 240 && !roomState.story.some((line) => line.id === packet.line.id) && roomState.story.length < 100) roomState.story.push(packet.line);
    if (packet.feature === 'pass' && packet.action === 'stroke' && packet.stroke && Array.isArray(packet.stroke.points) && packet.stroke.points.length <= MAX_POINTS && roomState.strokes.length < MAX_STROKES && !roomState.strokes.some((stroke) => stroke.id === packet.stroke.id)) roomState.strokes.push(packet.stroke);
    if (packet.feature === 'mirror' && packet.action === 'reveal' && packet.answers && typeof packet.answers === 'object') roomState.trust = { submitted: Object.keys(packet.answers), revealed: packet.answers, category: packet.category || 'friendship' };
    if (packet.feature === 'mirror' && packet.action === 'category' && Object.hasOwn(TRUST_QUESTIONS, packet.category)) { trustGate.setCategory(packet.category); selectedCategory = packet.category; roomState.trust = { submitted: [], answers: {}, category: packet.category, revealed: null }; }
    if ((selected === 'moment' && packet.feature === 'moment') || (selected === 'pass' && packet.feature === 'pass') || (selected === 'mirror' && packet.feature === 'mirror')) render(selected);
  }
  function acceptTrust(packet) {
    const result = trustGate.submit({ participant: packet.participant, category: packet.category, answers: packet.answers });
    if (!result.accepted) return;
    roomState.trust = { ...trustGate.status(), answers: roomState.trust?.answers || {}, revealed: null };
    if (result.reveal) {
      const reveal = { feature: 'mirror', action: 'reveal', answers: result.reveal.answers, category: result.reveal.category };
      apply(reveal); send(reveal);
    } else render('mirror');
  }
  function receive(packet, fromPeerId) {
    if (!isValidExperiencePacket({ type: 'experience', ...packet })) return;
    if (isHost && packet.feature === 'mirror' && packet.action === 'reveal') return;
    if (isHost && packet.feature === 'mirror' && packet.action === 'category') return;
    if (packet.feature === 'mirror' && packet.action === 'submit') {
      if (!isHost || !participantPeers().some((peer) => peer.id === fromPeerId)) return;
      acceptTrust({ ...packet, participant: fromPeerId });
      return;
    }
    if (isHost && fromPeerId) {
      const sender = participantPeers().find((peer) => peer.id === fromPeerId);
      if (packet.feature === 'moment' && packet.action === 'add' && packet.item) packet = { ...packet, item: { ...packet.item, authorId: fromPeerId, name: sender?.name || 'Guest' } };
      if (packet.feature === 'moment' && packet.action === 'delete' && packet.authorId !== fromPeerId) return;
      if (packet.feature === 'pass' && packet.action === 'story' && packet.line) packet = { ...packet, line: { ...packet.line, name: sender?.name || 'Guest' } };
      if (packet.feature === 'pass' && packet.action === 'stroke' && packet.stroke) packet = { ...packet, stroke: { ...packet.stroke, name: sender?.name || 'Guest' } };
    }
    if (packet.feature === 'mirror' && packet.action === 'reveal' && !isHost) { apply(packet); return; }
    apply(packet);
  }
  function exportMoments() {
    const data = JSON.stringify({ room: roomId, exportedAt: new Date().toISOString(), moments: roomState.moments }, null, 2);
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([data], { type: 'application/json' })); link.download = 'near-shared-moments.json'; link.click(); URL.revokeObjectURL(link.href);
  }
  function drawStrokes(canvas, strokes) {
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.strokeStyle = '#526b51'; ctx.lineWidth = 3; ctx.lineCap = 'round';
    for (const stroke of strokes) { if (!Array.isArray(stroke.points) || stroke.points.length < 2) continue; ctx.beginPath(); stroke.points.slice(0, MAX_POINTS).forEach((point, index) => { const x = Math.max(0, Math.min(1, Number(point.x) || 0)) * canvas.width; const y = Math.max(0, Math.min(1, Number(point.y) || 0)) * canvas.height; if (index) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.stroke(); }
  }
  function countdown(targetAt) { let seconds = Math.max(0, Math.floor((Date.parse(targetAt) - Date.now()) / 1000)); const days = Math.floor(seconds / 86400); seconds %= 86400; const hours = Math.floor(seconds / 3600); seconds %= 3600; const mins = Math.floor(seconds / 60); return `${days}d ${hours}h ${mins}m`; }
  function feedback(message) { let node = layer.querySelector('.experience-feedback'); if (!node) { node = document.createElement('p'); node.className = 'experience-feedback'; layer.querySelector('.experiences-card').append(node); } node.textContent = message; }

  function snapshot() {
    return { moments: roomState.moments.slice(-80), story: roomState.story.slice(-80), strokes: roomState.strokes.slice(-8).map((stroke) => ({ ...stroke, points: stroke.points.slice(0, 40) })), trust: roomState.trust?.revealed ? { submitted: roomState.trust.submitted, revealed: roomState.trust.revealed, category: roomState.trust.category } : roomState.trust ? { submitted: roomState.trust.submitted, category: roomState.trust.category } : null };
  }
  function restore(value) {
    if (!value || typeof value !== 'object') return;
    roomState.moments = Array.isArray(value.moments) ? value.moments.slice(-80) : [];
    roomState.story = Array.isArray(value.story) ? value.story.slice(-80) : [];
    roomState.strokes = Array.isArray(value.strokes) ? value.strokes.slice(-MAX_STROKES) : [];
    if (value.trust) roomState.trust = value.trust.revealed ? { submitted: Array.isArray(value.trust.submitted) ? value.trust.submitted : [], revealed: value.trust.revealed, category: value.trust.category || 'friendship' } : { submitted: Array.isArray(value.trust.submitted) ? value.trust.submitted : [], answers: {}, category: value.trust.category || 'friendship' };
    if (selected === 'moment' || selected === 'pass' || selected === 'mirror') render(selected);
  }

  function participantLeft(peerId) {
    if (!isHost || !roomState.trust || roomState.trust.revealed) return;
    const revealResult = trustGate.leave(peerId);
    roomState.trust = { ...trustGate.status(), answers: {}, revealed: null };
    if (revealResult) {
      const reveal = { feature: 'mirror', action: 'reveal', answers: revealResult.answers, category: revealResult.category };
      apply(reveal); send(reveal);
    } else if (selected === 'mirror') render('mirror');
  }

  function open() { if (!layer.isConnected) document.body.append(layer); render(); }
  return { receive, close, open, render, snapshot, restore, participantLeft };
}

function randomId() { return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`; }
