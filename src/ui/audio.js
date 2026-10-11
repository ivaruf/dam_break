// OPUS C owns. The mixer: DAM BREAK's music and its cues, and NOTHING about
// the levels themselves — those, and the mute, are src/ui/sound.js's, and this
// reads them only through that file's music()/sfx()/muted()/onVolume().
//
// EVERY SOUND IS A FILE. The pieces are Sonic Pi compositions in tools/audio/
// (hub CLAUDE.md §9): rendered offline, encoded to audio/*.m4a — the loops by
// tools/audio/encode.mjs (per-file normalised stereo, cut to the exact loop),
// the cues by the hub's encode-oneshots.mjs (one shared gain, mono, trimmed).
// There is no runtime synthesis here at all. The two places a cue has to vary
// — the creak under load and the splash of a wave — vary DISCRETELY, per
// instance (one creak deeper than the last, one splash brighter), never
// continuously within a sound, so each is a file played at a chosen
// playbackRate and gain rather than an oscillator tracking a game value.
//
// THE AUDIO NEVER TOUCHES THE SIM. It listens to the events the game already
// emits (ARCHITECTURE.md §6) and reads getScene() once a frame from main.js;
// nothing here writes to the scene, the structure or the water, and nothing in
// src/physics knows this file exists. Determinism and the Node suites are
// untouched by construction: no test imports it.
//
// Graph:   track gain ─┐
//          track gain ─┴─ duck ─ musicBus ─┐
//          cue gain ───────────── sfxBus ──┴─ master (mute) ─ destination
//
// musicBus and sfxBus are the MUSIC and EFFECTS sliders, 1:1 — the number in
// the panel is the gain, with no hidden master behind it. `duck` drops the
// theme while the in-play menu stands over a run, so the panel reads as a
// pause without the music stopping dead. `master` is the corner speaker.

import { on } from '../core/events.js';
import { getScene } from '../core/game.js';
import * as sound from './sound.js';

const BASE = 'audio/';

// Loop lengths follow from the compositions (bpm × beats); `bar` is one bar in
// seconds. build and flood share a 3 s bar on purpose: the cut from one to the
// other lands at the same place in the bar, so the beat never stumbles when
// the water is released. `gain` is a per-track trim after the encoder's
// per-file normalisation, which equalises peaks, not loudness: measured
// (ebur128) the title encodes at -15.1 LUFS, build -20.6, flood -19.2, so
// these bring all three to about -21 and the slider means the same on every
// screen.
const TRACKS = {
  title: { file: 'music-title', loop: 32, bar: 4, gain: 0.5 },
  build: { file: 'music-build', loop: 48, bar: 3, gain: 0.85 },
  flood: { file: 'music-flood', loop: 48, bar: 3, gain: 0.8 },
};

const CUES = [
  'tap', 'chime', 'tick',
  'place-timber', 'place-steel', 'place-concrete', 'place-cable',
  'remove', 'refuse', 'release',
  'splash', 'gush', 'creak',
  'break-wood', 'break-metal', 'break-stone',
  'win', 'fail',
];

// Which break and which placement each material makes. Cable shares steel's
// break — both are metal under tension letting go.
const PLACE = { timber: 'place-timber', steel: 'place-steel', concrete: 'place-concrete', cable: 'place-cable' };
const BREAK = { timber: 'break-wood', steel: 'break-metal', cable: 'break-metal', concrete: 'break-stone' };

// Minimum seconds between two plays of one cue, on AudioContext time — the
// only clock that runs on every screen (the sim's fixed step is held while a
// menu is up, and a throttle on it would swallow every cue after the first).
const GAP = {
  tap: 0.05, chime: 0.25, tick: 0.3,
  'place-timber': 0.04, 'place-steel': 0.04, 'place-concrete': 0.04, 'place-cable': 0.04,
  remove: 0.05, refuse: 0.12, release: 1.0,
  splash: 0.3, gush: 3.0, creak: 0.5,
  'break-wood': 0.07, 'break-metal': 0.07, 'break-stone': 0.07,
  win: 1.0, fail: 1.0,
};

// The creak: how hard the worst-loaded member has to be working before the
// dam starts to complain, and the spacing between complaints at the bottom and
// top of that range. 0.75 is just past CONFIG.damage.creepStart (0.7), where
// damage begins to accumulate, so a creak always means "this is wearing".
const CREAK_FROM = 0.75;
const CREAK_FULL = 1.2;
const CREAK_SLOW = 2.4;   // s between creaks at CREAK_FROM
const CREAK_FAST = 0.75;  // s between creaks at CREAK_FULL and above

const DUCK = 0.45;        // the theme's level while the in-play menu is open
const FADE_IN = 1.2;      // s, a theme arriving
const FADE_OUT = 0.9;     // s, a theme leaving
const AFTER_STING = 2.8;  // s of quiet on the result card before the title theme

let ctx = null;
let master = null, musicBus = null, sfxBus = null, duck = null;
let dead = false;          // no Web Audio at all: every call is a no-op
const buffers = new Map(); // name -> Promise<AudioBuffer|null>
const lastPlayed = Object.create(null);

let wanted = null;         // the theme the current screen asks for (or null)
let current = null;        // { name, source, gain, t0 } — t0: when bar phase was 0
let stingTimer = 0;

let lastPhase = null;
let lastTickSec = -1;
let nextCreak = 0;
let ducked = false;

// Slider bookkeeping, so onVolume() can tell WHICH fader moved.
let prevMusic = sound.music();
let prevSfx = sound.sfx();

// ---- loading ---------------------------------------------------------------

// XMLHttpRequest rather than fetch(): it is the same request through the
// service worker over http(s), and it also works under file:// in a browser
// started with file access, which is how the headless checks run (fetch()
// refuses the file: scheme outright).
function get(url) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => (xhr.status === 200 || (xhr.status === 0 && xhr.response)
      ? resolve(xhr.response) : reject(new Error('HTTP ' + xhr.status)));
    xhr.onerror = () => reject(new Error('network'));
    xhr.send();
  });
}

function load(name) {
  if (!buffers.has(name)) {
    buffers.set(name, get(BASE + name + '.m4a')
      // The callback form as well as the promise: older Safari only has the
      // former, and resolves nothing from the latter.
      .then((data) => new Promise((ok, fail) => {
        const p = ctx.decodeAudioData(data, ok, fail);
        if (p && typeof p.then === 'function') p.then(ok, fail);
      }))
      .catch((err) => {
        // A missing sound costs that sound and never the game.
        console.warn('DAM BREAK: sound "' + name + '" unavailable', err && err.message);
        return null;
      }));
  }
  return buffers.get(name);
}

// Some decoders put the AAC encoder's priming silence back in front of the
// audio. Loop from the first real sample, not from zero, or every lap of the
// theme gets a gap at the seam.
function firstSound(buffer) {
  const data = buffer.getChannelData(0);
  const limit = Math.min(data.length, buffer.sampleRate * 0.2);
  for (let i = 0; i < limit; i++) if (Math.abs(data[i]) > 1e-4) return i / buffer.sampleRate;
  return 0;
}

// ---- the graph -------------------------------------------------------------

/** Build the graph on the first gesture (browsers refuse audio before one),
 *  and on every later gesture wake a context the OS has suspended — iOS does
 *  that on a phone call or a lock screen. Safe to call any number of times. */
export function unlock() {
  if (dead) return;
  if (ctx) {
    if (ctx.state === 'suspended' && !document.hidden) ctx.resume().catch(() => {});
    return;
  }
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) { dead = true; return; }
  try { ctx = new AC(); } catch { dead = true; return; }

  master = ctx.createGain();
  master.gain.value = sound.muted() ? 0 : 1;
  master.connect(ctx.destination);
  musicBus = ctx.createGain();
  musicBus.gain.value = sound.music();
  musicBus.connect(master);
  duck = ctx.createGain();
  duck.gain.value = ducked ? DUCK : 1;
  duck.connect(musicBus);
  sfxBus = ctx.createGain();
  sfxBus.gain.value = sound.sfx();
  sfxBus.connect(master);

  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  for (const name of CUES) load(name);
  if (wanted) startMusic(wanted);
  if (wanted === 'build') load(TRACKS.flood.file);
}

function ramp(param, value, tau) {
  const now = ctx.currentTime;
  param.cancelScheduledValues(now);
  param.setTargetAtTime(value, now, tau);
}

// ---- music -----------------------------------------------------------------

function fadeOut(entry, seconds) {
  const now = ctx.currentTime;
  const g = entry.gain.gain;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(0, now + seconds);
  try { entry.source.stop(now + seconds + 0.05); } catch { /* already stopped */ }
}

async function startMusic(name) {
  const spec = TRACKS[name];
  const buffer = spec && await load(spec.file);
  // The screen may have moved on while this decoded; only the latest wish wins.
  if (!buffer || wanted !== name || (current && current.name === name)) return;

  const start = firstSound(buffer);
  const now = ctx.currentTime;
  // Same bar length as what is playing (build → flood): enter at the same
  // point in the bar, so the cross-fade keeps the beat. Otherwise from the top.
  let phase = 0;
  if (current && TRACKS[current.name].bar === spec.bar) {
    phase = ((now - current.t0) % spec.bar + spec.bar) % spec.bar;
  }
  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  source.buffer = buffer;
  source.loop = true;
  source.loopStart = start;
  source.loopEnd = Math.min(buffer.duration, start + spec.loop);
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(spec.gain, now + FADE_IN);
  source.connect(gain);
  gain.connect(duck);
  source.start(now, start + phase);
  if (current) fadeOut(current, FADE_OUT);
  current = { name, source, gain, t0: now - phase };
}

/** Ask for a theme by name, or null for quiet. Before the first gesture this
 *  only records the wish; unlock() honours it. */
export function music(name) {
  wanted = name || null;
  if (!ctx) return;
  if (!wanted) {
    if (current) fadeOut(current, FADE_OUT);
    current = null;
    return;
  }
  startMusic(wanted);
}

// ---- cues ------------------------------------------------------------------

/** Play one cue on a bus (sfx unless told otherwise). Throttled per cue on
 *  AudioContext time; `rate` and `gain` are the per-instance variation. */
export function play(name, { gain = 1, rate = 1, bus = null } = {}) {
  // Not 'running' only: on the very first gesture the context is still
  // resuming, and a cue started now plays the moment it does — which is how
  // the tap that unlocked the audio is also heard. A HIDDEN page is the
  // exception: there a queued cue would burst out when the tab came back.
  if (!ctx || ctx.state === 'closed' || document.hidden) return;
  const now = ctx.currentTime;
  const gap = GAP[name] || 0;
  if (lastPlayed[name] !== undefined && now - lastPlayed[name] < gap) return;
  lastPlayed[name] = now;
  load(name).then((buffer) => {
    if (!buffer) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    source.connect(g);
    g.connect(bus || sfxBus);
    source.start();
  });
}

const jitter = (spread) => 1 + (Math.random() * 2 - 1) * spread;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Physics cues only from a real run. The title diorama is the actual engine
// and fires the same 'member:break' and 'breach' events behind the menu;
// those are scenery, and the menu is not the place for a dam to be heard
// failing over and over.
function inRun() {
  const S = getScene();
  return !!S && S.phase === 'sim' && !!S.level;
}

function wireCues() {
  on('design:change', ({ action, mat, count }) => {
    if (action === 'place') play(PLACE[mat] || 'place-timber', { rate: jitter(0.04) });
    else if (action === 'delete') play('remove', count > 1 ? { rate: 0.85, gain: 1.15 } : { rate: jitter(0.05) });
    else if (action === 'move') play('tap', { rate: 0.8 });
  });
  on('design:refuse', () => play('refuse'));
  on('sim:start', () => { if (getScene().level) play('release'); });

  on('member:break', ({ matId, load }) => {
    if (!inRun()) return;
    // A creep failure (load < 1) is quieter than an overload snap.
    play(BREAK[matId] || 'break-wood', { rate: jitter(0.06), gain: 0.75 + 0.25 * clamp01((load || 0) - 0.6) });
  });
  on('water:impact', ({ speed }) => {
    if (!inRun()) return;
    const hard = clamp01(((speed || 0) - 3) / 5);
    // Harder hits are louder and a little lower, softer ones brighter.
    play('splash', { gain: 0.4 + 0.6 * hard, rate: (1.15 - 0.3 * hard) * jitter(0.05) });
  });
  const gush = () => { if (inRun()) play('gush', { gain: 0.65, rate: jitter(0.08) }); };
  on('breach', gush);
  on('overtop', gush);

  on('level:win', () => play('win'));
  on('level:fail', () => play('fail'));

  // Taps for the chrome. RELEASE has its own much bigger sound, and the level
  // cards, the menu and the toolbar all count; a disabled button says nothing.
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('click', (e) => {
      const t = e.target && e.target.closest ? e.target.closest('button, [role="button"]') : null;
      if (!t || t.disabled || t.getAttribute('aria-disabled') === 'true') return;
      if (t.id === 'btn-release') return;
      play('tap', { rate: jitter(0.03) });
    });
  }
}

// ---- the faders and the mute ----------------------------------------------

// A fader you cannot hear is a fader you cannot use (hub §2). Dragging MUSIC
// with a theme playing is its own audition; with none (still loading, or the
// result card's moment of quiet) it sounds the chime on the MUSIC bus.
// EFFECTS sounds a timber knock on the EFFECTS bus. Deferred a microtask
// because screens.js lifts the mute in the same tick, AFTER writing the level,
// and the audition must land on the un-muted master.
function audition(which) {
  queueMicrotask(() => {
    unlock();
    if (!ctx) return;
    if (which === 'music') {
      if (!current) play('chime', { bus: musicBus });
    } else {
      play('place-timber', { rate: jitter(0.04) });
    }
  });
}

function wireLevels() {
  sound.onVolume((m, s, isMuted) => {
    if (ctx) {
      ramp(musicBus.gain, m, 0.03);
      ramp(sfxBus.gain, s, 0.03);
      ramp(master.gain, isMuted ? 0 : 1, 0.04);
    }
    if (m !== prevMusic) { prevMusic = m; audition('music'); }
    if (s !== prevSfx) { prevSfx = s; audition('sfx'); }
  });
}

// ---- per frame -------------------------------------------------------------

function themeFor(phase) {
  if (phase === 'title' || phase === 'levelselect') return 'title';
  if (phase === 'build') return 'build';
  if (phase === 'sim') return 'flood';
  return null;
}

function onPhase(phase) {
  clearTimeout(stingTimer);
  lastTickSec = -1;
  nextCreak = 0;
  if (phase === 'result') {
    // Quiet under the sting, then the calm theme back under the card.
    music(null);
    stingTimer = setTimeout(() => { if (getScene().phase === 'result') music('title'); }, AFTER_STING * 1000);
    return;
  }
  music(themeFor(phase));
  // Decode the flood theme while the player builds, so it is ready the
  // instant the water goes — a release that waits on a decode starts silent.
  if (phase === 'build' && ctx) load(TRACKS.flood.file);
}

/** Called once per animation frame from main.js, after game.frame(). Reads the
 *  scene, writes nothing, allocates nothing. */
export function frame() {
  const S = getScene();
  if (!S) return;
  if (S.phase !== lastPhase) { lastPhase = S.phase; onPhase(S.phase); }
  if (!ctx || ctx.state !== 'running') return;

  const running = !S.covered && S.simSpeed > 0;

  // The in-play menu ducks the theme rather than stopping it.
  if (S.covered !== ducked) {
    ducked = !!S.covered;
    ramp(duck.gain, ducked ? DUCK : 1, 0.12);
  }

  // The last five seconds of a countdown build, one tock a second; the final
  // second a little higher. Frozen with the timer while the menu is up.
  if (S.phase === 'build' && S.level && S.level.mode === 'countdown' && running) {
    const sec = Math.ceil(S.buildTimer);
    if (sec !== lastTickSec) {
      if (sec >= 1 && sec <= 5 && lastTickSec !== -1) play('tick', { rate: sec === 1 ? 1.25 : 1 });
      lastTickSec = sec;
    }
  }

  // The creak: the worst-loaded member still standing, read straight off the
  // structure. A plain loop with no allocation; a dam is a few hundred members.
  if (S.phase === 'sim' && S.structure && S.level && running) {
    const ms = S.structure.members;
    let worst = 0;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (!m.broken && m.load > worst) worst = m.load;
    }
    const now = ctx.currentTime;
    if (worst >= CREAK_FROM && now >= nextCreak) {
      const t = clamp01((worst - CREAK_FROM) / (CREAK_FULL - CREAK_FROM));
      // Deeper and louder the harder it works; never twice at the same pitch.
      play('creak', { gain: 0.45 + 0.55 * t, rate: (1.05 - 0.3 * t) * jitter(0.06) });
      nextCreak = now + (CREAK_SLOW + (CREAK_FAST - CREAK_SLOW) * t) * jitter(0.25);
    }
  }
}

/** For the console (window.DAM.audio.status()) and the headless check: what
 *  the context is doing, which theme is up, and how many files decoded. */
export async function status() {
  const names = [...buffers.keys()];
  const got = await Promise.all(names.map((n) => buffers.get(n)));
  return {
    state: ctx ? ctx.state : dead ? 'unavailable' : 'locked',
    theme: current ? current.name : null,
    loaded: got.filter(Boolean).length,
    failed: names.filter((n, i) => !got[i]),
  };
}

// ---- boot ------------------------------------------------------------------

/** Called once from main.js. Builds nothing yet — the graph waits for the
 *  first gesture — but listens from the start, so the very first tap both
 *  unlocks the audio and is heard. */
export function init() {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  const wake = () => unlock();
  // Capture, so a handler that stops propagation cannot keep the audio asleep.
  for (const type of ['pointerdown', 'touchend', 'keydown', 'click']) {
    window.addEventListener(type, wake, { capture: true, passive: true });
  }
  // A hidden tab goes quiet and costs nothing; coming back wakes it, unless
  // it was never unlocked in the first place.
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend().catch(() => {});
    else ctx.resume().catch(() => {});
  });
  wireCues();
  wireLevels();
}
