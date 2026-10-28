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
          config: config,
          lastError: SoundChain.lastError || null
        };
      },
      rescan: function () {
        scan();
        return true;
      }
    };
  } catch (e) {
    /* debug surface must never break the extension */
  }

  // Answer the popup's liveness ping so the UI can tell the user whether the
  // tab needs a reload (installing an extension does not inject into tabs that
  // are already open).
  try {
    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      if (!message || message.type !== 'YTMSE_PING') return undefined;
      sendResponse({
        ok: true,
        status: window.__ytmse ? window.__ytmse.status() : null
      });
      return false;
    });
  } catch (e) {
    warn('could not register ping listener:', e);
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
