// Pear Remote: drives Pear Desktop through its "API Server" plugin
// (src/plugins/api-server): REST under /api/v1 + a WebSocket for live updates.

const $ = (id) => document.getElementById(id);
const API = '/api/v1';

const store = {
  get server() { return localStorage.getItem('pear.server') || ''; },
  set server(v) { localStorage.setItem('pear.server', v); },
  get clientId() {
    let id = localStorage.getItem('pear.clientId');
    if (!id) {
      id = `pear-remote-${Math.random().toString(36).slice(2, 8)}`;
      localStorage.setItem('pear.clientId', id);
    }
    return id;
  },
  set clientId(v) { localStorage.setItem('pear.clientId', v); },
  get token() { return localStorage.getItem('pear.token') || ''; },
  set token(v) { v ? localStorage.setItem('pear.token', v) : localStorage.removeItem('pear.token'); },
};

const state = {
  song: null,
  isPlaying: false,
  position: 0,
  volume: 100,
  muted: false,
  repeat: 'NONE',
  shuffle: false,
  like: 'INDIFFERENT',
  seeking: false,
};

let socket = null;
let reconnectTimer = null;
let tickTimer = null;

/* ---------- HTTP ---------- */

class AuthError extends Error {}

async function api(method, path, body) {
  const res = await fetch(`${store.server}${API}${path}`, {
    method,
    headers: {
      ...(store.token ? { Authorization: `Bearer ${store.token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 || res.status === 403) throw new AuthError('Non autorisé');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function authenticate() {
  const res = await fetch(`${store.server}/auth/${encodeURIComponent(store.clientId)}`, { method: 'POST' });
  if (res.status === 403) throw new Error('Connexion refusée sur le PC.');
  if (!res.ok) throw new Error(`Échec de l'authentification (HTTP ${res.status}).`);
  const { accessToken } = await res.json();
  store.token = accessToken;
}

// Fire-and-forget command with a toast on failure.
async function command(method, path, body) {
  try {
    return await api(method, path, body);
  } catch (err) {
    if (err instanceof AuthError) return logout('Session expirée, reconnecte-toi.');
    toast(`Erreur : ${err.message}`);
  }
}

/* ---------- Connection ---------- */

function showConnect(error = '') {
  $('remote').hidden = true;
  $('connect').hidden = false;
  $('server-url').value = store.server || location.origin;
  $('client-id').value = store.clientId;
  $('connect-error').textContent = error;
}

function logout(error = '') {
  store.token = '';
  socket?.close();
  socket = null;
  clearTimeout(reconnectTimer);
  showConnect(error);
}

async function start() {
  $('connect').hidden = true;
  $('remote').hidden = false;
  setStatus('Connexion…');
  try {
    // Probe the token; also catches a desktop that forgot this client.
    await refreshAll();
  } catch (err) {
    if (err instanceof AuthError) return logout('Autorisation perdue, reconnecte-toi.');
    setStatus('Hors ligne');
  }
  openSocket();
}

function openSocket() {
  clearTimeout(reconnectTimer);
  const url = new URL(`${store.server}${API}/ws`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (store.token) url.searchParams.set('token', store.token);

  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => setStatus('Connecté', true);
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = (e) => {
    if (socket !== ws) return;
    setStatus('Hors ligne – reconnexion…');
    if (e.code === 1008) return logout('Autorisation refusée par le PC.');
    reconnectTimer = setTimeout(() => {
      refreshAll().catch(() => {});
      openSocket();
    }, 3000);
  };
}

function onMessage(msg) {
  switch (msg.type) {
    case 'PLAYER_INFO':
      Object.assign(state, {
        song: msg.song ?? null,
        isPlaying: msg.isPlaying,
        position: msg.position,
        volume: msg.volume,
        muted: msg.muted,
        repeat: msg.repeat,
        shuffle: msg.shuffle,
      });
      break;
    case 'VIDEO_CHANGED':
      state.song = msg.song;
      state.position = msg.position ?? 0;
      state.isPlaying = msg.song ? !msg.song.isPaused : state.isPlaying;
      refreshLike();
      if (!$('view-queue').hidden) loadQueue();
      break;
    case 'PLAYER_STATE_CHANGED':
      state.isPlaying = msg.isPlaying;
      state.position = msg.position;
      break;
    case 'POSITION_CHANGED':
      state.position = msg.position;
      break;
    case 'VOLUME_CHANGED':
      state.volume = msg.volume;
      state.muted = msg.muted;
      break;
    case 'REPEAT_CHANGED':
      state.repeat = msg.repeat;
      break;
    case 'SHUFFLE_CHANGED':
      state.shuffle = msg.shuffle;
      break;
  }
  render();
}

async function refreshAll() {
  const [song, volume, shuffle, repeat] = await Promise.all([
    api('GET', '/song'),
    api('GET', '/volume'),
    api('GET', '/shuffle'),
    api('GET', '/repeat-mode'),
  ]);
  state.song = song;
  state.isPlaying = song ? !song.isPaused : false;
  state.position = song?.elapsedSeconds ?? 0;
  if (volume) {
    state.volume = volume.state;
    state.muted = volume.isMuted;
  }
  state.shuffle = !!shuffle?.state;
  state.repeat = repeat?.mode ?? 'NONE';
  await refreshLike();
  render();
}

async function refreshLike() {
  const res = await api('GET', '/like-state').catch(() => null);
  state.like = res?.state ?? 'INDIFFERENT';
  render();
}

/* ---------- Rendering ---------- */

const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

function setStatus(text, online = false) {
  $('status').textContent = text;
  $('status').classList.toggle('remote__status--online', online);
}

function render() {
  const { song } = state;
  $('title').textContent = song?.title ?? 'Rien en cours';
  $('artist').textContent = song ? [song.artist, song.album].filter(Boolean).join(' • ') : '';
  const art = song?.imageSrc ?? '';
  if ($('art').getAttribute('src') !== art) {
    $('art').classList.remove('now-playing__art--broken');
    $('art').setAttribute('src', art);
  }
  document.title = song ? `${song.title} – Pear Remote` : 'Pear Remote';

  const duration = song?.songDuration ?? 0;
  $('seek').max = String(duration);
  if (!state.seeking) $('seek').value = String(Math.min(state.position, duration));
  $('elapsed').textContent = fmt(state.seeking ? Number($('seek').value) : state.position);
  $('duration').textContent = fmt(duration);

  $('toggle').classList.toggle('now-playing__lecture-cta--playing', state.isPlaying);
  $('shuffle').classList.toggle('now-playing__shuffle-cta--on', state.shuffle);
  $('repeat').classList.toggle('now-playing__repeat-cta--on', state.repeat !== 'NONE');
  $('repeat').classList.toggle('now-playing__repeat-cta--one', state.repeat === 'ONE');
  $('like').classList.toggle('now-playing__like-cta--on', state.like === 'LIKE');
  $('dislike').classList.toggle('now-playing__dislike-cta--on', state.like === 'DISLIKE');
  $('mute').classList.toggle('now-playing__mute-cta--on', state.muted);
  if (document.activeElement !== $('volume')) $('volume').value = String(state.volume);

  if ('mediaSession' in navigator && song) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title,
      artist: song.artist,
      album: song.album ?? '',
      artwork: art ? [{ src: art }] : [],
    });
  }

  clearInterval(tickTimer);
  if (state.isPlaying) {
    tickTimer = setInterval(() => {
      state.position = Math.min(state.position + 1, duration || Infinity);
      if (!state.seeking) {
        $('seek').value = String(state.position);
        $('elapsed').textContent = fmt(state.position);
      }
    }, 1000);
  }
}

let toastTimer;
function toast(text) {
  $('toast').textContent = text;
  $('toast').classList.add('toast--visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('toast--visible'), 2500);
}

/* ---------- YouTube Music renderers (raw innertube data) ---------- */

const runsText = (t) => t?.runs?.map((r) => r.text).join('') ?? t?.simpleText ?? '';
const smallestThumb = (thumbs) => {
  const list = thumbs?.thumbnails ?? [];
  return (list.find((t) => t.width >= 60) ?? list[list.length - 1])?.url ?? '';
};

function el(tag, className, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

const icon = (d) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
};
const ICON_CLOSE = 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z';
const ICON_ADD = 'M3 10h11v2H3v-2zm0-4h11v2H3V6zm0 8h7v2H3v-2zm13-1v-3h-2v3h-3v2h3v3h2v-3h3v-2h-3z';

/* ---------- Queue ---------- */

async function loadQueue() {
  let data;
  try {
    data = await api('GET', '/queue');
  } catch (err) {
    if (err instanceof AuthError) return logout('Session expirée, reconnecte-toi.');
    return toast(`Erreur : ${err.message}`);
  }
  const items = (data?.items ?? [])
    .map((item) => item.playlistPanelVideoRenderer ?? item.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer)
    .map((r, index) => ({ r, index }))
    .filter(({ r }) => r);

  $('queue-empty').hidden = items.length > 0;
  $('queue-list').replaceChildren(
    ...items.map(({ r, index }) => {
      const play = el('button', 'queue__jouer-cta', { type: 'button' }, [
        el('img', 'queue__thumb', { src: smallestThumb(r.thumbnail), alt: '', loading: 'lazy' }),
        el('span', 'queue__item-text', {}, [
          el('span', 'queue__item-title', { textContent: runsText(r.title) }),
          el('span', 'queue__item-sub', {
            textContent: [runsText(r.shortBylineText), runsText(r.lengthText)].filter(Boolean).join(' • '),
          }),
        ]),
      ]);
      play.addEventListener('click', () => command('PATCH', '/queue', { index }).then(loadQueue));

      const remove = el('button', 'queue__retirer-cta', { type: 'button', ariaLabel: 'Retirer' }, [icon(ICON_CLOSE)]);
      remove.addEventListener('click', () => command('DELETE', `/queue/${index}`).then(loadQueue));

      return el('li', `queue__item${r.selected ? ' queue__item--current' : ''}`, {}, [play, remove]);
    }),
  );
  $('queue-list').querySelector('.queue__item--current')?.scrollIntoView({ block: 'center' });
}

/* ---------- Search ---------- */

function findRenderers(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.musicResponsiveListItemRenderer) out.push(node.musicResponsiveListItemRenderer);
  for (const value of Object.values(node)) findRenderers(value, out);
  return out;
}

function parseResult(r) {
  const videoId =
    r.playlistItemData?.videoId ??
    r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
  if (!videoId) return null;
  const cols = r.flexColumns?.map((c) => runsText(c.musicResponsiveListItemFlexColumnRenderer?.text)) ?? [];
  return {
    videoId,
    title: cols[0] ?? '',
    subtitle: cols.slice(1).filter(Boolean).join(' • '),
    thumb: smallestThumb(r.thumbnail?.musicThumbnailRenderer?.thumbnail),
  };
}

async function search(query) {
  $('search-list').replaceChildren();
  $('search-empty').hidden = true;
  if (!query.trim()) return;
  let data;
  try {
    data = await api('POST', '/search', { query });
  } catch (err) {
    if (err instanceof AuthError) return logout('Session expirée, reconnecte-toi.');
    return toast(`Erreur : ${err.message}`);
  }
  const seen = new Set();
  const results = findRenderers(data)
    .map(parseResult)
    .filter((r) => r && !seen.has(r.videoId) && seen.add(r.videoId));

  $('search-empty').hidden = results.length > 0;
  $('search-list').replaceChildren(
    ...results.map((r) => {
      const play = el('button', 'search__jouer-cta', { type: 'button' }, [
        el('img', 'search__thumb', { src: r.thumb, alt: '', loading: 'lazy' }),
        el('span', 'search__item-text', {}, [
          el('span', 'search__item-title', { textContent: r.title }),
          el('span', 'search__item-sub', { textContent: r.subtitle }),
        ]),
      ]);
      // "Play now" = insert after the current song, then skip to it.
      play.addEventListener('click', async () => {
        await command('POST', '/queue', { videoId: r.videoId, insertPosition: 'INSERT_AFTER_CURRENT_VIDEO' });
        setTimeout(() => command('POST', '/next'), 600);
        toast(`Lecture : ${r.title}`);
      });

      const add = el('button', 'search__ajouter-cta', { type: 'button', ariaLabel: 'Ajouter à la file' }, [icon(ICON_ADD)]);
      add.addEventListener('click', async () => {
        await command('POST', '/queue', { videoId: r.videoId, insertPosition: 'INSERT_AT_END' });
        toast(`Ajouté à la file : ${r.title}`);
      });

      return el('li', 'search__item', {}, [play, add]);
    }),
  );
}

/* ---------- Wiring ---------- */

$('connect-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = e.submitter;
  button.disabled = true;
  $('connect-error').textContent = 'En attente de validation sur le PC…';
  try {
    store.server = $('server-url').value.trim().replace(/\/+$/, '');
    store.clientId = $('client-id').value.trim();
    await authenticate();
    start();
  } catch (err) {
    $('connect-error').textContent =
      err instanceof TypeError
        ? 'Serveur injoignable. Vérifie l\'adresse, et que l\'API Server est actif.'
        : err.message;
  } finally {
    button.disabled = false;
  }
});

$('art').addEventListener('error', () => $('art').classList.add('now-playing__art--broken'));
$('disconnect').addEventListener('click', () => logout());

$('toggle').addEventListener('click', () => {
  state.isPlaying = !state.isPlaying;
  render();
  command('POST', '/toggle-play');
});
$('prev').addEventListener('click', () => command('POST', '/previous'));
$('next').addEventListener('click', () => command('POST', '/next'));
$('shuffle').addEventListener('click', () => command('POST', '/shuffle'));
$('repeat').addEventListener('click', () => command('POST', '/switch-repeat', { iteration: 1 }));
$('mute').addEventListener('click', () => command('POST', '/toggle-mute'));
$('like').addEventListener('click', () => command('POST', '/like').then(refreshLike));
$('dislike').addEventListener('click', () => command('POST', '/dislike').then(refreshLike));

$('seek').addEventListener('input', () => {
  state.seeking = true;
  $('elapsed').textContent = fmt(Number($('seek').value));
});
$('seek').addEventListener('change', () => {
  state.seeking = false;
  state.position = Number($('seek').value);
  command('POST', '/seek-to', { seconds: state.position });
  render();
});

let volumeTimer;
$('volume').addEventListener('input', () => {
  clearTimeout(volumeTimer);
  volumeTimer = setTimeout(() => command('POST', '/volume', { volume: Number($('volume').value) }), 120);
});

$('clear-queue').addEventListener('click', () => {
  if (confirm('Vider la file d\'attente ?')) command('DELETE', '/queue').then(loadQueue);
});

$('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  $('search-input').blur();
  search($('search-input').value);
});

document.querySelectorAll('.tabbar [data-view]').forEach((tab) => {
  tab.addEventListener('click', () => {
    const view = tab.dataset.view;
    document.querySelectorAll('.tabbar [data-view]').forEach((t) => t.classList.toggle('tabbar__tab--active', t === tab));
    for (const v of ['player', 'queue', 'search']) $(`view-${v}`).hidden = v !== view;
    if (view === 'queue') loadQueue();
    if (view === 'search') $('search-input').focus();
  });
});

// Back from a locked phone: resync instead of trusting the local ticker.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && store.token) refreshAll().catch(() => {});
});

// The APK link is only shown when the server actually hosts it.
fetch('pear-mobile.apk', { method: 'HEAD' })
  .then((res) => { $('apk-link').hidden = !res.ok; })
  .catch(() => {});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');

if (store.token && store.server) start();
else showConnect();
