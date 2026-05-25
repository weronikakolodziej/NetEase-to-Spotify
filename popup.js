// popup.js

const $ = id => document.getElementById(id);

let spotifyLoggedIn = false;
let neteaseLoggedIn = false;
let allNotFound = [];
let transferPort = null;

// Stan selekcji
let likedChecked = true;
let playlistRows = []; // [{ id, name, trackCount, checked }]

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  await checkSpotifyAuth();
  await checkNeteaseAuth();
  updateTransferButton();
}

// ─── Spotify Auth ─────────────────────────────────────────────────────────────

async function checkSpotifyAuth() {
  const res = await sendMessage({ type: 'CHECK_AUTH' });
  spotifyLoggedIn = res?.loggedIn || false;
  renderSpotifyCard();
}

function renderSpotifyCard() {
  const card = $('spotify-card');
  const sub  = $('spotify-sub');
  const btn  = $('btn-spotify-login');
  if (spotifyLoggedIn) {
    card.className = 'auth-card connected';
    sub.textContent = 'connected';
    btn.textContent = 'Logout';
    btn.className = 'btn-small btn-logout';
    btn.onclick = logoutSpotify;
  } else {
    card.className = 'auth-card';
    sub.textContent = 'not connected';
    btn.textContent = 'Login';
    btn.className = 'btn-small btn-spotify';
    btn.onclick = loginSpotify;
  }
}

async function loginSpotify() {
  $('btn-spotify-login').textContent = '...';
  $('btn-spotify-login').disabled = true;
  const res = await sendMessage({ type: 'SPOTIFY_LOGIN' });
  if (res?.ok) { spotifyLoggedIn = true; addLog('Connected to Spotify!', 'success'); }
  else addLog('Error logging in Spotify: ' + (res?.error || 'unknown'), 'error');
  renderSpotifyCard();
  updateTransferButton();
}

async function logoutSpotify() {
  await sendMessage({ type: 'SPOTIFY_LOGOUT' });
  spotifyLoggedIn = false;
  renderSpotifyCard();
  updateTransferButton();
}

// ─── NetEase Auth ─────────────────────────────────────────────────────────────

async function checkNeteaseAuth() {
  const tabs = await chrome.tabs.query({ url: 'https://music.163.com/*' });
  if (!tabs.length) { neteaseLoggedIn = false; showNeteaseHint(false, 'noTab'); return; }

  try {
    const res = await sendToTab(tabs[0].id, { type: 'NETEASE_REQUEST', path: '/api/nuser/account/get' });
    if (res?.data?.account?.id) {
      neteaseLoggedIn = true;
      showNeteaseHint(true, res.data.profile?.nickname || 'zalogowany');
      loadSelectionData();
    } else {
      neteaseLoggedIn = false;
      showNeteaseHint(false, 'notLoggedIn');
    }
  } catch {
    neteaseLoggedIn = false;
    showNeteaseHint(false, 'noTab');
  }
}

function showNeteaseHint(ok, detail) {
  const card = $('netease-card');
  const sub  = $('netease-sub');
  const hint = $('netease-hint');
  if (ok) {
    card.className = 'auth-card connected';
    sub.textContent = detail;
    hint.style.display = 'none';
  } else if (detail === 'noTab') {
    card.className = 'auth-card error';
    sub.textContent = 'no open tab';
    hint.style.display = 'block';
    hint.innerHTML = '⚠ Open <a href="https://music.163.com" target="_blank">music.163.com</a> in new tab and login.';
  } else {
    card.className = 'auth-card error';
    sub.textContent = 'not logged in';
    hint.style.display = 'block';
    hint.innerHTML = '⚠ Login to <a href="https://music.163.com" target="_blank">music.163.com</a> and refresh.';
  }
}

// ─── Ładowanie danych do selekcji ────────────────────────────────────────────

async function loadSelectionData() {
  $('selection-section').style.display = 'block';
  $('selection-loading').style.display = 'block';
  $('selection-content').style.display = 'none';

  const res = await sendMessage({ type: 'FETCH_NETEASE_DATA' });
  if (!res?.ok) {
    $('selection-loading').textContent = '❌ Error loading data';
    return;
  }

  const { likedIds, playlists } = res.data;

  // Liked
  $('liked-sub').textContent = `${likedIds.length} `;

  // Playlisty
  playlistRows = playlists.map(p => ({
    id: String(p.id),
    name: p.name,
    trackCount: p.trackCount,
    checked: true
  }));

  renderPlaylistList();

  $('selection-loading').style.display = 'none';
  $('selection-content').style.display = 'block';
  updateTransferButton();
}

function renderPlaylistList() {
  const list = $('playlist-list');
  list.innerHTML = '';
  for (const pl of playlistRows) {
    const row = document.createElement('div');
    // Zmiana klasy na 'item-row' (taką samą jak w Liked Songs)
    row.className = 'item-row' + (pl.checked ? ' checked' : '');
    row.dataset.id = pl.id;
    // Dopasowanie struktury HTML do klas CSS z pliku HTML
    row.innerHTML = `
      <div class="item-icon">🎵</div>
      <div class="item-info">
        <div class="item-name">${escHtml(pl.name)}</div>
        <div class="item-sub">${pl.trackCount} songs</div>
      </div>
      <div class="checkbox"></div>
    `;
    row.addEventListener('click', () => togglePlaylist(pl.id));
    list.appendChild(row);
  }
}

function togglePlaylist(id) {
  const pl = playlistRows.find(p => p.id === id);
  if (pl) pl.checked = !pl.checked;
  renderPlaylistList();
  updateTransferButton();
}

// Polubione toggle
$('liked-row').addEventListener('click', () => {
  likedChecked = !likedChecked;
  $('liked-row').classList.toggle('checked', likedChecked);
  updateTransferButton();
});

// Zaznacz/odznacz wszystko
$('btn-select-all').addEventListener('click', () => {
  likedChecked = true;
  playlistRows.forEach(p => p.checked = true);
  $('liked-row').classList.add('checked');
  renderPlaylistList();
  updateTransferButton();
});

$('btn-deselect-all').addEventListener('click', () => {
  likedChecked = false;
  playlistRows.forEach(p => p.checked = false);
  $('liked-row').classList.remove('checked');
  renderPlaylistList();
  updateTransferButton();
});

// ─── Transfer ─────────────────────────────────────────────────────────────────

function updateTransferButton() {
  const btn = $('btn-transfer');
  const anySelected = likedChecked || playlistRows.some(p => p.checked);
  btn.disabled = !(spotifyLoggedIn && neteaseLoggedIn && anySelected);
}

$('btn-transfer').addEventListener('click', startTransfer);

function startTransfer() {
  const btn = $('btn-transfer');
  btn.disabled = true;
  btn.classList.add('running');
  btn.textContent = 'Transfer in progress...';

  clearLog();
  clearNotFound();
  $('progress-bar-wrap').style.display = 'block';

  const options = {
    transferLiked: likedChecked,
    playlistIds: playlistRows.filter(p => p.checked).map(p => p.id)
  };

  transferPort = chrome.runtime.connect({ name: 'transfer' });

  transferPort.onMessage.addListener((msg) => {
    if (msg.type === 'log') {
      addLog(msg.msg, msg.level);
    } else if (msg.type === 'step') {
      const pct = Math.round((msg.step / msg.total) * 100);
      $('progress-bar').style.width = pct + '%';
      $('progress-text').textContent = `${msg.step}/${msg.total}`;
    } else if (msg.type === 'not_found') {
      addNotFoundTracks(msg.tracks);
    } else if (msg.type === 'duplicate') {
      showDuplicateModal(msg.playlistName);
    } else if (msg.type === 'error') {
      addLog('❌ ' + msg.msg, 'error');
      finishTransfer(btn, false);
    }
    if (msg.type === 'log' && msg.level === 'success' && msg.msg.includes('Transfer zakończony')) {
      finishTransfer(btn, true);
    }
  });

  transferPort.onDisconnect.addListener(() => {
    if (btn.classList.contains('running')) finishTransfer(btn, false);
  });

  // Wyślij START z opcjami
  transferPort.postMessage({ type: 'START_TRANSFER', options });
}

function finishTransfer(btn, success) {
  btn.classList.remove('running');
  btn.disabled = false;
  btn.textContent = success ? '✅ Done! Restart' : 'Try again';
  transferPort = null;
}

// ─── Modal duplikat ───────────────────────────────────────────────────────────

function showDuplicateModal(playlistName) {
  $('modal-pl-name').textContent = playlistName;
  $('modal-overlay').classList.add('visible');

  $('modal-skip').onclick = () => sendDuplicateDecision(playlistName, 'skip');
  $('modal-continue').onclick = () => sendDuplicateDecision(playlistName, 'continue');
}

function sendDuplicateDecision(playlistName, decision) {
  $('modal-overlay').classList.remove('visible');
  if (transferPort) {
    transferPort.postMessage({ type: 'DUPLICATE_DECISION', playlistName, decision });
  }
}

// ─── Nieznalezione ────────────────────────────────────────────────────────────

function clearNotFound() {
  allNotFound = [];
  $('not-found-section').style.display = 'none';
  $('not-found-list').innerHTML = '';
  $('not-found-count').textContent = '';
}

function addNotFoundTracks(tracks) {
  allNotFound.push(...tracks);
  $('not-found-section').style.display = 'block';
  $('not-found-count').textContent = `${allNotFound.length} songs`;
  const list = $('not-found-list');
  for (const t of tracks) {
    const item = document.createElement('div');
    item.className = 'nf-item';
    item.innerHTML = `
      <div class="nf-title">${escHtml(t.title)}<span class="nf-playlist-tag">${escHtml(t.playlist)}</span></div>
      <div class="nf-meta">${escHtml(t.artist || '—')}</div>
    `;
    list.appendChild(item);
  }
  list.scrollTop = list.scrollHeight;
}

$('btn-copy').addEventListener('click', () => {
  const text = allNotFound.map(t => `${t.title} – ${t.artist || '?'} [${t.playlist}]`).join('\n');
  navigator.clipboard.writeText(text).then(() => {
    const btn = $('btn-copy');
    btn.textContent = '✅ Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Kopiuj listę do schowka'; btn.classList.remove('copied'); }, 2000);
  });
});

// ─── Log ──────────────────────────────────────────────────────────────────────

function addLog(msg, level = 'info') {
  const log = $('log');
  const empty = $('empty-log');
  if (empty) empty.remove();
  const ts = new Date().toTimeString().slice(0, 5);
  const entry = document.createElement('div');
  entry.className = `log-entry ${level}`;
  entry.innerHTML = `<span class="ts">${ts}</span><span class="msg">${escHtml(msg)}</span>`;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}

function clearLog() { $('log').innerHTML = ''; }
function escHtml(str) { return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendMessage(msg) { return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve)); }
function sendToTab(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

init();