# DAM BREAK

A browser physics construction game: build a dam out of timber, steel, concrete
and cable — then release the flood and find out whether it holds. Inspired by
bridge-builder games, but the adversary is **water**: it accumulates, presses
harder with depth, finds every gap, and tears through breaches.

## Play

- **Hosted**: works on GitHub Pages out of the box (static files, relative
  paths, `.nojekyll`). Installable as a PWA; updates ship via the service
  worker with an opt-in "UPDATE READY" button on the title screen.
- **Local**: `python3 -m http.server 8000` in the repo root (or `npm run serve`),
  then open <http://localhost:8000>. ES modules require http(s) — opening
  `index.html` directly from disk will not work in most browsers.

Works with mouse (drag to build, wheel to zoom, middle-drag to pan) and touch
(drag to build, pinch to zoom, two-finger drag to pan).

## Modes

- **Free Build** — plan forever, then hit *RELEASE WATER*.
- **Flood Countdown** — the flood is already on its way; build fast.

## Development

No build step. No dependencies. Vanilla ES modules + Canvas 2D + Web Audio.

- Sound: music and effects are Sonic Pi pieces in `tools/audio/*.rb`, rendered
  offline with the hub's `tools/audio/render.rb` (needs Sonic Pi and a real
  audio device), then encoded to `audio/*.m4a` — themes by
  `tools/audio/encode.mjs`, cues by the hub's `tools/audio/encode-oneshots.mjs`.
  The `.rb` pieces are the source of truth; `src/ui/audio.js` plays them.

  ```sh
  SP="/Applications/Sonic Pi.app/Contents/Resources/app/server/native/ruby/bin/ruby"
  SONIC_PI_PIECES=tools/audio "$SP" ../tools/audio/render.rb /tmp/music \
    music-title=72 music-build=104 music-flood=104
  SONIC_PI_PIECES=tools/audio "$SP" ../tools/audio/render.rb /tmp/sfx \
    tap=1.5 chime=2.5 tick=1.2 place-timber=1.5 place-steel=2 place-concrete=2.5 \
    place-cable=2 remove=1.5 refuse=1.5 release=4 splash=2 gush=2.5 creak=2 \
    break-wood=2 break-metal=2.5 break-stone=2.5 win=4.5 fail=4.5
  node tools/audio/encode.mjs /tmp/music audio
  node ../tools/audio/encode-oneshots.mjs /tmp/sfx audio
  ```
  Adding a sound means adding it to `sw.js`'s precache list too.

- `ARCHITECTURE.md` — the module contract (interfaces, ownership, update order).
- `node tests/run.js` — headless physics test scenes (structure, water, coupling).
- Deploying: bump `VERSION` in `sw.js` (and keep its `ASSETS` list complete),
  commit, push to the GitHub Pages branch.
- In-game: `F2` toggles the debug overlay.
