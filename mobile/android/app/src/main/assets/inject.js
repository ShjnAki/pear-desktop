/*
 * Injected at document start into https://music.youtube.com by MainActivity.
 * `window.__PEAR_CFG__` is defined right before this file by the app.
 *
 * Mobile ports of Pear Desktop plugins:
 *  - adblock: from src/plugins/do-not-track/injectors/inject.ts (player-response pruning)
 *  - sponsorblock: from src/plugins/sponsorblock
 *  - background playback: replaces the Electron "always visible" window
 * plus a bridge feeding the Android media notification (PearAndroid web message listener).
 */
(() => {
  if (window.__pear) return;
  const cfg = window.__PEAR_CFG__ || {};

  /* ---------- Background playback ---------- */
  if (cfg.background) {
    const def = (prop, value) => {
      try {
        Object.defineProperty(Document.prototype, prop, { get: () => value, configurable: true });
      } catch {}
    };
    def('hidden', false);
    def('webkitHidden', false);
    def('visibilityState', 'visible');
    def('webkitVisibilityState', 'visible');
    const swallow = (e) => e.stopImmediatePropagation();
    for (const type of ['visibilitychange', 'webkitvisibilitychange', 'pagehide', 'freeze']) {
      window.addEventListener(type, swallow, true);
      document.addEventListener(type, swallow, true);
    }
  }

  /* ---------- Ad blocking ---------- */
  if (cfg.adblock) {
    const AD_KEYS = ['playerAds', 'adPlacements', 'adSlots', 'adBreakHeartbeatParams'];
    const prune = (o) => {
      if (!o || typeof o !== 'object') return o;
      for (const target of [o, o.playerResponse, o.ytInitialPlayerResponse]) {
        if (target && typeof target === 'object') {
          for (const k of AD_KEYS) if (k in target) delete target[k];
        }
      }
      return o;
    };

    const origParse = JSON.parse;
    JSON.parse = function (...args) {
      return prune(origParse.apply(this, args));
    };

    const origJson = Response.prototype.json;
    Response.prototype.json = function (...args) {
      return origJson.apply(this, args).then(prune);
    };

    // Same traps as the desktop injector: neutralise the ad fields of the inline player response.
    for (const name of ['ytInitialPlayerResponse', 'playerResponse']) {
      let value = window[name];
      try {
        Object.defineProperty(window, name, {
          configurable: true,
          get: () => value,
          set: (v) => {
            value = prune(v);
          },
        });
      } catch {}
    }

    // Fallback when an ad still slips through: mute + jump to the end + click "skip".
    setInterval(() => {
      const player = document.querySelector('.ad-showing, .ad-interrupting');
      if (!player) return;
      const video = player.querySelector('video') || document.querySelector('video');
      if (video && Number.isFinite(video.duration)) video.currentTime = video.duration;
      document
        .querySelectorAll('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button')
        .forEach((b) => b.click());
    }, 500);
  }

  /* ---------- Media session capture ---------- */
  // YouTube Music registers its own media-session handlers (next/previous...).
  // Keep them so the Android notification can call exactly what the web app does.
  const handlers = {};
  if (navigator.mediaSession) {
    const orig = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
    navigator.mediaSession.setActionHandler = (action, handler) => {
      handlers[action] = handler;
      try {
        orig(action, handler);
      } catch {}
    };
  }

  const video = () => document.querySelector('video');
  const currentVideoId = () => {
    try {
      return new URL(location.href).searchParams.get('v');
    } catch {
      return null;
    }
  };
  const clickFirst = (...selectors) => {
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el) {
        el.click();
        return true;
      }
    }
    return false;
  };

  /* ---------- SponsorBlock ---------- */
  let segments = [];
  let segmentsFor = null;
  const sortSegments = (list) => {
    list.sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
    const out = [];
    let cur;
    for (const s of list) {
      if (!cur) cur = s;
      else if (cur[1] < s[0]) {
        out.push(cur);
        cur = s;
      } else cur[1] = Math.max(cur[1], s[1]);
    }
    if (cur) out.push(cur);
    return out;
  };
  const loadSegments = async (videoId) => {
    segmentsFor = videoId;
    segments = [];
    const categories = encodeURIComponent(JSON.stringify(cfg.sbCategories || []));
    try {
      const res = await fetch(
        `https://sponsor.ajay.app/api/skipSegments?videoID=${videoId}&categories=${categories}`,
      );
      if (res.status !== 200 || segmentsFor !== videoId) return;
      const data = await res.json();
      segments = sortSegments(data.map((s) => s.segment));
    } catch {}
  };
  const onTimeUpdate = (e) => {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement)) return;
    if (cfg.sponsorblock) {
      const id = currentVideoId();
      if (id && id !== segmentsFor) loadSegments(id);
      for (const [start, end] of segments) {
        if (v.currentTime >= start && v.currentTime < end) v.currentTime = end;
      }
    }
    report();
  };
  document.addEventListener('timeupdate', onTimeUpdate, true);
  for (const type of ['play', 'pause', 'ended', 'loadedmetadata', 'seeked', 'emptied']) {
    document.addEventListener(type, () => report(true), true);
  }

  /* ---------- Android bridge ---------- */
  let last = '';
  let lastSent = 0;
  const report = (force = false) => {
    if (!window.PearAndroid) return;
    const v = video();
    const meta = navigator.mediaSession && navigator.mediaSession.metadata;
    const art = meta && meta.artwork && meta.artwork.length ? meta.artwork[meta.artwork.length - 1].src : '';
    const state = {
      title: meta ? meta.title : '',
      artist: meta ? meta.artist : '',
      album: meta ? meta.album : '',
      artwork: art,
      playing: !!(v && !v.paused && !v.ended),
      position: v ? Math.floor(v.currentTime * 1000) : 0,
      duration: v && Number.isFinite(v.duration) ? Math.floor(v.duration * 1000) : 0,
    };
    // Position is interpolated natively; only resend when something else changed or every 5 s.
    const key = JSON.stringify({ ...state, position: 0 });
    const now = Date.now();
    if (!force && key === last && now - lastSent < 5000) return;
    last = key;
    lastSent = now;
    window.PearAndroid.postMessage(JSON.stringify(state));
  };

  window.__pear = {
    control(action, arg) {
      const v = video();
      switch (action) {
        case 'play':
          if (v) v.play();
          else handlers.play && handlers.play();
          break;
        case 'pause':
          if (v) v.pause();
          else handlers.pause && handlers.pause();
          break;
        case 'toggle':
          if (v) v.paused ? v.play() : v.pause();
          break;
        case 'next':
          if (handlers.nexttrack) handlers.nexttrack();
          else clickFirst('.next-button', 'tp-yt-paper-icon-button.next-button', '[aria-label="Next"]');
          break;
        case 'previous':
          if (handlers.previoustrack) handlers.previoustrack();
          else clickFirst('.previous-button', '[aria-label="Previous"]');
          break;
        case 'seek':
          if (v) v.currentTime = arg / 1000;
          break;
        case 'stop':
          if (v) v.pause();
          break;
      }
      setTimeout(() => report(true), 300);
    },
  };
})();
