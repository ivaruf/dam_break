// OPUS C owns. The two volume levels and the mute — and NOTHING else.
//
// The mixer is src/ui/audio.js, and it takes exactly two things from here and
// no other route to them:
//
//   music()/sfx()/muted()   the current gains, 0..1, and the corner's mute
//   onVolume(fn)            a subscription, fired whenever any of them moves,
//                           so the buses track a slider while it is dragged
//
// Setting a volume MAKES a sound while you set it (hub §2) — a control you
// cannot hear is a control you cannot use. That audition lives in audio.js's
// onVolume() listener, not in screens.js, which knows about sliders and should
// never learn about gain nodes.
//
// These levels predate the audio by a release: the panel shipped while the
// game was still silent, so a player who set them then hears the water at the
// level they chose.
//
// Keys are versioned per hub CLAUDE.md §6 and are now permanent: a key holding
// a player's setting can never be renamed without silently resetting it, which
// is why dam_break still carries 'dam-builder-save-v1' three names later.

const KEY_MUSIC = 'dam_break.vol.music.v1';
const KEY_SFX = 'dam_break.vol.sfx.v1';
// The corner speaker's state since 2026-10-11, when it stopped opening a panel
// and became the hub's live mute. '1' muted, anything else audible.
const KEY_MUTE = 'dam_break.mute.v1';

// Neither default is 1.0 on purpose. Music sits under everything and wants
// headroom; the cues — a beam cracking, water hitting stone — are the half of
// a flood that tells you what just happened, so they start louder.
const DEFAULT_MUSIC = 0.6;
const DEFAULT_SFX = 0.8;

// Read once at module load, written through on every change. Nothing here
// touches localStorage per frame; the mixer reads these numbers, not the store.
let musicVol = load(KEY_MUSIC, DEFAULT_MUSIC);
let sfxVol = load(KEY_SFX, DEFAULT_SFX);
let isMuted = (() => {
  try { return localStorage.getItem(KEY_MUTE) === '1'; } catch { return false; }
})();

const listeners = new Set();

// Every read and write is wrapped: private mode throws on the getter itself in
// some engines, and a full quota throws on the setter. Neither is a reason for
// the title screen not to appear.
function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const v = Number(raw);
    // A hand-edited or half-written value must not become NaN gain later.
    return Number.isFinite(v) ? clamp(v) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, v) {
  try { localStorage.setItem(key, String(v)); } catch { /* private mode or quota */ }
}

function clamp(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

function announce() {
  // Copied before iterating: a listener is allowed to unsubscribe itself, and
  // a mixer tearing itself down mid-notification is exactly when it would.
  for (const fn of [...listeners]) {
    try { fn(musicVol, sfxVol, isMuted); } catch { /* a broken listener is not a broken game */ }
  }
}

export function music() { return musicVol; }
export function sfx() { return sfxVol; }

export function setMusic(v) {
  const next = clamp(Number(v) || 0);
  if (next === musicVol) return;
  musicVol = next;
  save(KEY_MUSIC, next);
  announce();
}

export function setSfx(v) {
  const next = clamp(Number(v) || 0);
  if (next === sfxVol) return;
  sfxVol = next;
  save(KEY_SFX, next);
  announce();
}

export function muted() { return isMuted; }

/** Mute or unmute. The mixer drops its master gain to 0; the levels
 *  themselves are untouched, so unmuting lands back where they were.
 *  Dragging either fader lifts the mute (screens.js) — a slider silently
 *  cancelled by a mute somewhere else is worse than no slider (hub §2). */
export function setMuted(v) {
  const next = !!v;
  if (next === isMuted) return;
  isMuted = next;
  try { localStorage.setItem(KEY_MUTE, next ? '1' : '0'); } catch { /* private mode or quota */ }
  announce();
}

/** Subscribe to both volumes and the mute. Returns the unsubscribe function. */
export function onVolume(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
