// The fullscreen toggle in the top-right corner cluster. OPUS C owns.
//
// DELIBERATELY SELF-CONTAINED: this module imports nothing, exports nothing,
// and no other file in the game knows it exists. index.html loads it as its
// own <script type="module">, beside src/main.js rather than inside it. That
// is the whole design. If the game fails to boot for some reason of its own —
// a physics module throwing, a level that will not parse — the one button that
// might make a valley readable on a phone is still there and still works. And
// the reverse: nothing in here can take the game down with it.
//
// THE FILENAME IS LOAD-BEARING. It is not fullscreen.js and the word does not
// appear anywhere in this path. uBlock Origin's DEFAULT filter lists carry a
// rule banning that basename across the whole of github.io — it looks at the
// name, never inside the file — and every game in the hub shares that origin.
// fishtank shipped a client/js/fullscreen.js and served a blank screen to
// every visitor running uBlock, because a blocked static import aborts the
// entire module graph rather than just the one file. Hub CLAUDE.md §2 has the
// full story; this file is the shape that came out of it.
//
// ELEMENT FULLSCREEN IS NOT UNIVERSAL. Safari on iPhone has none at all —
// there, fullscreen belongs to <video> — so the button ships hidden in the
// markup and is only revealed once a working request/exit PAIR has answered.
// A button that does nothing when pressed is worse than no button; the cluster
// simply shrinks to the sound icon and nothing else has to care.
//
// Inside the arcade this still works: the arcade frames each game with
// `allow="fullscreen; …"` already.

const button = document.getElementById('btn-screen');
const root = document.documentElement;

// The webkit-prefixed pair is the fallback for older Safari. Everywhere else
// this game runs, the unprefixed names are what exist.
const request = root.requestFullscreen || root.webkitRequestFullscreen || null;
const exit = document.exitFullscreen || document.webkitExitFullscreen || null;

function isFull() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

// Keep the label and aria-pressed matching reality, whoever changed it.
//
// The glyph is a picture, so the accessible name is the only thing that says
// which way the toggle is currently pointing — hence aria-label and title
// rather than textContent. CSS swaps the two paths inside the SVG off the same
// aria-pressed attribute, so the picture and the words cannot drift apart.
//
// The words stay plain rather than being dressed in the game's voice, which is
// the one place this cluster does not follow the house rule about naming
// controls the way the game names things. Fullscreen is not part of the
// fiction — it is a thing the browser does, it has one name everywhere, and
// "FILL THE VALLEY" would leave a player guessing whether it moved the camera.
function paint() {
  const active = isFull();
  const label = active ? 'Exit fullscreen' : 'Fullscreen';
  button.setAttribute('aria-pressed', String(active));
  button.setAttribute('aria-label', label);
  button.title = label;
}

if (button && request && exit) {
  button.hidden = false;
  paint();

  button.addEventListener('click', () => {
    const result = isFull() ? exit.call(document) : request.call(root);
    // Either call returns a promise that is allowed to reject: a permissions
    // policy refusing it, or a player backing out of the browser's own prompt.
    // What actually happened is repainted from fullscreenchange below, so this
    // catch exists only to keep a refusal from surfacing as an unhandled
    // rejection in the console.
    if (result && typeof result.catch === 'function') result.catch(() => {});
  });

  // The button is not the only way out of fullscreen — Escape and the
  // browser's own chrome both leave without ever touching it — so the label
  // has to be able to catch up from outside the click handler.
  document.addEventListener('fullscreenchange', paint);
  document.addEventListener('webkitfullscreenchange', paint);
}
