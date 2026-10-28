/*
 * YTM Sound Effects — popup UI.
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
  var saveTimer = null;
  var storageBroken = false;

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  function fmtDb(v) {
    var n = Math.round(v * 10) / 10;
    return (n > 0 ? '+' : '') + n + ' dB';
  }

  function fmtHz(hz) {
    return hz >= 1000 ? hz / 1000 + 'k' : String(hz);
  }

  function showNote(text) {
    if (!els.note) return;
    els.note.textContent = text;
    els.note.hidden = !text;
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
      band.className = 'band';

      var out = document.createElement('span');
      out.className = 'db';
      out.textContent = '0';

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

      var label = document.createElement('span');
      label.className = 'hz';
      label.textContent = fmtHz(hz);

      band.appendChild(out);
      band.appendChild(input);
      band.appendChild(label);
      frag.appendChild(band);

      bandInputs.push(input);
      bandOuts.push(out);

      input.addEventListener('input', function () {
        out.textContent = fmtDb(parseFloat(input.value) || 0);
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
      bandOuts[i].textContent = fmtDb(c.eq[i]);
    }

    updateLabels();
  }

  function updateLabels() {
    els.preampOut.textContent = fmtDb(parseFloat(els.preamp.value) || 0);
    els.bassOut.textContent = fmtDb(parseFloat(els.bass.value) || 0);
    els.mixOut.textContent = Math.round(parseFloat(els.mix.value) || 0) + ' %';
    els.decayOut.textContent = (Math.round((parseFloat(els.decay.value) || 0) * 10) / 10).toFixed(1) + ' s';
    els.controls.classList.toggle('off', !els.enabled.checked);
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
      showNote('chrome.storage is unavailable — settings will not persist.');
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
    scheduleSave();
  }

  function load() {
    if (!storageAvailable()) {
      storageBroken = true;
      showNote('chrome.storage is unavailable — showing defaults.');
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
    els.preset = document.getElementById('preset');
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

    els.preset.addEventListener('change', function () {
      applyPreset(els.preset.value);
    });

    els.reset.addEventListener('click', function () {
      els.preset.value = 'Flat';
      render(DEFAULTS);
      saveNow();
    });

    load();
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
