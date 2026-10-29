// UI polish layer: slider fills, button ripples, animated EQ curve.
// Purely visual — never changes values or touches popup.js logic.
(() => {
  "use strict";

  /* ---- Slider fill (supports centered/bipolar ranges) ---- */
  function paint(el) {
    const min = el.min === "" ? 0 : +el.min;
    const max = el.max === "" ? 100 : +el.max;
    const v = +el.value;
    const pct = (x) => ((x - min) / (max - min)) * 100;
    const bipolar = min < 0 && max > 0;
    const a = bipolar ? Math.min(pct(0), pct(v)) : 0;
    const b = bipolar ? Math.max(pct(0), pct(v)) : pct(v);
    el.style.setProperty("--a", a + "%");
    el.style.setProperty("--b", b + "%");
  }

  /* ---- Ripple on buttons ---- */
  document.addEventListener("pointerdown", (e) => {
    const btn = e.target.closest && e.target.closest(".chip,.tbtn,.mini,.ghost,.note-action");
    if (!btn || btn.disabled) return;
    const r = btn.getBoundingClientRect();
    const size = Math.max(r.width, r.height) * 2;
    const s = document.createElement("span");
    s.className = "ripple";
    s.style.width = s.style.height = size + "px";
    s.style.left = e.clientX - r.left - size / 2 + "px";
    s.style.top = e.clientY - r.top - size / 2 + "px";
    btn.appendChild(s);
    setTimeout(() => s.remove(), 650);
  });

  /* ---- Animated EQ response curve ---- */
  const stage = document.querySelector(".eq-stage");
  let cv = null, ctx = null, W = 0, H = 0;
  const cur = [];

  if (stage) {
    cv = document.createElement("canvas");
    cv.className = "curve";
    cv.setAttribute("aria-hidden", "true");
    const bands = stage.querySelector(".eq-bands");
    stage.insertBefore(cv, bands);
    ctx = cv.getContext("2d");
    const resize = () => {
      const r = stage.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      W = r.width; H = r.height;
      cv.width = Math.max(1, W * dpr);
      cv.height = Math.max(1, H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    new ResizeObserver(resize).observe(stage);
    resize();
  }

  function drawCurve(t) {
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    const inputs = [...stage.querySelectorAll(".eq-bands input[type=range]")];
    if (inputs.length < 2) return;
    const sr = stage.getBoundingClientRect();

    const pts = inputs.map((el, i) => {
      const r = el.getBoundingClientRect();
      const min = el.min === "" ? 0 : +el.min;
      const max = el.max === "" ? 100 : +el.max;
      const n = (+el.value - min) / (max - min);
      cur[i] = cur[i] === undefined ? n : cur[i] + (n - cur[i]) * 0.14; // eased
      const top = r.top + 7, bottom = r.bottom - 7;
      return { x: r.left + r.width / 2 - sr.left, y: bottom - sr.top - cur[i] * (bottom - top) };
    });

    const path = new Path2D();
    path.moveTo(pts[0].x, pts[0].y);
    for (let i = 0; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      path.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const last = pts[pts.length - 1];
    path.lineTo(last.x, last.y);

    // area fill
    const fill = new Path2D(path);
    fill.lineTo(last.x, H); fill.lineTo(pts[0].x, H); fill.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "rgba(255,45,68,0.30)");
    g.addColorStop(1, "rgba(255,45,68,0)");
    ctx.fillStyle = g;
    ctx.fill(fill);

    // glow line
    ctx.lineWidth = 2;
    ctx.lineJoin = ctx.lineCap = "round";
    ctx.strokeStyle = "#ff4a5e";
    ctx.shadowColor = "rgba(255,45,68,0.9)";
    ctx.shadowBlur = 14;
    ctx.stroke(path);

    // traveling pulse
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 2.5;
    ctx.setLineDash([36, 520]);
    ctx.lineDashOffset = -((t / 14) % 556);
    ctx.stroke(path);
    ctx.setLineDash([]);

    // node dots
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
    }
  }

  function frame(t) {
    if (!document.hidden) {
      document.querySelectorAll("input[type=range]").forEach((el) => {
        const key = el.value + "|" + el.min + "|" + el.max;
        if (el._k !== key) { el._k = key; paint(el); }
      });
      drawCurve(t);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
