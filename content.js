/*
 * YTM Sound Effects — content script.
 * Finds the <video> on music.youtube.com, wires up the audio graph and keeps
 * it in sync with chrome.storage.local.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'ytmse:config';
  var POLL_MS = 1000;
  var MAX_ATTACH_RETRIES = 30;
  var MUTATION_DEBOUNCE_MS = 200;

  if (!window.YTMAudio || typeof window.YTMAudio.SoundChain !== 'function') {
    console.warn('[YTM Sound Effects] audio.js did not load; extension inactive.');
    return;
  }

  var SoundChain = window.YTMAudio.SoundChain;

  var chain = null;
  var videoEl = null;
  var config = window.YTMAudio.defaultConfig();
  var storageOk = typeof chrome !== 'undefined' && !!(chrome.storage && chrome.storage.local);
  var retries = 0;
  var pollTimer = null;
  var adTimer = null;
  var observer = null;
  var mutationTimer = null;
  var gestureArmed = false;

  function log() {
    try {
      console.log.apply(console, ['[YTM Sound Effects]'].concat([].slice.call(arguments)));
    } catch (e) {
      /* ignore */
    }
  }

  function warn() {
    try {
      console.warn.apply(console, ['[YTM Sound Effects]'].concat([].slice.call(arguments)));
    } catch (e) {
      /* ignore */
    }
  }

  /* Visible proof that the extension is alive on the page. A silent failure is
     indistinguishable from "the extension does nothing". */
  var badgeShown = false;
  function showBadge(text, kind) {
    try {
      var previous = document.getElementById('ytmse-badge');
      if (previous) previous.remove();

      var el = document.createElement('div');
      el.id = 'ytmse-badge';
      el.setAttribute('role', 'status');
      el.style.cssText = [
        'position:fixed',
        'left:18px',
        'bottom:18px',
        'z-index:2147483647',
        'display:flex',
        'align-items:center',
        'gap:8px',
        'padding:8px 12px',
        'border-radius:999px',
        'font:600 11.5px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
        'letter-spacing:.01em',
        'color:#f2f2f3',
        'background:rgba(16,16,19,.95)',
        'border:1px solid rgba(255,255,255,.1)',
        'box-shadow:0 10px 26px -12px rgba(0,0,0,.9)',
        'pointer-events:none',
        'opacity:0',
        'transform:translateY(8px)',
        'transition:opacity .2s ease,transform .2s ease',
        kind === 'error' ? 'border-color:rgba(255,80,80,.55)' : ''
      ].join(';');

      var dot = document.createElement('span');
      dot.style.cssText = [
        'width:7px',
        'height:7px',
        'border-radius:50%',
        'background:' + (kind === 'error' ? '#ff5252' : '#ff2d2d'),
        'box-shadow:0 0 10px ' + (kind === 'error' ? 'rgba(255,82,82,.85)' : 'rgba(255,45,45,.85)')
      ].join(';');

      el.appendChild(dot);
      el.appendChild(document.createTextNode(text));
      (document.body || document.documentElement).appendChild(el);

      requestAnimationFrame(function () {
        el.style.opacity = '1';
        el.style.transform = 'translateY(0)';
      });

      setTimeout(function () {
        el.style.opacity = '0';
        el.style.transform = 'translateY(8px)';
        setTimeout(function () {
          el.remove();
        }, 250);
      }, kind === 'error' ? 8000 : 3000);
    } catch (e) {
      /* never let the badge break audio */
    }
  }

  // ---------------------------------------------------------------------------
  // storage
  // ---------------------------------------------------------------------------

  function loadConfig(cb) {
    if (!storageOk) {
      cb(config);
      return;
    }
    try {
      chrome.storage.local.get(STORAGE_KEY, function (items) {
        if (chrome.runtime && chrome.runtime.lastError) {
          warn('storage read failed:', chrome.runtime.lastError.message);
          cb(config);
          return;
        }
        var stored = items && items[STORAGE_KEY];
        if (stored) config = window.YTMAudio.normalizeConfig(stored);
        cb(config);
      });
    } catch (e) {
      warn('storage read threw:', e);
      cb(config);
    }
  }

  function watchStorage() {
    if (!storageOk || !chrome.storage.onChanged) return;
    try {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes[STORAGE_KEY]) return;
        var next = changes[STORAGE_KEY].newValue;
        config = window.YTMAudio.normalizeConfig(next);
        apply();
      });
    } catch (e) {
      warn('could not watch storage:', e);
    }
  }

  // ---------------------------------------------------------------------------
  // shuffle persistence
  // ---------------------------------------------------------------------------
  /* YouTube Music forgets the shuffle state on reload. We remember the user's
     last explicit choice and put it back. The player-bar button has no ARIA
     state: ON is a white icon and OFF is grey. Some newer buttons elsewhere do
     expose aria-pressed, so check that first and fall back to colour. */

  var SHUFFLE_KEY = 'ytmse:shuffle';
  var SHUFFLE_RETRY_LIMIT = 8;
  var SHUFFLE_CLICK_COOLDOWN = 1200;
  var shufflePref = null; // null until the user has ever touched shuffle
  var shuffleAttempts = 0;
  var shuffleClickedAt = 0;

  function findShuffleButton() {
    // Only the player bar counts. Other "Shuffle" buttons (playlist headers,
    // home cards) start something new instead of toggling playback order.
    var scope = document.querySelector('ytmusic-player-bar');
    if (!scope) return null;

    var buttons = scope.querySelectorAll(
      'button[aria-label="Shuffle"], button[aria-label*="huffle" i]'
    );
    for (var i = 0; i < buttons.length; i++) {
      var rect = buttons[i].getBoundingClientRect();
      if (rect.width && rect.height) return buttons[i];
    }
    return null;
  }

  /** Find a visible player-bar button by exact aria-label. */
  function barButton(labels) {
    var scope = document.querySelector('ytmusic-player-bar');
    if (!scope) return null;
    for (var l = 0; l < labels.length; l++) {
      var list = scope.querySelectorAll('button[aria-label="' + labels[l] + '"]');
      for (var i = 0; i < list.length; i++) {
        var rect = list[i].getBoundingClientRect();
        if (rect.width && rect.height) return list[i];
      }
    }
    return null;
  }

  function anyShuffleButton() {
    var scope = document.querySelector('ytmusic-player-bar');
    if (!scope) return null;
    return scope.querySelector('button[aria-label*="huffle" i]');
  }

  function isShuffleOn(button) {
    try {
      var pressed = button.getAttribute('aria-pressed');
      if (pressed === 'true') return true;
      if (pressed === 'false') return false;

      var checked = button.getAttribute('aria-checked');
      if (checked === 'true') return true;
      if (checked === 'false') return false;

      var icon = button.querySelector('yt-icon') || button;
      var color = window.getComputedStyle(icon).color || '';
      var match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
      if (match) {
        var brightness = (Number(match[1]) + Number(match[2]) + Number(match[3])) / 3;
        return brightness > 200;
      }
      var path = button.querySelector('svg path');
      return !!(path && /^M16\.293 13/.test(path.getAttribute('d') || ''));
    } catch (e) {
      return false;
    }
  }

  function restoreShuffle(force) {
    if (typeof shufflePref !== 'boolean') return;
    if (!force && shuffleAttempts >= SHUFFLE_RETRY_LIMIT) return;

    var button = findShuffleButton();
    if (!button) return;
    if (isShuffleOn(button) === shufflePref) {
      shuffleAttempts = 0;
      return;
    }

    // Give YouTube Music a moment to apply the previous toggle before clicking
    // again; otherwise the 2.5 s poll can flip the state twice.
    var now = Date.now();
    if (now - shuffleClickedAt < SHUFFLE_CLICK_COOLDOWN) return;
    shuffleClickedAt = now;

    shuffleAttempts += 1;
    try {
      button.click();
    } catch (e) {
      /* ignore */
    }
  }

  function saveShuffle(value) {
    if (!storageOk) return;
    try {
      var payload = {};
      payload[SHUFFLE_KEY] = value;
      chrome.storage.local.set(payload);
    } catch (e) {
      /* ignore */
    }
  }

  function loadShufflePref() {
    if (!storageOk) return;
    try {
      chrome.storage.local.get(SHUFFLE_KEY, function (items) {
        if (chrome.runtime && chrome.runtime.lastError) return;
        var value = items && items[SHUFFLE_KEY];
        if (typeof value === 'boolean') {
          shufflePref = value;
          restoreShuffle(true);
        }
      });
    } catch (e) {
      /* ignore */
    }
  }

  function watchShufflePref() {
    if (!storageOk || !chrome.storage.onChanged) return;
    try {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes[SHUFFLE_KEY]) return;
        var value = changes[SHUFFLE_KEY].newValue;
        if (typeof value === 'boolean') shufflePref = value;
      });
    } catch (e) {
      /* ignore */
    }
  }

  function startShuffleKeeper() {
    loadShufflePref();
    watchShufflePref();

    // Capture phase: this runs before YouTube Music flips the state, so the
    // user's intent is the opposite of what the icon currently shows.
    try {
      document.addEventListener(
        'click',
        function (event) {
          var target = event.target;
          if (!target || !target.closest) return;
          var button = target.closest(
            'ytmusic-player-bar button[aria-label="Shuffle"], ytmusic-player-bar button[aria-label*="huffle" i]'
          );
          if (!button) return;

          var next = !isShuffleOn(button);
          shufflePref = next;
          saveShuffle(next);
        },
        true
      );
    } catch (e) {
      warn('shuffle listener failed:', e);
    }

    try {
      document.addEventListener(
        'playing',
        function () {
          shuffleAttempts = 0;
          restoreShuffle(true);
        },
        true
      );
    } catch (e) {
      /* ignore */
    }

    try {
      window.addEventListener('yt-navigate-finish', function () {
        shuffleAttempts = 0;
        setTimeout(function () {
          restoreShuffle(true);
        }, 600);
      });
    } catch (e) {
      /* ignore */
    }

    setInterval(function () {
      try {
        restoreShuffle(false);
      } catch (e) {
        /* ignore */
      }
    }, 2500);
  }

  // ---------------------------------------------------------------------------
  // volume control pinned to the player bar
  // ---------------------------------------------------------------------------
  /* Scroll over the pill to change the page's own volume through YouTube's
     player API, so YTM's slider, mute state and saved volume stay in sync.
     Click the pill to mute; arrow keys work while it has focus. */

  var VOLUME_STEP = 5; // percent per wheel notch
  var VOLUME_WHEEL_PX = 50; // wheel pixels per notch
  var VOLUME_WHEEL_GAP = 12; // px between the pill and the player bar

  var volumeEl = null;
  var volumeFill = null;
  var volumeThumb = null;
  var volumeValue = null;
  var volumeIconOn = null;
  var volumeIconOff = null;
  var volumeWheelAccum = 0;
  var volumePainted = { pct: -1, muted: null, visible: null, bottom: '' };
  var volumeSyncAt = 0;

  function playerApi() {
    try {
      return document.getElementById('movie_player');
    } catch (e) {
      return null;
    }
  }

  function readVolume() {
    var api = playerApi();
    if (api && typeof api.getVolume === 'function') {
      try {
        var pct = Number(api.getVolume());
        if (isFinite(pct)) {
          return {
            pct: Math.max(0, Math.min(100, Math.round(pct))),
            muted: typeof api.isMuted === 'function' ? !!api.isMuted() : false
          };
        }
      } catch (e) {
        /* fall through to the media element */
      }
    }
    var video = videoEl || findVideo();
    if (!video) return null;
    return {
      pct: Math.round((isFinite(video.volume) ? video.volume : 1) * 100),
      muted: !!video.muted
    };
  }

  function applyVolume(pct) {
    pct = Math.max(0, Math.min(100, Math.round(pct)));
    var api = playerApi();
    if (api && typeof api.setVolume === 'function') {
      try {
        // Turning it up from silence must also lift the site's mute flag.
        if (pct > 0 && typeof api.isMuted === 'function' && api.isMuted() &&
            typeof api.unMute === 'function') {
          api.unMute();
        }
        api.setVolume(pct);
        paintVolume();
        bumpVolume();
        return pct;
      } catch (e) {
        /* fall through to the media element */
      }
    }
    var video = videoEl || findVideo();
    if (video) {
      if (pct > 0) video.muted = false;
      video.volume = pct / 100;
    }
    paintVolume();
    bumpVolume();
    return pct;
  }

  function toggleVolumeMute() {
    var api = playerApi();
    if (api && typeof api.mute === 'function' && typeof api.isMuted === 'function') {
      try {
        if (api.isMuted()) {
          if (typeof api.unMute === 'function') api.unMute();
        } else {
          api.mute();
        }
        paintVolume();
        bumpVolume();
        return;
      } catch (e) {
        /* fall through to the media element */
      }
    }
    var video = videoEl || findVideo();
    if (video) video.muted = !video.muted;
    paintVolume();
    bumpVolume();
  }

  /** Small scale kick so every wheel notch gets visible feedback. */
  function bumpVolume() {
    if (!volumeEl || typeof volumeEl.animate !== 'function') return;
    try {
      volumeEl.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }],
        { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' }
      );
    } catch (e) {
      /* ignore */
    }
  }

  function popIn(el) {
    if (!el || typeof el.animate !== 'function') return;
    try {
      el.animate(
        [
          { opacity: 0, transform: 'translateY(12px) scale(.94)' },
          { opacity: 1, transform: 'translateY(0) scale(1)' }
        ],
        { duration: 280, easing: 'cubic-bezier(.2,.8,.2,1)' }
      );
    } catch (e) {
      /* ignore */
    }
  }

  function paintVolume() {
    if (!volumeEl) return;
    var state = readVolume();
    var pct = state ? state.pct : 0;
    var muted = state ? state.muted : false;
    var shown = muted ? 0 : pct;
    if (volumePainted.pct === shown && volumePainted.muted === muted) return;
    volumePainted.pct = shown;
    volumePainted.muted = muted;

    var fillBg = muted
      ? 'rgba(255,255,255,.35)'
      : 'linear-gradient(90deg,#ff7a7a,#ff2d2d)';
    var thumbRing = muted ? 'rgba(255,255,255,.35)' : 'rgba(255,45,45,.55)';

    if (volumeFill) {
      volumeFill.style.width = shown + '%';
      volumeFill.style.background = fillBg;
    }
    if (volumeThumb) {
      volumeThumb.style.left = shown + '%';
      volumeThumb.style.boxShadow = '0 2px 6px rgba(0,0,0,.55), 0 0 0 2px ' + thumbRing;
    }
    if (volumeValue) volumeValue.textContent = muted ? 'muted' : String(pct);
    if (volumeIconOn) volumeIconOn.style.display = muted ? 'none' : 'block';
    if (volumeIconOff) volumeIconOff.style.display = muted ? 'block' : 'none';

    volumeEl.setAttribute('aria-valuenow', String(shown));
    volumeEl.setAttribute('aria-valuetext', muted ? 'Muted' : pct + '%');
    volumeEl.title = muted ? 'Muted · scroll or click to unmute' : 'Volume ' + pct + '% · scroll to adjust';
  }

  function onVolumeWheel(event) {
    event.preventDefault();
    event.stopPropagation();

    var delta = event.deltaY;
    if (!isFinite(delta) || delta === 0) return;
    if (event.deltaMode === 1) delta *= 16; // lines
    else if (event.deltaMode === 2) delta *= 100; // pages

    // Trackpads fire many tiny deltas; accumulate until a whole notch exists so
    // one gesture does not jump the volume around.
    volumeWheelAccum += delta;
    var notches = volumeWheelAccum < 0
      ? Math.ceil(volumeWheelAccum / VOLUME_WHEEL_PX)
      : Math.floor(volumeWheelAccum / VOLUME_WHEEL_PX);
    if (!notches) return;
    volumeWheelAccum -= notches * VOLUME_WHEEL_PX;

    var state = readVolume();
    if (!state) return;
    // Scrolling up (negative delta) is louder.
    applyVolume(state.pct - notches * VOLUME_STEP);
  }

  function onVolumeKey(event) {
    var state = readVolume();
    if (!state) return;
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') {
      event.preventDefault();
      applyVolume(state.pct + VOLUME_STEP);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') {
      event.preventDefault();
      applyVolume(state.pct - VOLUME_STEP);
    } else if (event.key === 'Home') {
      event.preventDefault();
      applyVolume(100);
    } else if (event.key === 'End') {
      event.preventDefault();
      applyVolume(0);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleVolumeMute();
    }
  }

  /** Keep the pill just above the player bar's right corner. */
  function positionVolumeControl() {
    if (!volumeEl || !volumeEl.isConnected) return;
    var bar = document.querySelector('ytmusic-player-bar');
    var rect = bar ? bar.getBoundingClientRect() : null;
    var hasBar = !!(rect && rect.height > 0 && rect.bottom > 0);
    var bottom = hasBar
      ? Math.round(Math.max(0, window.innerHeight - rect.top) + VOLUME_WHEEL_GAP)
      : 110;

    if (volumePainted.visible !== true) {
      volumeEl.style.display = 'flex';
      volumePainted.visible = true;
      volumePainted.bottom = '';
    }
    if (volumePainted.bottom !== bottom) {
      volumeEl.style.bottom = bottom + 'px';
      volumePainted.bottom = bottom;
    }
  }

  function volumeIcon(withWaves) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '15');
    svg.setAttribute('height', '15');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'display:block;flex:0 0 auto;color:#f4f4f5';

    var cone = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    cone.setAttribute('d', 'M4 9.4h3.2L12 5.4v13.2L7.2 14.6H4z');
    cone.setAttribute('fill', 'currentColor');
    svg.appendChild(cone);

    var wave = function (d) {
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '1.8');
      path.setAttribute('stroke-linecap', 'round');
      return path;
    };

    if (withWaves) {
      svg.appendChild(wave('M15.6 9.3a4.2 4.2 0 0 1 0 5.4'));
      svg.appendChild(wave('M18.3 6.9a7.6 7.6 0 0 1 0 10.2'));
    } else {
      svg.appendChild(wave('M15.6 9.4l5 5.2'));
      svg.appendChild(wave('M20.6 9.4l-5 5.2'));
    }
    return svg;
  }

  function buildVolumeControl() {
    if (volumeEl && volumeEl.isConnected) return volumeEl;

    var el = document.createElement('div');
    el.id = 'ytmse-volume';
    el.setAttribute('role', 'slider');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', 'Volume');
    el.setAttribute('aria-valuemin', '0');
    el.setAttribute('aria-valuemax', '100');
    el.style.cssText = [
      'position:fixed',
      'right:18px',
      'bottom:110px',
      'z-index:2147483647',
      'display:flex',
      'align-items:center',
      'gap:9px',
      'padding:8px 12px 8px 10px',
      'border-radius:999px',
      'background:rgba(18,18,21,.86)',
      'border:1px solid rgba(255,255,255,.14)',
      'box-shadow:0 12px 30px -14px rgba(0,0,0,.9),inset 0 1px 0 rgba(255,255,255,.06)',
      'color:#f4f4f5',
      'font:600 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      'letter-spacing:.01em',
      'cursor:pointer',
      'opacity:.9',
      'user-select:none',
      'transform-origin:100% 50%',
      'transition:opacity .16s ease,transform .16s ease,border-color .16s ease,background .16s ease'
    ].join(';');

    var icon = document.createElement('span');
    icon.id = 'ytmse-vol-icon';
    icon.style.cssText = 'display:flex;align-items:center;justify-content:center;width:15px;height:15px';
    volumeIconOn = volumeIcon(true);
    volumeIconOff = volumeIcon(false);
    volumeIconOff.style.display = 'none';
    icon.appendChild(volumeIconOn);
    icon.appendChild(volumeIconOff);

    var track = document.createElement('div');
    track.style.cssText = [
      'position:relative',
      'width:84px',
      'height:6px',
      'border-radius:999px',
      'background:rgba(255,255,255,.16)',
      'flex:0 0 auto'
    ].join(';');

    var fill = document.createElement('div');
    fill.id = 'ytmse-vol-fill';
    fill.style.cssText = [
      'position:absolute',
      'left:0',
      'top:0',
      'bottom:0',
      'width:0%',
      'border-radius:999px',
      'background:linear-gradient(90deg,#ff7a7a,#ff2d2d)',
      'box-shadow:0 0 10px rgba(255,45,45,.35)',
      'transition:width .2s cubic-bezier(.2,.8,.2,1),background .2s ease'
    ].join(';');

    var thumb = document.createElement('div');
    thumb.id = 'ytmse-vol-thumb';
    thumb.style.cssText = [
      'position:absolute',
      'top:50%',
      'left:0%',
      'width:12px',
      'height:12px',
      'margin:-6px 0 0 -6px',
      'border-radius:50%',
      'background:#fff',
      'box-shadow:0 2px 6px rgba(0,0,0,.55),0 0 0 2px rgba(255,45,45,.55)',
      'transition:left .2s cubic-bezier(.2,.8,.2,1),box-shadow .2s ease'
    ].join(';');

    var value = document.createElement('span');
    value.id = 'ytmse-vol-value';
    value.style.cssText = [
      'min-width:32px',
      'text-align:right',
      'color:rgba(255,255,255,.78)',
      'font-variant-numeric:tabular-nums',
      'transition:color .16s ease'
    ].join(';');

    track.appendChild(fill);
    track.appendChild(thumb);
    el.appendChild(icon);
    el.appendChild(track);
    el.appendChild(value);

    el.addEventListener('wheel', onVolumeWheel, { passive: false });
    el.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      toggleVolumeMute();
    });
    el.addEventListener('keydown', onVolumeKey);
    el.addEventListener('mouseenter', function () {
      el.style.opacity = '1';
      el.style.transform = 'scale(1.03)';
      el.style.background = 'rgba(26,26,30,.95)';
      el.style.borderColor = 'rgba(255,255,255,.24)';
    });
    el.addEventListener('mouseleave', function () {
      el.style.opacity = '.9';
      el.style.transform = 'scale(1)';
      el.style.background = 'rgba(18,18,21,.86)';
      el.style.borderColor = 'rgba(255,255,255,.14)';
    });

    (document.body || document.documentElement).appendChild(el);
    volumeEl = el;
    volumeFill = fill;
    volumeThumb = thumb;
    volumeValue = value;
    volumePainted = { pct: -1, muted: null, visible: null, bottom: '' };
    positionVolumeControl();
    paintVolume();
    popIn(el);
    log('volume control ready');
    return el;
  }

  /** Called from boot() and scan(): builds the pill once, then keeps it glued to
      the player bar as the SPA re-renders. */
  function syncVolumeControl() {
    if (!volumeEl || !volumeEl.isConnected) {
      volumeEl = null;
      volumeFill = null;
      volumeThumb = null;
      volumeValue = null;
      volumeIconOn = null;
      volumeIconOff = null;
      buildVolumeControl();
      return;
    }
    // scan() also runs on every DOM mutation; a layout read per mutation would
    // be wasteful, so reposition a few times a second at most.
    var now = Date.now();
    if (now - volumeSyncAt < 400) return;
    volumeSyncAt = now;
    positionVolumeControl();
    paintVolume();
  }

  // ---------------------------------------------------------------------------
  // transport
  // ---------------------------------------------------------------------------
  /* The popup drives playback by clicking YouTube Music's own controls, so the
     page keeps its keyboard shortcuts, queue and play history in sync. */

  function playerCommand(cmd, value) {
    try {
      if (cmd === 'seek') {
        var targetVideo = findVideo() || videoEl;
        if (!targetVideo) return { ok: false, reason: 'no player' };
        var duration = Number(targetVideo.duration);
        var target = Number(value);
        if (!isFinite(duration) || duration <= 0 || !isFinite(target)) {
          return { ok: false, reason: 'no seekable track' };
        }
        target = Math.max(0, Math.min(duration, target));
        targetVideo.currentTime = target;
        return { ok: true, action: 'seek', currentTime: targetVideo.currentTime };
      }

      if (cmd === 'playpause') {
        var video = findVideo() || videoEl;
        var wasPaused = video ? video.paused : null;
        var toggle = barButton(['Pause', 'Play']);
        if (toggle) {
          toggle.click();
          // Ads and transient overlays can swallow the synthetic click. If the
          // media state did not change, drive the element directly.
          if (video && typeof wasPaused === 'boolean') {
            setTimeout(function () {
              if (video.paused !== wasPaused) return;
              if (wasPaused) {
                var playing = video.play();
                if (playing && playing.catch) playing.catch(function () {});
              } else {
                video.pause();
              }
            }, 140);
          }
          return { ok: true, action: 'playpause' };
        }
        if (!video) return { ok: false, reason: 'no player' };
        if (video.paused) {
          var playing = video.play();
          if (playing && playing.catch) playing.catch(function () {});
        } else {
          video.pause();
        }
        return { ok: true, action: 'playpause' };
      }

      if (cmd === 'next' || cmd === 'prev') {
        var button = cmd === 'next'
          ? barButton(['Next', 'Next song', 'Next track'])
          : barButton(['Previous', 'Previous song', 'Previous track']);
        if (!button) return { ok: false, reason: 'no ' + cmd + ' button' };
        button.click();
        return { ok: true, action: cmd };
      }

      if (cmd === 'shuffle') {
        var shuffle = findShuffleButton() || anyShuffleButton();
        if (!shuffle) return { ok: false, reason: 'no shuffle button' };
        var next = !isShuffleOn(shuffle);
        shufflePref = next;
        saveShuffle(next);
        shuffle.click();
        return { ok: true, action: 'shuffle', shuffle: next };
      }

      return { ok: false, reason: 'unknown command' };
    } catch (e) {
      return { ok: false, reason: e && e.message ? e.message : 'command failed' };
    }
  }

  function transportState() {
    var video = videoEl || findVideo();
    var shuffle = findShuffleButton() || anyShuffleButton();
    return {
      playing: !!(video && !video.paused),
      paused: video ? video.paused : true,
      currentTime: video && isFinite(video.currentTime) ? video.currentTime : 0,
      duration: video && isFinite(video.duration) && video.duration > 0 ? video.duration : 0,
      shuffle: shuffle ? isShuffleOn(shuffle) : null
    };
  }

  // ---------------------------------------------------------------------------
  // video discovery / graph lifecycle
  // ---------------------------------------------------------------------------

  function findVideo() {
    try {
      var preferred = document.querySelector('video.html5-main-video');
      if (preferred) return preferred;
      var all = document.querySelectorAll('video');
      for (var i = 0; i < all.length; i++) {
        var v = all[i];
        if (v && (v.currentSrc || v.src || v.readyState > 0)) return v;
      }
      return all.length ? all[0] : null;
    } catch (e) {
      return null;
    }
  }

  function apply() {
    if (!chain || chain.disposed) return;
    try {
      chain.setConfig(config);
    } catch (e) {
      warn('apply failed:', e);
    }
  }

  function teardown() {
    if (chain) {
      try {
        chain.dispose();
      } catch (e) {
        /* ignore */
      }
    }
    chain = null;
    videoEl = null;
  }

  function attach(el) {
    if (!el) return false;
    if (el === videoEl && chain && !chain.disposed) return true;

    if (chain) {
      try {
        chain.dispose();
      } catch (e) {
        /* ignore */
      }
      chain = null;
    }

    try {
      chain = new SoundChain(el);
      videoEl = el;
      chain.setConfig(config);
      if (el.paused === false) chain.resume();
      syncAd();
      applyAdMute();
      log('audio chain attached to <video>');
      if (!badgeShown) {
        badgeShown = true;
        showBadge('Sound Effects active', 'ok');
      }
      return true;
    } catch (e) {
      chain = null;
      videoEl = null;
      if (SoundChain.lastError) warn(SoundChain.lastError);
      else warn('attach failed:', e && e.message ? e.message : e);
      showBadge(SoundChain.lastError || 'Sound Effects could not attach to the player', 'error');
      return false;
    }
  }

  /** Called by the poll + mutation observer. Idempotent and cheap. */
  function scan() {
    try {
      syncVolumeControl();
      var found = findVideo();
      if (!found) {
        // Video may have been removed mid-navigation; drop the stale graph.
        if (videoEl && !videoEl.isConnected) teardown();
        scheduleRetry();
        return;
      }
      if (found !== videoEl || !chain || chain.disposed) {
        var ok = attach(found);
        if (ok) retries = 0;
        else scheduleRetry();
      }
    } catch (e) {
      warn('scan failed:', e);
    }
  }

  function scheduleRetry() {
    if (retries >= MAX_ATTACH_RETRIES) return;
    retries++;
    setTimeout(scan, Math.min(2000, 250 * retries));
  }

  // ---------------------------------------------------------------------------
  // ads: silence through the chain, then skip when possible
  // ---------------------------------------------------------------------------
  /* YouTube Music serves ads through the same <video> element, so they would
     otherwise be equalised and heard. A master gain inside the chain silences
     them without touching the site's own volume/mute state. When YouTube
     offers a skip button, click it as soon as it is visible. */

  var AD_POLL_MS = 250;
  var AD_STALE_MS = 12000;
  var AD_UI_SELECTOR = [
    '.ytp-ad-player-overlay',
    '.ytp-ad-simple-ad-badge',
    '.ytp-ad-duration-remaining',
    '.ytp-ad-preview-container',
    '.ytp-ad-skip-button-modern',
    '.ytp-ad-skip-button',
    '.ytp-skip-ad-button'
  ].join(',');
  var adMuted = false;
  var adSkipAt = 0;
  var adEvidenceAt = 0;
  var adObserver = null;
  var adObserverTarget = null;
  var adObserverAt = 0;

  function visibleAdUi() {
    try {
      var nodes = document.querySelectorAll(AD_UI_SELECTOR);
      for (var i = 0; i < nodes.length; i++) {
        var rect = nodes[i].getBoundingClientRect();
        if (rect.width && rect.height) return true;
      }
    } catch (e) {
      /* ignore */
    }
    return false;
  }

  function isAdPlaying() {
    try {
      var player = document.getElementById('movie_player');
      var bar = document.querySelector('ytmusic-player-bar');
      var text = bar && bar.innerText ? bar.innerText : '';
      var sponsored = /(^|\n)\s*Sponsored\s*(\n|$)/i.test(text);

      // Strong, layout-independent signals: the "Sponsored" line and the ad
      // overlays/badges. Any of them keeps the chain muted.
      if (sponsored || visibleAdUi()) {
        adEvidenceAt = Date.now();
        return true;
      }

      var flagged = !!(
        player &&
        (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting'))
      );
      if (!flagged) {
        adEvidenceAt = 0;
        return false;
      }

      // ad-showing without any ad UI or "Sponsored" line: trust it for a while,
      // then treat it as a stale class so the song can never stay muted.
      if (!adEvidenceAt) adEvidenceAt = Date.now();
      return Date.now() - adEvidenceAt < AD_STALE_MS;
    } catch (e) {
      return false;
    }
  }

  function trySkipAd() {
    var now = Date.now();
    if (now - adSkipAt < 700) return;

    var buttons = document.querySelectorAll(
      'button.ytp-skip-ad-button, button.ytp-ad-skip-button, ' +
        'button.ytp-ad-skip-button-modern, .ytp-ad-skip-button-slot button, ' +
        '.ytp-ad-skip-button-container button, button[aria-label*="skip ad" i]'
    );

    var clicked = false;
    for (var i = 0; i < buttons.length; i++) {
      var button = buttons[i];
      if (button.disabled) continue;
      var rect = button.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;

      try {
        button.click();
        clicked = true;
      } catch (e) {
        /* ignore */
      }
    }

    if (clicked) adSkipAt = now;
  }

  function applyAdMute() {
    if (!chain || chain.disposed || !chain.setMuted) return;
    try {
      chain.setMuted(adMuted);
    } catch (e) {
      /* ignore */
    }
  }

  function syncAd() {
    var active = isAdPlaying();
    if (active !== adMuted) {
      adMuted = active;
      applyAdMute();
    }
    if (active) trySkipAd();
  }

  /* The class flips the instant an ad starts, so observe it directly instead of
     waiting for the next poll — every wasted millisecond is audible ad audio. */
  function observeAdPlayer() {
    var player = document.getElementById('movie_player');
    if (adObserver && adObserverTarget === player && player && player.isConnected) return;

    if (adObserver) {
      adObserver.disconnect();
      adObserver = null;
      adObserverTarget = null;
    }
    if (!player) return;

    try {
      adObserver = new MutationObserver(function () {
        var now = Date.now();
        if (now - adObserverAt < 60) return;
        adObserverAt = now;
        syncAd();
      });
      adObserver.observe(player, { attributes: true, attributeFilter: ['class'] });
      adObserverTarget = player;
    } catch (e) {
      adObserver = null;
      adObserverTarget = null;
    }
  }

  function startAdWatcher() {
    if (adTimer) return;
    adTimer = setInterval(function () {
      try {
        observeAdPlayer();
        syncAd();
      } catch (e) {
        /* never let the interval throw */
      }
    }, AD_POLL_MS);

    observeAdPlayer();

    try {
      document.addEventListener('play', syncAd, true);
      document.addEventListener('playing', syncAd, true);
      document.addEventListener('loadedmetadata', syncAd, true);
    } catch (e) {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------------
  // observers
  // ---------------------------------------------------------------------------

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      try {
        scan();
      } catch (e) {
        /* never let the interval throw */
      }
    }, POLL_MS);
  }

  function onMutations() {
    if (mutationTimer) return;
    mutationTimer = setTimeout(function () {
      mutationTimer = null;
      scan();
    }, MUTATION_DEBOUNCE_MS);
  }

  function startObserver() {
    if (observer || typeof MutationObserver !== 'function') return;
    try {
      observer = new MutationObserver(onMutations);
      observer.observe(document.documentElement || document, { childList: true, subtree: true });
    } catch (e) {
      warn('MutationObserver unavailable:', e);
    }
  }

  // ---------------------------------------------------------------------------
  // autoplay policy: resume the AudioContext on the first real gesture
  // ---------------------------------------------------------------------------

  function resumeNow() {
    try {
      if (chain && !chain.disposed) {
        chain.resume();
      } else if (SoundChain.resumeContext) {
        SoundChain.resumeContext();
      }
    } catch (e) {
      /* ignore */
    }
  }

  function disarmGestures() {
    if (!gestureArmed) return;
    gestureArmed = false;
    try {
      document.removeEventListener('pointerdown', onGesture, true);
      document.removeEventListener('keydown', onGesture, true);
      document.removeEventListener('touchstart', onGesture, true);
    } catch (e) {
      /* ignore */
    }
  }

  function onGesture() {
    resumeNow();
    var ctx = SoundChain.getContext ? SoundChain.getContext() : null;
    // If the context still is not running (e.g. resume rejected), keep listening.
    if (!ctx || ctx.state === 'running') disarmGestures();
  }

  function armGestures() {
    if (gestureArmed) return;
    gestureArmed = true;
    try {
      document.addEventListener('pointerdown', onGesture, { capture: true, passive: true });
      document.addEventListener('keydown', onGesture, { capture: true, passive: true });
      document.addEventListener('touchstart', onGesture, { capture: true, passive: true });
    } catch (e) {
      /* older syntax fallback */
      try {
        document.addEventListener('pointerdown', onGesture, true);
        document.addEventListener('keydown', onGesture, true);
      } catch (e2) {
        /* ignore */
      }
    }
  }

  // ---------------------------------------------------------------------------
  // boot
  // ---------------------------------------------------------------------------

  function boot() {
    // Build the volume pill right away; it must not wait on storage.
    syncVolumeControl();

    loadConfig(function () {
      scan();
      apply();
    });

    watchStorage();
    startObserver();
    startPolling();
    startAdWatcher();
    startShuffleKeeper();
    armGestures();

    // Autoplay policy: any play event is a chance to un-suspend the context.
    try {
      document.addEventListener('play', resumeNow, true);
      document.addEventListener('playing', resumeNow, true);
    } catch (e) {
      /* ignore */
    }

    // The fader mirrors volume changes made anywhere else on the page.
    try {
      document.addEventListener('volumechange', paintVolume, true);
      window.addEventListener('resize', positionVolumeControl);
    } catch (e) {
      /* ignore */
    }

    // YouTube Music is an SPA: also re-scan on history navigation.
    try {
      window.addEventListener('yt-navigate-finish', function () {
        setTimeout(scan, 300);
      });
      window.addEventListener('popstate', function () {
        setTimeout(scan, 300);
      });
    } catch (e) {
      /* ignore */
    }

    // Last-ditch re-scan when the tab becomes visible again (tab sleep).
    try {
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) scan();
      });
    } catch (e) {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------------
  // live spectrum for the popup
  // ---------------------------------------------------------------------------

  var BAND_HZ = window.YTMAudio.BANDS || [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  var SPECTRUM_BARS = 40;
  var rangeCache = null;
  var rangeKey = '';

  function binRange(loHz, hiHz, nyquist, bins) {
    var lo = Math.max(0, Math.floor((loHz / nyquist) * bins));
    var hi = Math.min(bins, Math.ceil((hiHz / nyquist) * bins));
    if (hi <= lo) hi = Math.min(bins, lo + 1);
    return [lo, hi];
  }

  function buildRanges(sampleRate, fftSize) {
    var key = sampleRate + ':' + fftSize;
    if (rangeCache && rangeKey === key) return rangeCache;

    var bins = fftSize / 2;
    var nyquist = sampleRate / 2;
    var bars = [];
    var minHz = 40;
    var maxHz = 16000;
    var ratio = Math.pow(maxHz / minHz, 1 / SPECTRUM_BARS);

    for (var i = 0; i < SPECTRUM_BARS; i++) {
      var lo = minHz * Math.pow(ratio, i);
      bars.push(binRange(lo, lo * ratio, nyquist, bins));
    }

    var bands = [];
    for (var b = 0; b < BAND_HZ.length; b++) {
      var center = BAND_HZ[b];
      bands.push(binRange(center / Math.SQRT2, center * Math.SQRT2, nyquist, bins));
    }

    rangeCache = { bars: bars, bands: bands };
    rangeKey = key;
    return rangeCache;
  }

  function bandEnergy(data, range) {
    var sum = 0;
    for (var i = range[0]; i < range[1]; i++) sum += data[i];
    return sum / ((range[1] - range[0]) * 255);
  }

  function zeroList(length) {
    var list = new Array(length);
    for (var i = 0; i < length; i++) list[i] = 0;
    return list;
  }

  /** One frame of analyser data (40 log-spaced bars + 10 EQ bands) plus the
      transport state the popup needs for its progress bar and buttons. */
  function analyseFrame() {
    var transport = transportState();
    var frame = {
      ok: true,
      attached: !!(chain && !chain.disposed),
      level: 0,
      bars: zeroList(SPECTRUM_BARS),
      bands: zeroList(BAND_HZ.length),
      paused: transport.paused,
      playing: transport.playing,
      currentTime: transport.currentTime,
      duration: transport.duration,
      shuffle: transport.shuffle,
      enabled: config.enabled !== false
    };

    if (!chain || chain.disposed) return frame;
    var spectrum = chain.getSpectrum ? chain.getSpectrum() : null;
    if (!spectrum) return frame;

    var ctx = SoundChain.getContext ? SoundChain.getContext() : null;
    var sampleRate = ctx ? ctx.sampleRate : 48000;
    var fftSize = chain.analyser ? chain.analyser.fftSize : 2048;
    var ranges = buildRanges(sampleRate, fftSize);

    var bars = new Array(ranges.bars.length);
    for (var i = 0; i < ranges.bars.length; i++) {
      bars[i] = bandEnergy(spectrum, ranges.bars[i]);
    }

    var bands = new Array(ranges.bands.length);
    for (var b = 0; b < ranges.bands.length; b++) {
      bands[b] = bandEnergy(spectrum, ranges.bands[b]);
    }

    frame.level = chain.getLevel ? chain.getLevel() : 0;
    frame.bars = bars;
    frame.bands = bands;
    return frame;
  }

  // Debug surface. Lives in the content script's isolated world, so page
  // scripts can never read or control it.
  try {
    window.__ytmse = {
      status: function () {
        var ctx = SoundChain.getContext ? SoundChain.getContext() : null;
        return {
          attached: !!(chain && !chain.disposed),
          context: ctx ? ctx.state : "none",
          level: chain && !chain.disposed ? chain.getLevel() : 0,
          paused: videoEl ? videoEl.paused : null,
          muted: videoEl ? videoEl.muted : null,
          volume: videoEl ? videoEl.volume : null,
          fader: (function () {
            var el = document.getElementById('ytmse-volume');
            if (!el) return { present: false };
            var rect = el.getBoundingClientRect();
            return {
              present: true,
              visible: el.isConnected && getComputedStyle(el).display !== 'none',
              rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
              volume: readVolume()
            };
          })(),
          shufflePref: shufflePref,
          ad: adMuted,
          chainMuted: chain && !chain.disposed && chain.isMuted ? chain.isMuted() : null,
          shuffle: (function () {
            var button = findShuffleButton() || anyShuffleButton();
            return button ? isShuffleOn(button) : null;
          })(),
          transport: transportState(),
          config: config,
          lastError: SoundChain.lastError || null
        };
      },
      rescan: function () {
        scan();
        return true;
      },
      frame: analyseFrame,
      command: playerCommand,
      setVolume: applyVolume,
      toggleMute: toggleVolumeMute
    };
  } catch (e) {
    /* debug surface must never break the extension */
  }

  // Answer the popup: liveness ping (tab has the content script) and the
  // analyser frames that drive the spectrum graph and the EQ meters.
  try {
    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      if (!message) return undefined;

      if (message.type === 'YTMSE_PING') {
        sendResponse({
          ok: true,
          status: window.__ytmse ? window.__ytmse.status() : null
        });
        return false;
      }

      if (message.type === 'YTMSE_FRAME') {
        sendResponse(analyseFrame());
        return false;
      }

      if (message.type === 'YTMSE_CMD') {
        sendResponse(playerCommand(message.cmd, message.value));
        return false;
      }

      return undefined;
    });
  } catch (e) {
    warn('could not register message listener:', e);
  }

  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  } catch (e) {
    warn('boot failed:', e);
  }
})();
