/*
 * touch-guard.js — stop the browser treating the dam as a page of text.
 *
 * On a tablet a thumb resting on the toolbar is a long press, and a drag
 * that starts on a level card, the budget readout or a HUD label is a text
 * selection, so Safari highlights words and offers Copy / Look Up in the
 * middle of laying a beam. styles.css turns selection and the callout off;
 * this is the half CSS cannot promise, for the engines and the edges where
 * it is not honoured:
 *
 *   selectstart   cancelled unless it begins in a real text field
 *   contextmenu   cancelled likewise — on touch it IS the long-press menu.
 *                 src/core/input.js already cancels it on the canvas; this
 *                 covers the HUD and the screens around it.
 *   selectionchange  anything that slipped through anyway is cleared, unless
 *                 a field has focus (none ships today; the day one does, a
 *                 player must still be able to select what they typed)
 *
 * The cost, written down: no right-click menu over the game on desktop
 * either. Nothing in a game wants one, and devtools stay a keystroke away.
 *
 * A classic script, self-contained, importing nothing, loaded beside the
 * module graph rather than inside it: a failure anywhere in src/main.js's
 * imports must not take this down with it, and this must not take anything
 * else down. Copied from lobbots/js/touch-guard.js, the hub reference.
 */
(function () {
  'use strict';

  function editable(node) {
    return !!(node && node.closest && node.closest('input, textarea, select, [contenteditable="true"]'));
  }

  document.addEventListener('selectstart', function (e) {
    if (!editable(e.target)) e.preventDefault();
  });

  document.addEventListener('contextmenu', function (e) {
    if (!editable(e.target)) e.preventDefault();
  });

  document.addEventListener('selectionchange', function () {
    if (editable(document.activeElement)) return;
    var sel = window.getSelection && window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) sel.removeAllRanges();
  });
})();
