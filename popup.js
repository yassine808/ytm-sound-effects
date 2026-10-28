/*
 * YTM Sound Effects â€” popup UI.
 * Reads/writes chrome.storage.local["ytmse:config"]; the content script applies changes live.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'ytmse:config';

  var api = window.YTMAudio;
  var BANDS = (api && api.BANDS) || [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  var DEFAULTS = api && api.defaultConfig
    ? api.defaultConfig()
    : { enabled: true, preampDb: 0, eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], bassDb: 0, reverbMix: 0, reverbDecay: 1.8 };
  var normalize = api && api.normalizeConfig ? api.normalizeConfig : function (c) { return c || DEFAULTS; };

  // Hardcoded presets. eq is the 10-band gain array (dB), in BANDS order.
  var PRESETS = {
    Flat: { preampDb: 0, eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], bassDb: 0, reverbMix: 0, reverbDecay: 1.8 },
    Bass: { preampDb: -2, eq: [6, 5.5, 3, 1, 0, -1, -1, 0.5, 1, 1], bassDb: 8, reverbMix: 0.05, reverbDecay: 1.2 },
    Vocal: { preampDb: 0, eq: [-3, -2, -1, 1, 3, 4, 3, 1.5, 0, -1], bassDb: 0, reverbMix: 0.12, reverbDecay: 1.0 },
    Live: { preampDb: -1, eq: [2.5, 2, 1, 0, -1.5, 0, 1, 2, 2, 2], bassDb: 3, reverbMix: 0.3, reverbDecay: 1.7 },
    Hall: { preampDb: -2, eq: [1.5, 1, 0, -1, -1, 0, 1, 1, 0, 0.5], bassDb: 2, reverbMix: 0.45, reverbDecay: 3.2 }
  };

  var els = {};
  var bandInputs = [];
  var bandOuts = [];
  var bandMeters = [];
  var bandWraps = [];
  var saveTimer = null;
  var storageBroken = false;

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  function fmtDb(v) {
    var n = Math.round(v * 10) / 10;
    return (n > 0 ? '+' : '') + n + ' dB';
  }

  /** Compact form for the narrow EQ columns: "+1.5", "0", "-2". */
  function fmtBand(v) {
    var n = Math.round(v * 10) / 10;
    if (n === 0) return '0';
    return (n > 0 ? '+' : '') + n;
  }

  function fmtHz(hz) {
    return hz >= 1000 ? hz / 1000 + 'k' : String(hz);
  }

  function paintBand(i, v) {
    var meter = bandMeters[i];
    var band = bandWraps[i];
    if (!meter || !band) return;

    var pct = (Math.abs(v) / 12) * 50;
    meter.style.height = pct + '%';

    if (v > 0) {
      meter.style.bottom = '50%';
      meter.style.top = 'auto';
    } else if (v < 0) {
      meter.style.bottom = 'auto';
      meter.style.top = '50%';
    }
    meter.classList.toggle('is-cut', v < 0);
    band.classList.toggle('is-boost', v > 0);
    band.classList.toggle('is-cut', v < 0);
    band.classList.toggle('is-flat', v === 0);
  }

  function paintRange(el, pct) {
    if (!el) return;
    var clamped = Math.max(0, Math.min(100, pct));
    el.style.setProperty('--p', clamped + '%');
  }

  function paintRanges() {
    paintRange(els.preamp, ((parseFloat(els.preamp.value) || 0) + 12) / 24 * 100);
    paintRange(els.bass, (parseFloat(els.bass.value) || 0) / 15 * 100);
    paintRange(els.mix, parseFloat(els.mix.value) || 0);
    paintRange(els.decay, ((parseFloat(els.decay.value) || 1.8) - 0.3) / 3.7 * 100);

    for (var i = 0; i < bandInputs.length; i++) {
      paintBand(i, parseFloat(bandInputs[i].value) || 0);
    }
  }

  function syncChips(name) {
    var chips = document.querySelectorAll('.chip[data-preset]');
    for (var i = 0; i < chips.length; i++) {
      var on = chips[i].dataset.preset === name;
      chips[i].classList.toggle('is-active', on);
      chips[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function matchPreset(cfg) {
    var EPS = 1e-6;
    for (var name in PRESETS) {
      if (!Object.prototype.hasOwnProperty.call(PRESETS, name)) continue;
      var p = PRESETS[name];
      if (Math.abs(p.preampDb - cfg.preampDb) > EPS) continue;
      if (Math.abs(p.bassDb - cfg.bassDb) > EPS) continue;
      if (Math.abs(p.reverbMix - cfg.reverbMix) > EPS) continue;
      if (Math.abs(p.reverbDecay - cfg.reverbDecay) > EPS) continue;

      var sameEq = true;
      for (var i = 0; i < p.eq.length; i++) {
        if (Math.abs(p.eq[i] - cfg.eq[i]) > EPS) {
          sameEq = false;
          break;
        }
      }
      if (sameEq) return name;
    }
    return null;
  }

  function showNote(text, actionLabel, actionFn) {
    if (!els.note) return;
    if (els.noteText) els.noteText.textContent = text || '';
    else els.note.textContent = text || '';
    els.note.hidden = !text;

    var hasAction = !!(text && actionLabel && actionFn);
    els.note.dataset.tab = hasAction ? '1' : '';

    if (els.noteAction) {
      els.noteAction.hidden = !hasAction;
      els.noteAction.textContent = actionLabel || '';
      els.noteAction.onclick = hasAction
        ? function () {
            try {
              actionFn();
            } catch (e) {
              /* ignore */
            }
          }
        : null;
    }
  }

  /** Warn when the content script is not live in the active tab (fresh install,
      reload needed, or the tab predates the extension). */
  function checkActiveTab() {
    if (typeof chrome === 'undefined' || !chrome.tabs) return;
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        var tab = tabs && tabs[0];
        var isYtm = !!(tab && /^https:\/\/music\.youtube\.com\//.test(tab.url || ''));
        if (!isYtm) {
          showNote('Open a YouTube Music tab to use the effects.');
          return;
        }
        chrome.tabs.sendMessage(tab.id, { type: 'YTMSE_PING' }, function (response) {
          if (chrome.runtime.lastError || !response || !response.ok) {
            showNote('Reload the YouTube Music tab to activate the effects.', 'Reload tab', function () {
              chrome.tabs.reload(tab.id);
              window.close();
            });
            return;
          }
          hideTabNote();
        });
      });
    } catch (e) {
      /* ignore */
    }
  }

  function hideTabNote() {
    if (els.note && els.note.dataset.tab === '1') showNote('');
  }

  function storageAvailable() {
    return typeof chrome !== 'undefined' && !!(chrome.storage && chrome.storage.local);
  }

  // ---------------------------------------------------------------------------
  // build EQ UI
  // ---------------------------------------------------------------------------

  function buildEq() {
    var frag = document.createDocumentFragment();

    BANDS.forEach(function (hz, i) {
      var band = document.createElement('div');
      band.className = 'band is-flat';

      var out = document.createElement('span');
      out.className = 'db';
      out.textContent = '0';

      var fader = document.createElement('div');
      fader.className = 'fader';

      var rail = document.createElement('span');
      rail.className = 'fader-rail';

      var zero = document.createElement('span');
      zero.className = 'fader-zero';

      var meter = document.createElement('span');
      meter.className = 'fader-meter';

      var input = document.createElement('input');
      input.type = 'range';
      input.className = 'vert';
      input.min = '-12';
      input.max = '12';
      input.step = '1';
      input.value = '0';
      input.dataset.index = String(i);
      input.setAttribute('aria-label', fmtHz(hz) + ' Hz gain');
      input.title = fmtHz(hz) + ' Hz';

      fader.appendChild(rail);
      fader.appendChild(zero);
      fader.appendChild(meter);
      fader.appendChild(input);

      var label = document.createElement('span');
      label.className = 'hz';
      label.textContent = fmtHz(hz);

      band.appendChild(out);
      band.appendChild(fader);
      band.appendChild(label);
      frag.appendChild(band);

      bandInputs.push(input);
      bandOuts.push(out);
      bandMeters.push(meter);
      bandWraps.push(band);

      input.addEventListener('input', function () {
        out.textContent = fmtBand(parseFloat(input.value) || 0);
        paintBand(i, parseFloat(input.value) || 0);
        onUserChange();
      });
    });

    els.eqBands.appendChild(frag);
  }

  // ---------------------------------------------------------------------------
  // config <-> UI
  // ---------------------------------------------------------------------------

  function readUi() {
    var eq = bandInputs.map(function (input) {
      return parseFloat(input.value) || 0;
    });
    return normalize({
      enabled: els.enabled.checked,
      preampDb: parseFloat(els.preamp.value),
      eq: eq,
      bassDb: parseFloat(els.bass.value),
      reverbMix: (parseFloat(els.mix.value) || 0) / 100,
      reverbDecay: parseFloat(els.decay.value)
    });
  }

  function render(cfg) {
    var c = normalize(cfg);
    els.enabled.checked = c.enabled;
    els.preamp.value = String(c.preampDb);
    els.bass.value = String(c.bassDb);
    els.mix.value = String(Math.round(c.reverbMix * 100));
    els.decay.value = String(c.reverbDecay);

    for (var i = 0; i < bandInputs.length; i++) {
      bandInputs[i].value = String(c.eq[i]);
      bandOuts[i].textContent = fmtBand(c.eq[i]);
    }

    updateLabels();
    syncChips(matchPreset(c));
  }

  function updateLabels() {
    els.preampOut.textContent = fmtDb(parseFloat(els.preamp.value) || 0);
    els.bassOut.textContent = fmtDb(parseFloat(els.bass.value) || 0);
    els.mixOut.textContent = Math.round(parseFloat(els.mix.value) || 0) + ' %';
    els.decayOut.textContent = (Math.round((parseFloat(els.decay.value) || 0) * 10) / 10).toFixed(1) + ' s';
    els.controls.classList.toggle('off', !els.enabled.checked);
    paintRanges();
  }

  // ---------------------------------------------------------------------------
  // persistence
  // ---------------------------------------------------------------------------

  function saveNow() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (storageBroken) return;
    if (!storageAvailable()) {
      storageBroken = true;
      showNote('chrome.storage is unavailable â€” settings will not persist.');
      return;
    }
    var payload = {};
    payload[STORAGE_KEY] = readUi();
    try {
      chrome.storage.local.set(payload, function () {
        if (chrome.runtime && chrome.runtime.lastError) {
          storageBroken = true;
          showNote('Could not save settings: ' + chrome.runtime.lastError.message);
        }
      });
    } catch (e) {
      storageBroken = true;
      showNote('Could not save settings: ' + (e && e.message ? e.message : e));
    }
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 70);
  }

  function onUserChange() {
    updateLabels();
    syncChips(matchPreset(readUi()));
    scheduleSave();
  }

  function load() {
    if (!storageAvailable()) {
      storageBroken = true;
      showNote('chrome.storage is unavailable â€” showing defaults.');
      render(DEFAULTS);
      return;
    }
    try {
      chrome.storage.local.get(STORAGE_KEY, function (items) {
        if (chrome.runtime && chrome.runtime.lastError) {
          storageBroken = true;
          showNote('Could not load settings: ' + chrome.runtime.lastError.message);
          render(DEFAULTS);
          return;
        }
        var stored = items && items[STORAGE_KEY];
        render(stored ? normalize(stored) : DEFAULTS);
      });
    } catch (e) {
      storageBroken = true;
      showNote('Could not load settings: ' + (e && e.message ? e.message : e));
      render(DEFAULTS);
    }
  }

  // ---------------------------------------------------------------------------
  // presets / reset
  // ---------------------------------------------------------------------------

  function applyPreset(name) {
    var p = PRESETS[name];
    if (!p) return;
    var cfg = {
      enabled: els.enabled.checked,
      preampDb: p.preampDb,
      eq: p.eq.slice(),
      bassDb: p.bassDb,
      reverbMix: p.reverbMix,
      reverbDecay: p.reverbDecay
    };
    render(cfg);
    saveNow();
  }

  // ---------------------------------------------------------------------------
  // init
  // ---------------------------------------------------------------------------

  function collect() {
    els.enabled = document.getElementById('enabled');
    els.note = document.getElementById('note');
    els.noteText = document.getElementById('noteText');
    els.noteAction = document.getElementById('noteAction');
    els.controls = document.getElementById('controls');
    els.eqBands = document.getElementById('eqBands');
    els.preamp = document.getElementById('preamp');
    els.preampOut = document.getElementById('preampOut');
    els.bass = document.getElementById('bass');
    els.bassOut = document.getElementById('bassOut');
    els.mix = document.getElementById('mix');
    els.mixOut = document.getElementById('mixOut');
    els.decay = document.getElementById('decay');
    els.decayOut = document.getElementById('decayOut');
    els.reset = document.getElementById('reset');
  }

  function init() {
    collect();
    buildEq();
    render(DEFAULTS);

    ['preamp', 'bass', 'mix', 'decay'].forEach(function (key) {
      els[key].addEventListener('input', onUserChange);
    });

    els.enabled.addEventListener('change', onUserChange);

    var chips = document.querySelectorAll('.chip[data-preset]');
    for (var i = 0; i < chips.length; i++) {
      chips[i].addEventListener('click', function () {
        applyPreset(this.dataset.preset);
      });
    }

    els.reset.addEventListener('click', function () {
      render(DEFAULTS);
      saveNow();
    });

    load();
    checkActiveTab();
  }

  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
      init();
    }
  } catch (e) {
    showNote('Popup failed to initialise: ' + (e && e.message ? e.message : e));
  }
})();
