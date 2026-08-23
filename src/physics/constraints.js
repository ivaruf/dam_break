// OPUS A owns. Substepped verlet integration + iterative distance-constraint
// solver + ground collision with Coulomb friction.
// Contract: ARCHITECTURE.md §5. DOM-free, deterministic (no Math.random).
//
// The solver is XPBD (position-based dynamics with compliance). Plain PBD
// projects constraints towards *rigid*, which would drive every strain to zero
// and nothing would ever break; with a per-member compliance alpha = L/EA the
// steady-state residual is exactly the elastic strain, so member.strain is a
// real measure of axial force (F = strain·EA) and stress.js can grade it.
//
// State layout stays the contract's verlet pair: (x,y) current, (px,py) previous
// substep — velocity is (x−px)/h. Node.vx/vy are refreshed at the end of the
// tick in m/s for coupling / rendering / debug.
//
// External forces arrive in node.fx/fy. They are applied on EVERY substep (they
// are forces, constant across the tick) and zeroed once at the end. Nobody else
// zeroes them.

import { CONFIG } from '../config.js';

export function stepStructure(structure, terrain, dt) {
  if (!structure) return;
  const P = CONFIG.physics;
  const sub = Math.max(1, P.substeps | 0);
  const h = dt / sub;
  const iters = Math.max(1, P.iterations | 0);
  const dIters = Math.max(1, P.debrisIterations | 0);

  for (let s = 0; s < sub; s++) {
    integrate(structure.nodes, h, P, P.velDamping);
    for (const m of structure.members) m.lambda = 0;
    for (const n of structure.nodes) armContact(n, terrain, P);
    // Contacts are solved INSIDE the iteration loop and their normal push is
    // accumulated. That accumulation is what carries the load transmitted down
    // through the truss, so friction below grips with the dam's whole weight
    // rather than just the mass of the one node touching the dirt.
    for (let it = 0; it < iters; it++) {
      solveMembers(structure.members, h);
      for (const n of structure.nodes) projectContact(n, P);
    }
    for (const n of structure.nodes) resolveContact(n, h, P);

    if (structure.debris.length) {
      for (const d of structure.debris) {
        integrateNode(d.a, h, P, P.debrisDamping);
        integrateNode(d.b, h, P, P.debrisDamping);
        armContact(d.a, terrain, P);
        armContact(d.b, terrain, P);
        d.lambda = 0;
      }
      for (let it = 0; it < dIters; it++) {
        for (const d of structure.debris) {
          solveMember(d, h);
          projectContact(d.a, P);
          projectContact(d.b, P);
        }
      }
      for (const d of structure.debris) {
        resolveContact(d.a, h, P);
        resolveContact(d.b, h, P);
      }
    }
  }

  // finalise velocities and clear the external accumulators for the next tick
  for (const n of structure.nodes) finishNode(n, h);
  for (const d of structure.debris) {
    finishNode(d.a, h);
    finishNode(d.b, h);
    d.age += dt;
  }
  structure.time += dt;
}

// ---- integration ---------------------------------------------------------

function integrate(nodes, h, P, damping) {
  for (let i = 0; i < nodes.length; i++) integrateNode(nodes[i], h, P, damping);
}

function integrateNode(n, h, P, damping) {
  if (n.invMass === 0) {
    // pinned: sit exactly on the anchor, no velocity
    n.x = n.ax; n.y = n.ay; n.px = n.ax; n.py = n.ay;
    return;
  }
  let vx = ((n.x - n.px) / h) * damping;
  let vy = ((n.y - n.py) / h) * damping;
  vx += n.fx * n.invMass * h;
  vy += (n.fy * n.invMass - P.gravity) * h;

  const sp = Math.hypot(vx, vy);
  if (sp > P.maxNodeVel) { const k = P.maxNodeVel / sp; vx *= k; vy *= k; }

  n.px = n.x; n.py = n.y;
  n.x += vx * h;
  n.y += vy * h;
  if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) {
    n.x = n.px; n.y = n.py;                 // paranoia: never let NaN spread
  }
}

function finishNode(n, h) {
  if (n.invMass === 0) { n.vx = 0; n.vy = 0; n.fx = 0; n.fy = 0; return; }
  n.vx = (n.x - n.px) / h;
  n.vy = (n.y - n.py) / h;
  n.fx = 0; n.fy = 0;
}

// ---- XPBD distance constraints -------------------------------------------

function solveMembers(members, h) {
  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    if (m.broken) continue;
    solveMember(m, h);
  }
}

function solveMember(m, h) {
  const a = m.a, b = m.b;
  const wA = a.invMass, wB = b.invMass;
  const w = wA + wB;
  if (w === 0) return;

  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-9)) return;

  const C = len - m.restLength;
  // cables resist stretch only: slack means zero force, they collapse freely
  if (m.tensionOnly && C <= 0) return;

  const at = m.compliance / (h * h);
  const dl = (-C - at * m.lambda) / (w + at);
  m.lambda += dl;

  const nx = dx / len, ny = dy / len;
  a.x -= wA * nx * dl; a.y -= wA * ny * dl;
  b.x += wB * nx * dl; b.y += wB * ny * dl;
}

// ---- ground -------------------------------------------------------------

// Arm the contact for this substep: cache the ground height and surface frame
// once (they barely change while the solver iterates) and only keep nodes that
// are actually near the dirt, so the per-iteration contact pass costs nothing
// for the hundreds of nodes up in the air.
function armContact(n, terrain, P) {
  n.onGround = false;
  n.nAccum = 0;
  n.contact = false;
  if (!terrain || n.invMass === 0) return;
  const gy = terrain.heightAt(n.x);
  if (n.y > gy + P.groundProbe) return;
  const e = P.slopeEps;
  const slope = (terrain.heightAt(n.x + e) - terrain.heightAt(n.x - e)) / (2 * e);
  const inv = 1 / Math.hypot(1, slope);
  n.groundY = gy;
  n.groundNx = -slope * inv;                // unit normal, points up
  n.groundNy = inv;
  n.contact = true;
}

// Inequality contact, solved every iteration alongside the members.
function projectContact(n, P) {
  if (!n.contact) return;
  const nx = n.groundNx, ny = n.groundNy;
  const pen = (n.groundY - n.y) * ny;
  if (pen <= 0) return;
  n.x += nx * pen;
  n.y += ny * pen;
  n.nAccum += pen;                          // total normal push this substep
  n.onGround = true;

  // Coulomb friction in POSITION space. Clamping only the velocity leaves the
  // substep's tangential drift on the books, and a resting dam then creeps
  // downstream a few microns per substep for ever. Pinning the tangential
  // position back (up to mu·N worth) is what makes "stands by weight" real.
  const tx = ny, ty = -nx;
  const drift = (n.x - n.px) * tx + (n.y - n.py) * ty;
  const mag = Math.abs(drift);
  if (mag < 1e-12) return;
  const lim = P.groundMu * n.nAccum;
  const k = lim >= mag ? 1 : lim / mag;
  n.x -= tx * drift * k;
  n.y -= ty * drift * k;
}

// Coulomb friction, once per substep. The tangential budget is proportional to
// the normal push the contact actually had to apply, and that push had to lift
// everything the truss was pressing down through this node — so a heavy gravity
// dam grips with its whole weight and stands unanchored, yet still slides once
// the water shoves harder than mu·N. Foundations matter.
function resolveContact(n, h, P) {
  if (!n.onGround) return;
  const nx = n.groundNx, ny = n.groundNy;
  const tx = ny, ty = -nx;                  // unit tangent, points +x

  const vx = (n.x - n.px) / h;
  const vy = (n.y - n.py) / h;
  let vn = vx * nx + vy * ny;
  let vt = vx * tx + vy * ty;

  // friction already happened in position space; here we only stop the node
  // sinking (or bounce it) and shave residual tangential jitter
  if (vn < 0) vn = -vn * P.groundBounce;
  if (Math.abs(vt) <= P.groundStiction) vt = 0;
  else vt *= P.groundFriction;

  n.px = n.x - (vn * nx + vt * tx) * h;
  n.py = n.y - (vn * ny + vt * ty) * h;
}
