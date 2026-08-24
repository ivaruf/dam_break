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
//   bending     = relative moment capacity (v2.1). coupling.js publishes the
//                 water's transverse push per member; stress.js turns it into
//                 bendLoad = |waterFperp|·len / (8 · CONFIG.damage.bendScale ·
//                 bending), the peak moment of a simply-supported span over its
//                 capacity. Twice the unsupported length is about twice the
//                 moment (the span is longer AND catches more water), so a
//                 mid-span pier is the best money a player can spend, and this
//                 is the reason a face has a head rating at all.
//   creepRate   = damage per second at load 1.0 (v2.1). Above
//                 CONFIG.damage.creepStart (0.7) a member is being consumed
//                 even though it has not failed, scaled by how far past the
//                 threshold it sits. "It held" is not the same as "it survived".
//
// CAPACITY TABLE — relative to timber-in-tension = 1.00, so it stays true
// whatever Opus A sets CONFIG.physics.axialStiffness to (it only scales EA
// globally). "per $" divides by costPerMeter: value for money, which is what
// a budget actually buys. `bending` is likewise relative to timber = 1.00 and
// scales with CONFIG.damage.bendScale, so the column stays true too.
//
//   material   EA rel   tension  compr   bending |  tension/$  compr/$   $/m
//   timber       1.00      1.00    0.80     1.00 |      1.00      0.80     15
//   steel        5.63      7.51    4.76     2.80 |      1.94      1.23     58
//   concrete     9.42      1.26   20.94     7.00 |      0.23      3.83     82
//   cable        3.41      6.83       —        — |      5.12         —     20
//
// The bending column is DERIVED, not invented: a section's moment capacity goes
// as thickness² × material tensile strength, so bending = (t/0.36)² × tension.
//   timber    (0.36/0.36)² × 1.00 = 1.00
//   steel     (0.22/0.36)² × 7.51 = 2.80   thinnest solid section, best steel
//   concrete  (0.85/0.36)² × 1.26 = 7.02   thick enough to beat its own cracking
// A cable has no bending entry because a rope carries no moment — it just moves.
// stress.js reads bending === 0 as exactly that and skips bending for it.
//
// So: cable is the cheapest pull by 2.6× over steel (but seals nothing and
// cannot push), concrete the cheapest push by 3.1× over steel (but cracks at
// 6% of its own compression capacity, and weighs 10× timber), steel is ~2×
// timber's value for money in both directions, and timber is simply the only
// thing a small budget can buy enough of. Every material is the wrong answer
// somewhere.
//
// HEAD RATINGS (headRating, display-only metres of water head) — what a BRACED
// face of that material actually holds when its panels sit in the level-typical
// 2.5 m bay. MEASURED, not asserted: tests/run.js RATINGS builds the identical
// face (bay 2.5 m, truss depth 1.5 m — a geometry all three materials can
// legally build) out of each material and gates these depths.
//
//   material  headRating  holds 60 s  fails       what actually stops it
//   timber       3 m        2.5 m      4.5 m      bending; 3 m creeps apart in ~21 s
//   steel        7 m        5.5 m      8 m        bending; 7 m sits at load 0.99
//   concrete     8 m        8.0 m      9 m        its own TENSION limit, not bending
//   cable        0 m         —          —         seals nothing; holds no head
//
// headRating is the last depth the material still holds, which is not the same
// as the depth it is comfortable at: timber holds 3 m for about twenty seconds
// before creep finishes it, and steel's 7 m face runs at 0.99 for the whole
// minute. Read the rating as "this deep and no deeper", not as a safe working
// depth — that is one bay shallower in each case.
//
// Concrete is the one whose ceiling is NOT bending: with bending 7.00 its panels
// are barely working, and what breaks a 9 m concrete face is a member snapping
// in TENSION (limit 0.006 — it cracks) during the reservoir's first half second.
// Making concrete hold the 10+ m a real gravity dam would need either a
// battered face that turns that pull into compression, or a gentler start to the
// water load — neither of which is a damage-model question.
//
// HALVE THE BAY, HALVE THE MOMENT. The peak moment of a span is F·L/8 and the
// force F on it grows with L as well, so putting a pier at mid-height cuts the
// bending load to almost exactly half at the same head (measured: 0.50). Head
// buys less than that, because the load itself grows as H²: halving the bay buys
// about 1.4× the survivable depth, not 2×. It is still the cheapest structural
// upgrade in the game — the same 4.8 m timber face that snaps under 2.5 m of
// water holds it indefinitely once a mid rung splits the span — and it is why an
// elaborate dam beats a minimal triangle.
//
// CREEP RATES — damage/s at load 1.0, and the sustained-0.85 lifetime that
// implies (factor (0.85−0.7)/0.3 = 0.5, so lifetime = 1/(0.5·creepRate)):
//
//   timber   0.0667   ~30 s     green wood under constant load simply gives up
//   cable    0.0133   ~150 s    wire rope relaxes; modest, not fatal
//   steel    0.00333  ~10 min   20× timber. An engineered face is not "holding
//                               on", it is holding.
//   concrete 0.00222  ~15 min   slow — but NOT immortal: park a concrete dam at
//                               0.95 and it will still crack, eventually.
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
    bending: 1.00, creepRate: 0.0667, headRating: 3,
    tensionOnly: false, sealing: true,
    minLength: 0.5, maxLength: 5,   // 5 m reaches from an anchor to a 3.5 m crest
  },
  steel: {
    id: 'steel', name: 'Steel', color: '#9fb2c4', darkColor: '#5c6b7a',
    blurb: 'Stiff and strong, strongest in tension. Costly.',
    costPerMeter: 58, massPerMeter: 22, thickness: 0.22, stiffness: 0.98,
    tensionLimit: 0.060, compressionLimit: 0.038,
    bending: 2.80, creepRate: 0.00333, headRating: 7,
    tensionOnly: false, sealing: true,
    minLength: 0.5, maxLength: 7,
  },
  concrete: {
    id: 'concrete', name: 'Concrete', color: '#b9c4cc', darkColor: '#77828b',
    blurb: 'Immense under compression. Cracks if pulled. Very heavy.',
    costPerMeter: 82, massPerMeter: 62, thickness: 0.85, stiffness: 1.0,
    tensionLimit: 0.006, compressionLimit: 0.100,
    bending: 7.00, creepRate: 0.00222, headRating: 8,
    tensionOnly: false, sealing: true,
    minLength: 0.6, maxLength: 3,
  },
  cable: {
    id: 'cable', name: 'Cable', color: '#e8d44d', darkColor: '#9a8c2a',
    blurb: 'Pulls only. Long, light, seals nothing.',
    costPerMeter: 20, massPerMeter: 1.5, thickness: 0.07, stiffness: 0.95,
    tensionLimit: 0.090, compressionLimit: 0.0005,
    // bending 0 = "carries no moment": stress.js skips bending for it, which is
    // what a rope does. headRating 0 because a cable seals nothing at all.
    bending: 0, creepRate: 0.0133, headRating: 0,
    tensionOnly: true, sealing: false,
    minLength: 1, maxLength: 16,
  },
};

export const MATERIAL_ORDER = ['timber', 'steel', 'concrete', 'cable'];
