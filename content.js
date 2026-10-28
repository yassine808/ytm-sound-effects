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
     last explicit choice and put it back; state is read from the icon colour
     (white = on, grey = off) because the button exposes no aria-pressed. */

  var SHUFFLE_KEY = 'ytmse:shuffle';
  var shufflePref = null; // null until the user has ever touched shuffle
  var shuffleAttempts = 0;

  function findShuffleButton() {
    var scope = document.querySelector('ytmusic-player-bar') || document;
    var buttons = scope.querySelectorAll(
      'button[aria-label="Shuffle"], button[aria-label*="huffle" i]'
    );
    for (var i = 0; i < buttons.length; i++) {
      var rect = buttons[i].getBoundingClientRect();
      if (rect.width && rect.height) return buttons[i];
    }
    return null;
  }

  function isShuffleOn(button) {
    try {
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
    if (shufflePref !== true) return;
    if (!force && shuffleAttempts >= 6) return;

    var button = findShuffleButton();
    if (!button) return;
    if (isShuffleOn(button)) {
      shuffleAttempts = 0;
      return;
    }

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

  var AD_POLL_MS = 350;
  var adMuted = false;
  var adSkipAt = 0;
  var adClockSince = 0;

  function isAdPlaying() {
    try {
      var player = document.getElementById('movie_player');
      var bar = document.querySelector('ytmusic-player-bar');
      var text = bar && bar.innerText ? bar.innerText : '';

      // The player bar shows a "Sponsored" line while an ad is playing; this
      // survives theme and layout changes.
      if (/(^|\n)\s*Sponsored\s*(\n|$)/i.test(text)) {
        adClockSince = 0;
        return true;
      }

      var flagged = !!(player && player.classList.contains('ad-showing'));

      if (flagged) {
        // A stale ad-showing class would otherwise mute the song forever. The
        // bar only shows a "current / duration" clock for real playback, never
        // for an ad, so after a grace period treat the class as stale.
        if (/\d{1,2}:\d{2}\s*\/\s*\d{1,2}:\d{2}/.test(text)) {
          if (!adClockSince) adClockSince = Date.now();
          if (Date.now() - adClockSince > 4000) return false;
        } else {
          adClockSince = 0;
        }
        return true;
      }

      adClockSince = 0;
      var badge = document.querySelector('.ytp-ad-simple-ad-badge');
      return !!(badge && badge.getBoundingClientRect().width);
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

  function startAdWatcher() {
    if (adTimer) return;
    adTimer = setInterval(function () {
      try {
        syncAd();
      } catch (e) {
        /* never let the interval throw */
      }
    }, AD_POLL_MS);

    try {
      document.addEventListener('play', syncAd, true);
      document.addEventListener('playing', syncAd, true);
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

  /** One frame of analyser data: 40 log-spaced bars + the 10 EQ band levels. */
  function analyseFrame() {
    if (!chain || chain.disposed) return { ok: false, reason: 'not attached' };
    var spectrum = chain.getSpectrum ? chain.getSpectrum() : null;
    if (!spectrum) return { ok: false, reason: 'no analyser' };

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

    return {
      ok: true,
      level: chain.getLevel ? chain.getLevel() : 0,
      bars: bars,
      bands: bands,
      paused: videoEl ? videoEl.paused : true,
      enabled: config.enabled !== false
    };
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
          shufflePref: shufflePref,
          ad: adMuted,
          chainMuted: chain && !chain.disposed && chain.isMuted ? chain.isMuted() : null,
          shuffle: (function () {
            var button = findShuffleButton();
            return button ? isShuffleOn(button) : null;
          })(),
          config: config,
          lastError: SoundChain.lastError || null
        };
      },
      rescan: function () {
        scan();
        return true;
      },
      frame: analyseFrame
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
