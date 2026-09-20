// OPUS C owns. The two volume levels — and NOTHING else.
//
// DAM BREAK has no audio. Not a muted engine, not a stub synth: there is no
// AudioContext anywhere in this repo and nothing that could make a sound. So
// why is this file here?
//
// Because the hub is fitting one sound panel to every arcade game, and a
// volume the player sets has to survive the day the audio actually lands.
// Storing it is cheap; asking a player to find the panel again after their
// first flood arrives at full blast is not. The panel says so out loud (see
// #screen-sound in index.html) — two sliders that quietly do nothing would be
// a lie, two sliders that admit they are a reservation are not.
//
// THIS IS THE ONE PLACE A FUTURE AUDIO SYSTEM PLUGS IN. It needs exactly two
// things from here and should take no other route to them:
//
//   music()/sfx()      the current gains, 0..1, ready to multiply
//   onVolume(fn)       a subscription, fired whenever either one moves, so a
//                      live mixer tracks the slider while it is being dragged
//
// When that day comes, the contract's other half (hub CLAUDE.md §9 and the
// corner-cluster brief) is that setting a volume must MAKE a sound while you
// set it — a control you cannot hear is a control you cannot use. Wire that
// into onVolume() here rather than into screens.js, which knows about sliders
// and should never learn about gain nodes.
//
// Keys are versioned per hub CLAUDE.md §6 and are now permanent: a key holding
// a player's setting can never be renamed without silently resetting it, which
// is why dam_break still carries 'dam-builder-save-v1' three names later.

const KEY_MUSIC = 'dam_break.vol.music.v1';
const KEY_SFX = 'dam_break.vol.sfx.v1';

// Neither default is 1.0 on purpose. Music sits under everything and wants
// headroom; the cues — a beam cracking, water hitting stone — are the half of
// a flood that tells you what just happened, so they start louder.
const DEFAULT_MUSIC = 0.6;
const DEFAULT_SFX = 0.8;

// Read once at module load, written through on every change. Nothing here
// touches localStorage per frame; a future mixer reads these numbers, not the
// store.
let musicVol = load(KEY_MUSIC, DEFAULT_MUSIC);
let sfxVol = load(KEY_SFX, DEFAULT_SFX);

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
    try { fn(musicVol, sfxVol); } catch { /* a broken listener is not a broken game */ }
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

/** Subscribe to both volumes. Returns the unsubscribe function. */
export function onVolume(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
