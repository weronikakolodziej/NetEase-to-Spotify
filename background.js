// background.js — service worker rozszerzenia

const SPOTIFY_CLIENT_ID = 'XXX';
const SPOTIFY_CLIENT_SECRET = 'XXX';
const SPOTIFY_SCOPES = [
  'playlist-modify-public',
  'playlist-modify-private',
  'playlist-read-private',
  'user-library-modify',
  'user-library-read'
].join(' ');

// ─── OAuth ───────────────────────────────────────────────────────────────────

async function getRedirectUrl() {
  return chrome.identity.getRedirectURL('spotify');
}

async function spotifyLogin() {
  const redirectUrl = await getRedirectUrl();
  const state = Math.random().toString(36).substring(2);

  const authUrl = new URL('https://accounts.spotify.com/authorize');
  authUrl.searchParams.set('client_id', SPOTIFY_CLIENT_ID);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUrl);
  authUrl.searchParams.set('scope', SPOTIFY_SCOPES);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('show_dialog', 'true');

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl.toString(), interactive: true },
      async (responseUrl) => {
        if (chrome.runtime.lastError || !responseUrl) {
          reject(chrome.runtime.lastError?.message || 'Login cancelled');
          return;
        }
        const params = new URL(responseUrl).searchParams;
        const code = params.get('code');
        if (!code) { reject('No authorization code'); return; }

        try {
          const tokens = await exchangeCodeForToken(code, redirectUrl);
          await chrome.storage.local.set({
            spotify_access_token: tokens.access_token,
            spotify_refresh_token: tokens.refresh_token,
            spotify_token_expiry: Date.now() + tokens.expires_in * 1000
          });
          resolve(tokens.access_token);
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

async function forceRelogin() {
  await chrome.storage.local.remove([
    'spotify_access_token',
    'spotify_refresh_token',
    'spotify_token_expiry'
  ]);
  return spotifyLogin();
}

async function exchangeCodeForToken(code, redirectUri) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + btoa(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`)
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri })
  });
  if (!res.ok) throw new Error('Token exchange failed: ' + await res.text());
  return res.json();
}

async function refreshAccessToken() {
  const { spotify_refresh_token } = await chrome.storage.local.get('spotify_refresh_token');
  if (!spotify_refresh_token) return spotifyLogin();

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + btoa(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`)
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: spotify_refresh_token })
  });
  if (!res.ok) return spotifyLogin();

  const data = await res.json();
  await chrome.storage.local.set({
    spotify_access_token: data.access_token,
    spotify_token_expiry: Date.now() + data.expires_in * 1000
  });
  return data.access_token;
}

async function getValidToken() {
  const { spotify_access_token, spotify_token_expiry } = await chrome.storage.local.get(
    ['spotify_access_token', 'spotify_token_expiry']
  );
  if (!spotify_access_token) return spotifyLogin();
  if (Date.now() > spotify_token_expiry - 60000) return refreshAccessToken();
  return spotify_access_token;
}

// ─── Spotify API ──────────────────────────────────────────────────────────────

async function spotifyRequest(endpoint, method = 'GET', body = null) {
  const token = await getValidToken();
  const res = await fetch(`https://api.spotify.com/v1${endpoint}`, {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error(`[Spotify] ${method} ${endpoint} → ${res.status}`, JSON.stringify(err));
    throw new Error(err.error?.message || `Spotify API error ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

async function searchSpotify(title, artist) {
  let data = await spotifyRequest(
    `/search?q=track:${encodeURIComponent(title)}+artist:${encodeURIComponent(artist)}&type=track&limit=1`
  );
  if (data.tracks.items.length > 0) return data.tracks.items[0].uri;

  data = await spotifyRequest(
    `/search?q=${encodeURIComponent(`${title} ${artist}`)}&type=track&limit=1`
  );
  if (data.tracks.items.length > 0) return data.tracks.items[0].uri;

  return null;
}

async function getSpotifyUserId() {
  const me = await spotifyRequest('/me');
  return me.id;
}

// Pobierz wszystkie playlisty użytkownika ze Spotify (do sprawdzania duplikatów)
async function getSpotifyPlaylists() {
  const userId = await getSpotifyUserId();
  let playlists = [];
  let url = `/me/playlists?limit=50`;
  while (url) {
    const data = await spotifyRequest(url);
    playlists = playlists.concat(data.items.filter(p => p.owner.id === userId));
    url = data.next ? data.next.replace('https://api.spotify.com/v1', '') : null;
  }
  return playlists;
}

// ─── NetEase API ──────────────────────────────────────────────────────────────

async function neaseRequest(path, body = null) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ url: 'https://music.163.com/*' }, (tabs) => {
      if (!tabs.length) { reject(new Error('Open music.163.com in browser')); return; }
      chrome.tabs.sendMessage(tabs[0].id, { type: 'NETEASE_REQUEST', path, body }, (res) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (res?.error) reject(new Error(res.error));
        else resolve(res?.data);
      });
    });
  });
}

// ─── Oczekiwanie na decyzję użytkownika (duplikat) ───────────────────────────

// Mapa: port → resolve funkcja oczekująca na odpowiedź
const pendingDecisions = new Map();

function waitForDecision(port, playlistName) {
  return new Promise((resolve) => {
    pendingDecisions.set(port.name + ':' + playlistName, resolve);
  });
}

// ─── Pobieranie danych NetEase ────────────────────────────────────────────────

async function fetchNeteaseData() {
  const profile = await neaseRequest('/api/nuser/account/get');
  const uid = profile?.account?.id;
  if (!uid) throw new Error('Cannot fetch NetEase user ID. Login to music.163.com');

  const likedData = await neaseRequest(`/api/song/like/get?uid=${uid}`);
  const likedIds = likedData?.ids || [];

  const plData = await neaseRequest(`/api/user/playlist?uid=${uid}&limit=50`);
  const playlists = (plData?.playlist || []).filter(p => p.specialType !== 5);

  return { uid, likedIds, playlists };
}

// ─── Główna logika transferu ──────────────────────────────────────────────────

async function transfer(port, sendProgress, options) {
  const log = (msg, type = 'info') => sendProgress({ type: 'log', msg, level: type });
  const setStep = (step, total) => sendProgress({ type: 'step', step, total });

  const { transferLiked, playlistIds } = options;

  log('Fetching NetEase user data...');
  const { uid, likedIds, playlists } = await fetchNeteaseData();

  // Filtruj tylko wybrane playlisty
  const selectedPlaylists = playlists.filter(p => playlistIds.includes(String(p.id)));

  // Pobierz istniejące playlisty ze Spotify do wykrywania duplikatów
  log('Checking existing playlists on Spotify...');
  const spotifyPlaylists = await getSpotifyPlaylists();
  const spotifyPlaylistNames = new Map(spotifyPlaylists.map(p => [p.name.toLowerCase(), p]));

  const totalSteps = (transferLiked ? 1 : 0) + selectedPlaylists.length;
  let currentStep = 0;

  // ── Transfer polubionych ──
  if (transferLiked) {
    setStep(++currentStep, totalSteps);
    log('Searching liked songs on Spotify...');

    // Sprawdź duplikat
    const likedName = '❤️ Liked songs from NetEase';
    if (spotifyPlaylistNames.has(likedName.toLowerCase())) {
      sendProgress({ type: 'duplicate', playlistName: likedName });
      const decision = await waitForDecision(port, likedName);
      if (decision === 'skip') {
        log(`⏭ Skipped "${likedName}" (already exists)`, 'warn');
        // nie rób nic
      } else {
        await transferPlaylistTracks(likedIds, likedName, log, sendProgress, port);
      }
    } else {
      await transferPlaylistTracks(likedIds, likedName, log, sendProgress, port);
    }
  }

  // ── Transfer playlist ──
  for (const pl of selectedPlaylists) {
    setStep(++currentStep, totalSteps);
    log(`Playlist: "${pl.name}"...`);

    const plDetail = await neaseRequest(`/api/v6/playlist/detail?id=${pl.id}`);
    const trackIds = (plDetail?.playlist?.trackIds || []).map(t => t.id);

    if (spotifyPlaylistNames.has(pl.name.toLowerCase())) {
      sendProgress({ type: 'duplicate', playlistName: pl.name });
      const decision = await waitForDecision(port, pl.name);
      if (decision === 'skip') {
        log(`⏭ Skipped "${pl.name}" (already exists)`, 'warn');
        continue;
      }
    }

    await transferPlaylistTracks(trackIds, pl.name, log, sendProgress, port, pl.name);
  }

  setStep(totalSteps, totalSteps);
  log('Transfer finished!', 'success');
}

async function transferPlaylistTracks(trackIds, playlistName, log, sendProgress, port, neasePlaylistName = '') {
  const tracks = await getTrackDetails(trackIds);
  const uris = await resolveToSpotify(tracks, log, sendProgress, playlistName);

  if (uris.length > 0) {
    const created = await spotifyRequest(`/me/playlists`, 'POST', {
      name: playlistName,
      public: false,
      description: 'Transferred from NetEase Music'
    });
    for (let i = 0; i < uris.length; i += 100) {
      await spotifyRequest(`/playlists/${created.id}/items`, 'POST', { uris: uris.slice(i, i + 100) });
      await sleep(200);
    }
    log(`✅ "${playlistName}": ${uris.length}/${trackIds.length} songs`, 'success');
  } else {
    log(`⚠ "${playlistName}": no songs on Spotify`, 'warn');
  }
}

async function getTrackDetails(ids) {
  const chunks = [];
  for (let i = 0; i < ids.length; i += 200) chunks.push(ids.slice(i, i + 200));

  const tracks = [];
  for (const chunk of chunks) {
    const data = await neaseRequest(`/api/v3/song/detail?c=${encodeURIComponent(JSON.stringify(chunk.map(id => ({ id }))))}`);
    for (const s of (data?.songs || [])) {
      tracks.push({ title: s.name, artist: s.ar?.[0]?.name || '' });
    }
    await sleep(200);
  }
  return tracks;
}

async function resolveToSpotify(tracks, log, sendProgress, playlistName = '') {
  const uris = [];
  const notFoundTracks = [];
  for (const track of tracks) {
    const uri = await searchSpotify(track.title, track.artist);
    if (uri) uris.push(uri);
    else notFoundTracks.push({ title: track.title, artist: track.artist, playlist: playlistName });
    await sleep(100);
  }
  if (notFoundTracks.length > 0) {
    log(`⚠ Not found ${notFoundTracks.length} songs on Spotify`, 'warn');
    sendProgress({ type: 'not_found', tracks: notFoundTracks });
  }
  return uris;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SPOTIFY_LOGIN') {
    spotifyLogin().then(() => sendResponse({ ok: true })).catch(err => sendResponse({ ok: false, error: err.toString() }));
    return true;
  }
  if (msg.type === 'SPOTIFY_FORCE_RELOGIN') {
    forceRelogin().then(() => sendResponse({ ok: true })).catch(err => sendResponse({ ok: false, error: err.toString() }));
    return true;
  }
  if (msg.type === 'CHECK_AUTH') {
    chrome.storage.local.get(['spotify_access_token', 'spotify_token_expiry'], (data) => {
      sendResponse({ loggedIn: !!data.spotify_access_token });
    });
    return true;
  }
  if (msg.type === 'SPOTIFY_LOGOUT') {
    chrome.storage.local.remove(['spotify_access_token', 'spotify_refresh_token', 'spotify_token_expiry']);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'FETCH_NETEASE_DATA') {
    fetchNeteaseData()
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

// ─── Port dla transferu z live progress ──────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'transfer') return;

  port.onMessage.addListener((msg) => {
    // Odpowiedź użytkownika na pytanie o duplikat
    if (msg.type === 'DUPLICATE_DECISION') {
      const key = port.name + ':' + msg.playlistName;
      const resolve = pendingDecisions.get(key);
      if (resolve) {
        pendingDecisions.delete(key);
        resolve(msg.decision); // 'continue' lub 'skip'
      }
    }
    // Start transferu z opcjami
    if (msg.type === 'START_TRANSFER') {
      transfer(port, (progress) => port.postMessage(progress), msg.options)
        .catch(err => port.postMessage({ type: 'error', msg: err.message }));
    }
  });
});