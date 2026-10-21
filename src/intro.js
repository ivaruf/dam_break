/*
 * intro.js — the three-second sting that plays when the game opens.
 *
 * The game's whole story in one breath. A flood wave runs in from the left,
 * gathering height, and slams into a little timber dam; the water piles up
 * against it, the dam shakes, a crack flashes through it — and it goes,
 * beams tumbling away on the torrent. Out of that the wordmark slams down
 * exactly where the title screen keeps it, the rule under it snaps into its
 * broken shape, and the curtain fades onto the live title diorama, which is
 * the same flood playing out for real. It is the icon (tools/make-icons.py:
 * a wave over a small timber dam) set going, in the game's own palette
 * (src/config.js CONFIG.render, materials.js timber, styles.css --accent).
 *
 * The only words are DAMBREAK itself, which is the game's name and is never
 * translated (hub §2), so there is nothing here for src/i18n.js to do.
 *
 * WITH THE SPLASH, NOT ON TOP OF IT
 *   index.html already has a splash: inline markup that paints the wordmark
 *   on the very first frame, before any script, and that screens.init()
 *   takes down once the game can draw. This does not replace it and does not
 *   touch it. The curtain sits above it (z-index in styles.css, #intro) and
 *   lands its wordmark on the title's real <h1> — which the splash's own
 *   wordmark deliberately matches — so when the curtain lifts, whichever of
 *   the two is underneath (the splash on a slow cold load, the title on any
 *   other) has the letters already in the same place. With no JavaScript, or
 *   with reduced motion, the splash is exactly what it always was.
 *
 * WHAT IT MAY NOT DO
 *   - Cost anyone a run (hub §1). It only ever plays at page load, over the
 *     title screen, and any tap or key skips straight to the hand-off.
 *   - Let the skipping press through. A key is swallowed in the capture
 *     phase on window — capture on window runs before anything bubbling, and
 *     this script runs async from the top of <body>, long before the module
 *     graph, so it is registered ahead of src/core/input.js's window keydown
 *     and src/ui/audio.js's capture-phase wake — because the press that
 *     skips must not also be the title's Escape (which is the way out to the
 *     arcade) or its Space. A tap lands on the curtain itself, which covers
 *     every button.
 *   - Delay the game. It is a curtain over the page, not a gate in front of
 *     it: the modules, the audio and the title diorama boot underneath while
 *     it plays.
 *   - Play for someone who has asked for less motion. prefers-reduced-motion
 *     means the script does nothing at all.
 *
 * A classic script, self-contained, importing nothing, for the reason
 * touch-guard.js and screen.js stand apart: if anything in the module graph
 * fails, the curtain must still lift. Every frame runs inside a try, a hard
 * timeout removes the curtain whatever happens, and a failure of this file
 * leaves the game exactly as it was without it.
 *
 * Canvas 2D, devicePixelRatio capped at 2, geometry precomputed once and no
 * allocation in the frame loop (hub §10) — gradients are rebuilt on resize
 * only, and the title's box is measured once.
 */
(function () {
  "use strict";

  try {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  } catch (e) {
    /* No matchMedia: play it. */
  }

  // The palette, copied rather than imported because this file imports
  // nothing. CONFIG.render's sky and terrain, the icon's water, timber from
  // materials.js, and the accent the wordmark wears.
  var SKY_TOP = "#08131d";
  var SKY_LOW = "#1b4258";
  var GROUND = "#2c3729";
  var GROUND_EDGE = "#6d8f4e";
  var WATER_HI = "#49a8e0";
  var WATER_MID = "#1c6fb4";
  var WATER_LO = "#07274a";
  var FOAM = "#e6f5ff";
  var TIMBER = "#c8954a";
  var TIMBER_DK = "#6e4a18";
  var TEXT = "#dfe9f0";
  var ACCENT = "#35a7ff";
  var ACCENT_DIM = "#1d5f8a";

  // The timeline, in milliseconds. SURGE: the wave runs in. IMPACT: it hits
  // the dam and piles up. CRACK: the flash through the timber. BREAK: the dam
  // goes and the torrent runs on. WORD_IN: the wordmark slams down, and
  // RULE_SNAP later the rule under it drops into its broken shape. LAND
  // starts the hand-off, which takes LAND_MS (or SKIP_MS when skipped).
  var IMPACT = 900;
  var CRACK = 1300;
  var BREAK = 1450;
  var FLOOD_MS = 750;
  var WORD_IN = 1550;
  var WORD_MS = 420;
  var RULE_SNAP = 1900;
  var LAND = 2650;
  var LAND_MS = 600;
  var SKIP_MS = 350;

  // The dam, in its own unit box (x 0..1 left to right, y 0..1 top to
  // bottom): two posts and a middle one, three rails, four braces — the
  // little lattice from the icon. Per member, a fixed scatter for when it
  // breaks: velocity (unit boxes per second) and spin (radians per second).
  // Fixed rather than random so the sting is the same every time.
  var MEMBERS = [
    0.1, 0, 0.1, 1,
    0.9, 0, 0.9, 1,
    0.5, 0, 0.5, 1,
    0, 0.04, 1, 0.04,
    0, 0.5, 1, 0.5,
    0, 0.96, 1, 0.96,
    0.1, 0.5, 0.5, 0.04,
    0.5, 0.5, 0.9, 0.04,
    0.1, 0.96, 0.5, 0.5,
    0.5, 0.96, 0.9, 0.5,
  ];
  var NM = MEMBERS.length / 4;
  var scatter = new Float32Array(NM * 3);
  for (var m = 0; m < NM; m++) {
    scatter[m * 3] = 1.6 + ((m * 37) % 11) / 5; // vx: all downstream
    scatter[m * 3 + 1] = -1.1 - ((m * 53) % 7) / 6; // vy: up first
    scatter[m * 3 + 2] = (m % 2 ? 1 : -1) * (2 + ((m * 29) % 5)); // spin
  }

  // Spray: two bursts of droplets, one off the impact (thrown back and up
  // the dam face) and one off the break (thrown downstream). Angle and speed
  // per droplet, fixed for the same reason.
  var NS = 30;
  var spray = new Float32Array(NS * 2);
  for (var s = 0; s < NS; s++) {
    var first = s < NS / 2;
    var k = (s * 0.61803) % 1;
    // Angles measured from straight up; negative leans upstream (left).
    spray[s * 2] = first ? -1.2 + k * 1.4 : -0.2 + k * 1.3;
    spray[s * 2 + 1] = 0.55 + ((s * 7) % 10) / 11;
  }

  // The water's surface is sampled at this many points across its length.
  var SURF = 28;

  var canvas = document.createElement("canvas");
  canvas.id = "intro";
  canvas.setAttribute("aria-hidden", "true");
  var ctx = canvas.getContext("2d");
  if (!ctx) return;

  var W = 0;
  var H = 0;
  var dpr = 1;
  var U = 1; // the scene's unit: the short side of the screen
  var groundY = 0;
  var damX = 0;
  var damW = 0;
  var damH = 0;
  var skyGrad = null;
  var waterGrad = null;
  // The curtain's opacity this frame. Every layer multiplies its own alpha
  // by it, so the whole scene thins away together during the hand-off.
  var fade = 1;

  function size() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    U = Math.min(W, H);
    // The scene is laid low, so the wordmark (high on the title) stands in
    // open sky above it and never over the dam.
    groundY = H * 0.84;
    // Tall enough to read on a portrait phone, not a wall on a wide desk.
    damH = Math.min(H * 0.3, W * 0.4);
    damW = damH * 0.6;
    damX = W * 0.58 - damW / 2;
    skyGrad = ctx.createLinearGradient(0, 0, 0, H);
    skyGrad.addColorStop(0, SKY_TOP);
    skyGrad.addColorStop(1, SKY_LOW);
    waterGrad = ctx.createLinearGradient(0, groundY - damH * 1.1, 0, groundY);
    waterGrad.addColorStop(0, WATER_HI);
    waterGrad.addColorStop(0.35, WATER_MID);
    waterGrad.addColorStop(1, WATER_LO);
    // A resize re-measures the title on the next frame that needs it.
    target = null;
  }

  function clamp01(x) {
    return x < 0 ? 0 : x > 1 ? 1 : x;
  }
  function easeIn(x) {
    return x * x * x;
  }
  function easeOut(x) {
    return 1 - Math.pow(1 - x, 3);
  }
  function easeOutBack(x) {
    var c = 1.7;
    return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2);
  }
  function easeInOut(x) {
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  }

  // ---- the title's wordmark, measured once ------------------------------
  //
  // Where the <h1> actually draws its letters (a Range round its text, not
  // the block's box, which is as wide as the column), its font as computed,
  // and the canvas widths of the two halves in that font. The canvas text is
  // then scaled so DAM+BREAK spans exactly the real letters, which absorbs a
  // browser without canvas letterSpacing. Nothing is hidden: the hand-off is
  // a cross-fade onto letters already in the same place.
  var target = null;
  var word = { x: 0, y: 0, w: 0, h: 0, fs: 0, a: 0, b: 0, font: "", ls: "0px" };
  var rule = null;
  var remeasured = false;
  function findTarget() {
    var h1 = document.querySelector("#screen-title .logo h1");
    if (!h1) return false;
    var range = document.createRange();
    range.selectNodeContents(h1);
    var b = range.getBoundingClientRect();
    if (b.width < 2 || b.height < 2) return false;
    var cs = getComputedStyle(h1);
    word.fs = parseFloat(cs.fontSize) || 60;
    word.font = cs.fontWeight + " " + word.fs + "px " + cs.fontFamily;
    ctx.font = word.font;
    if ("letterSpacing" in ctx) ctx.letterSpacing = cs.letterSpacing;
    word.a = ctx.measureText("DAM").width;
    word.b = ctx.measureText("BREAK").width;
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
    word.x = b.left;
    word.y = b.top + b.height / 2;
    word.w = b.width;
    word.h = b.height;
    var r = document.querySelector("#screen-title .logo-rule");
    if (r) {
      var rb = r.getBoundingClientRect();
      if (rb.width > 2) rule = { x: rb.left, y: rb.top, w: rb.width };
    }
    word.ls = cs.letterSpacing;
    return true;
  }

  var t0 = 0;
  var landAt = LAND;
  var landMs = LAND_MS;
  var done = false;
  var raf = 0;

  function finish() {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", size);
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  }

  function skip() {
    var now = performance.now() - t0;
    if (now >= landAt) return;
    landAt = now;
    landMs = SKIP_MS;
  }

  function onKey(e) {
    // Skip, and let the press go no further: see the header.
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!e.repeat) skip();
  }

  // ---- the scene ---------------------------------------------------------

  // The water body: a surface from the left edge to the front, then the
  // front face curling over and down to the ground. `front` is the x of the
  // front, `lvl` its height above the ground, `rise` how much higher the
  // crest stands than the water behind it, `t` the clock for the swell.
  function drawWater(front, lvl, rise, t) {
    var x;
    var y;
    ctx.globalAlpha = fade;
    ctx.fillStyle = waterGrad;
    ctx.beginPath();
    ctx.moveTo(-4, groundY + 2);
    for (var i = 0; i <= SURF; i++) {
      var u = i / SURF;
      x = -4 + (front + 4) * u;
      y = groundY - lvl * (1 - rise + rise * u * u) + Math.sin(u * 11 - t * 0.008) * U * 0.008;
      ctx.lineTo(x, y);
    }
    // The curl: over the front, then down its face.
    ctx.quadraticCurveTo(front + lvl * 0.32, groundY - lvl * 0.78, front + lvl * 0.06, groundY - lvl * 0.45);
    ctx.lineTo(front + lvl * 0.12, groundY + 2);
    ctx.closePath();
    ctx.fill();

    // Foam along the crest, the brightest thing in the frame.
    ctx.strokeStyle = FOAM;
    ctx.lineWidth = Math.max(2, U * 0.009);
    ctx.lineCap = "round";
    ctx.beginPath();
    for (var j = Math.floor(SURF * 0.62); j <= SURF; j++) {
      var v = j / SURF;
      x = -4 + (front + 4) * v;
      y = groundY - lvl * (1 - rise + rise * v * v) + Math.sin(v * 11 - t * 0.008) * U * 0.008;
      if (j === Math.floor(SURF * 0.62)) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.quadraticCurveTo(front + lvl * 0.32, groundY - lvl * 0.78, front + lvl * 0.06, groundY - lvl * 0.45);
    ctx.stroke();
  }

  function drawDam(t) {
    var broke = t >= BREAK;
    var dt = (t - BREAK) / 1000;
    // Strain: from the impact to the break the whole frame shudders, harder
    // as the water piles up.
    var shake = 0;
    if (t > IMPACT && !broke) {
      shake = Math.sin(t * 0.11) * U * 0.006 * clamp01((t - IMPACT) / (BREAK - IMPACT));
    }
    var lw = Math.max(3, U * 0.016);
    ctx.globalAlpha = fade;
    ctx.lineCap = "round";
    for (var pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass === 0 ? TIMBER_DK : TIMBER;
      ctx.lineWidth = pass === 0 ? lw + 3 : lw;
      for (var i = 0; i < NM; i++) {
        var x1 = damX + MEMBERS[i * 4] * damW;
        var y1 = groundY - damH + MEMBERS[i * 4 + 1] * damH;
        var x2 = damX + MEMBERS[i * 4 + 2] * damW;
        var y2 = groundY - damH + MEMBERS[i * 4 + 3] * damH;
        var mx = (x1 + x2) / 2 + shake;
        var my = (y1 + y2) / 2;
        var ang = 0;
        if (broke) {
          // Thrown downstream and up, then falling: a beam on a torrent.
          mx += scatter[i * 3] * damW * dt;
          my += scatter[i * 3 + 1] * damH * dt + 2.6 * damH * dt * dt;
          ang = scatter[i * 3 + 2] * dt;
        }
        var c = Math.cos(ang);
        var sn = Math.sin(ang);
        var hx = (x2 - x1) / 2;
        var hy = (y2 - y1) / 2;
        ctx.setTransform(dpr * c, dpr * sn, -dpr * sn, dpr * c, dpr * mx, dpr * my);
        ctx.beginPath();
        ctx.moveTo(-hx, -hy);
        ctx.lineTo(hx, hy);
        ctx.stroke();
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // The crack: a white fork down the timber, gone in a blink.
    var f = (t - CRACK) / 260;
    if (f >= 0 && f <= 1) {
      ctx.globalAlpha = (1 - f) * fade;
      ctx.strokeStyle = FOAM;
      ctx.lineWidth = Math.max(2, U * 0.007);
      ctx.beginPath();
      ctx.moveTo(damX + damW * 0.42, groundY - damH * 1.02);
      ctx.lineTo(damX + damW * 0.58, groundY - damH * 0.74);
      ctx.lineTo(damX + damW * 0.4, groundY - damH * 0.5);
      ctx.lineTo(damX + damW * 0.62, groundY - damH * 0.22);
      ctx.lineTo(damX + damW * 0.48, groundY + 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawSpray(t) {
    ctx.fillStyle = FOAM;
    for (var i = 0; i < NS; i++) {
      var first = i < NS / 2;
      var born = first ? IMPACT : BREAK;
      var age = (t - born) / 1000;
      if (age <= 0 || age > 0.9) continue;
      var ox = first ? damX : damX + damW * 0.5;
      var oy = groundY - damH * (first ? 0.85 : 0.6);
      var a = spray[i * 2];
      var sp = spray[i * 2 + 1] * damH * 2.4;
      var x = ox + Math.sin(a) * sp * age;
      var y = oy - Math.cos(a) * sp * age + 3.2 * damH * age * age;
      ctx.globalAlpha = (1 - age / 0.9) * fade;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1.5, U * (0.005 + (i % 3) * 0.002)), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // The flood, phase by phase: the surge in, the pile-up against the dam,
  // then the torrent once it has gone.
  function drawFlood(t) {
    var front;
    var lvl;
    var rise;
    if (t < IMPACT) {
      var p = easeIn(clamp01(t / IMPACT));
      front = -damH + (damX + damH) * p;
      lvl = damH * (0.45 + 0.4 * p);
      rise = 0.5;
    } else if (t < BREAK) {
      var q = clamp01((t - IMPACT) / (BREAK - IMPACT));
      front = damX;
      lvl = damH * (0.85 + 0.12 * easeOut(q));
      rise = 0.5 - 0.35 * q; // the crest settles into a level reservoir
    } else {
      var r = easeOut(clamp01((t - BREAK) / FLOOD_MS));
      front = damX + (W - damX + damH) * r;
      lvl = damH * (0.97 - 0.5 * r);
      rise = 0.15 + 0.25 * r;
    }
    drawWater(front, lvl, rise, t);
  }

  // The wordmark, scale `s` about its own centre, at opacity `alpha`; then
  // the broken rule under it, `snap` of the way into its broken shape.
  function drawWord(s, alpha, snap) {
    if (!target) return;
    var total = word.a + word.b;
    var k = (word.w / total) * s;
    var cx = word.x + word.w / 2;
    ctx.globalAlpha = alpha;
    ctx.font = word.font;
    if ("letterSpacing" in ctx) ctx.letterSpacing = word.ls;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    // The title's own hard shadow, so the letters stand off the water the
    // way they stand off the diorama.
    ctx.shadowColor = "rgba(4, 10, 16, 0.95)";
    ctx.shadowBlur = 6 * dpr;
    ctx.shadowOffsetY = 2 * dpr;
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * (cx - (total / 2) * k), dpr * word.y);
    ctx.fillStyle = TEXT;
    ctx.fillText("DAM", 0, 0);
    ctx.fillStyle = ACCENT;
    ctx.fillText("BREAK", word.a, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";

    // The rule: the long beam, then the short one that drops and tilts off
    // its end — styles.css .logo-rule, drawn to its geometry, so the name
    // breaks the moment after the dam did.
    if (rule) {
      ctx.fillStyle = ACCENT;
      ctx.fillRect(rule.x, rule.y, rule.w * 0.5, 3);
      var a = 2.6 * (Math.PI / 180) * snap;
      var c = Math.cos(a);
      var sn = Math.sin(a);
      var bw = rule.w * 0.34;
      ctx.setTransform(dpr * c, dpr * sn, -dpr * sn, dpr * c, dpr * (rule.x + rule.w - bw / 2), dpr * (rule.y + 1.5 + 7 * snap));
      ctx.fillStyle = snap > 0.5 ? ACCENT_DIM : ACCENT;
      ctx.fillRect(-bw / 2, -1.5, bw, 3);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    ctx.globalAlpha = 1;
  }

  function frame(now) {
    if (done) return;
    try {
      if (!t0) t0 = now;
      var t = now - t0;
      var land = clamp01((t - landAt) / landMs);
      if (land >= 1) {
        finish();
        return;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      // The whole scene is the curtain, and thins away during the hand-off
      // to let the title (or the splash, on a slow load) show through.
      // A skip simply lets the scene go on playing as it fades.
      fade = 1 - easeInOut(land);
      ctx.globalAlpha = fade;
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = GROUND;
      ctx.fillRect(0, groundY, W, H - groundY);
      if (fade > 0.01) {
        drawFlood(t);
        drawDam(t);
        drawSpray(t);
        ctx.globalAlpha = fade;
        ctx.strokeStyle = GROUND_EDGE;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(0, groundY + 1.5);
        ctx.lineTo(W, groundY + 1.5);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // The wordmark: slams down from a little larger than life, then holds
      // where the title keeps it, and cross-fades onto the real letters.
      var wi = (t - WORD_IN) / WORD_MS;
      if (land > 0 && wi < 1) wi = 1; // a skip before the slam lands it whole
      if (wi > 0) {
        // Measured when the wordmark first needs it, and once more as the
        // hand-off begins: by then the title may have shown its quit button
        // or repainted in English, and either can move the column.
        if (land > 0 && !remeasured) {
          remeasured = true;
          target = null;
        }
        if (target === null) target = findTarget();
        var s = 1 + 0.6 * (1 - easeOutBack(clamp01(wi)));
        var alpha = clamp01(wi * 3) * (1 - easeInOut(clamp01((land - 0.35) / 0.65)));
        var snap = land > 0 && t < RULE_SNAP ? 1 : easeOutBack(clamp01((t - RULE_SNAP) / 260));
        drawWord(s, alpha, snap);
      }
    } catch (e) {
      finish();
      return;
    }
    raf = requestAnimationFrame(frame);
  }

  function start() {
    size();
    window.addEventListener("resize", size);
    window.addEventListener("keydown", onKey, true);
    canvas.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      skip();
    });
    document.body.appendChild(canvas);
    raf = requestAnimationFrame(frame);
    // Whatever happens to the frame loop, the curtain does not outstay this.
    setTimeout(finish, 6000);
  }

  // Loaded from the top of <body>, so the body exists even though the rest
  // of the page may not have been parsed yet.
  start();
})();
