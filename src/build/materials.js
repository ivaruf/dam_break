// OPUS B owns. Pure data, DOM-free. Schema: ARCHITECTURE.md §5 "Material".
//
// HOW THE NUMBERS BITE (so tuning stays honest):
//   load        = |strain| / (tension|compression)Limit   → 1.0 = at the limit
//   strain      = ΔL/L, and constraints.js turns stiffness into an axial
//                 stiffness EA = axialStiffness·s/(stiffEps + 1 − s), so
//                 strain = F/EA. Flexible and weak therefore MULTIPLY: the
//                 force a member survives is CAPACITY = EA · limit.
//   thickness   = visual width AND the water-sealing width coupling rasterises,
//                 so thick material makes a tighter dam face.
//   massPerMeter feeds node mass: heavy material resists uplift and sliding but
//                 crushes its own supports.
//   cost        = length · costPerMeter, checked against level.budget.
//
// CAPACITY TABLE — relative to timber-in-tension = 1.00, so it stays true
// whatever Opus A sets CONFIG.physics.axialStiffness to (it only scales EA
// globally). "per $" divides by costPerMeter: value for money, which is what
// a budget actually buys.
//
//   material   EA rel   tension  compr   |  tension/$  compr/$   $/m
//   timber       1.00      1.00    0.80  |      1.00      0.80     15
//   steel        5.63      7.51    4.76  |      1.94      1.23     58
//   concrete     9.42      1.26   20.94  |      0.23      3.83     82
//   cable        3.41      6.83       —  |      5.12         —     20
//
// So: cable is the cheapest pull by 2.6× over steel (but seals nothing and
// cannot push), concrete the cheapest push by 3.1× over steel (but cracks at
// 6% of its own compression capacity, and weighs 10× timber), steel is ~2×
// timber's value for money in both directions, and timber is simply the only
// thing a small budget can buy enough of. Every material is the wrong answer
// somewhere.
//
// INTENDED ROLES — the four materials must never be interchangeable:
//
//   TIMBER   the default. Cheap, light, FLEXIBLE (lowest stiffness) so it visibly
//            gives before it goes, and weak-ish in both directions. Seals well
//            for its price. Fine for shallow water and small spans; a tall
//            timber wall will bow and then split.
//   STEEL    the engineer's answer. Expensive, heavy-ish, stiff, and by far the
//            best in TENSION (7.5× timber's capacity) with good compression too
//            (4.8×). Long spans, tie-backs that must also push, reversing loads.
//   CONCRETE the gravity dam. Extreme in COMPRESSION, close to useless in
//            TENSION (0.006 — it cracks), very heavy, thickest section (best
//            sealing), expensive and short (maxLength 3 m). Stack it, never
//            hang it. Its own weight is both the reason it works and the reason
//            it destroys whatever is under it.
//   CABLE    tension only. Featherweight, cheap per metre, huge spans (16 m),
//            enormous tensile limit — and NO water sealing at all, plus no
//            compression resistance whatsoever. Anchor-to-crest tie-backs and
//            bracing that only ever pulls. Cables alone hold back nothing.

export const MATERIALS = {
  timber: {
    id: 'timber', name: 'Timber', color: '#c8954a', darkColor: '#8a6023',
    blurb: 'Cheap and light. Bends, then breaks.',
    costPerMeter: 15, massPerMeter: 6, thickness: 0.36, stiffness: 0.80,
    tensionLimit: 0.045, compressionLimit: 0.036,
    tensionOnly: false, sealing: true,
    minLength: 0.5, maxLength: 5,   // 5 m reaches from an anchor to a 3.5 m crest
  },
  steel: {
    id: 'steel', name: 'Steel', color: '#9fb2c4', darkColor: '#5c6b7a',
    blurb: 'Stiff and strong, strongest in tension. Costly.',
    costPerMeter: 58, massPerMeter: 22, thickness: 0.22, stiffness: 0.98,
    tensionLimit: 0.060, compressionLimit: 0.038,
    tensionOnly: false, sealing: true,
    minLength: 0.5, maxLength: 7,
  },
  concrete: {
    id: 'concrete', name: 'Concrete', color: '#b9c4cc', darkColor: '#77828b',
    blurb: 'Immense under compression. Cracks if pulled. Very heavy.',
    costPerMeter: 82, massPerMeter: 62, thickness: 0.85, stiffness: 1.0,
    tensionLimit: 0.006, compressionLimit: 0.100,
    tensionOnly: false, sealing: true,
    minLength: 0.6, maxLength: 3,
  },
  cable: {
    id: 'cable', name: 'Cable', color: '#e8d44d', darkColor: '#9a8c2a',
    blurb: 'Pulls only. Long, light, seals nothing.',
    costPerMeter: 20, massPerMeter: 1.5, thickness: 0.07, stiffness: 0.95,
    tensionLimit: 0.090, compressionLimit: 0.0005,
    tensionOnly: true, sealing: false,
    minLength: 1, maxLength: 16,
  },
};

export const MATERIAL_ORDER = ['timber', 'steel', 'concrete', 'cable'];
