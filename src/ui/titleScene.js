// STUB — presentation agent implements. Live fluid diorama behind the title
// and level-select screens: a small self-contained terrain + fluid instance +
// scripted timber dam that fills, strains, breaches and washes away on a
// deterministic ~20–30 s loop. Contract (game.js calls this every frame while
// phase is 'title' or 'levelselect'; module self-initializes lazily, steps its
// own fixed accumulator from dtReal, and must never touch the game scene):
//
//   render(ctx, dtReal, phase)
//
// Budget: ≤ ~3 ms/frame, ~1.2–2k particles. Reuse src/physics/* (read-only
// instances of its own) and rendering helpers where importable.

export function render(ctx, dtReal, phase) {
  // stub: nothing — the DOM title screen scrim covers the canvas until the
  // real diorama lands
}
