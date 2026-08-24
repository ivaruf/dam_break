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

No build step. No dependencies. Vanilla ES modules + Canvas 2D.

- `ARCHITECTURE.md` — the module contract (interfaces, ownership, update order).
- `node tests/run.js` — headless physics test scenes (structure, water, coupling).
- Deploying: bump `VERSION` in `sw.js` (and keep its `ASSETS` list complete),
  commit, push to the GitHub Pages branch.
- In-game: `F2` toggles the debug overlay.
