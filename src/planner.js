'use strict';

const DIRECTIONS = Object.freeze([
  ['up', 0, -1], ['down', 0, 1], ['left', -1, 0], ['right', 1, 0],
]);

// Manhattan distance is a lower bound on arrival: routing detours around traffic.
const ROUTE_SLACK = 1.1;

// A third of our assignments are walks longer than fifteen cells, which looked
// like waste. Capping them costs far more than it saves: at a radius of 14 the
// arena match rate falls from 85.9% to 71.6%, and every cap tested was worse than
// none. Long recruitment is doing real work, so the only limit is the clock.

const { persistence } = require('./persistence');

const NEIGHBOURS = Object.freeze([[0, -1], [0, 1], [-1, 0], [1, 0]]);

const keyOf = (x, y, width) => y * width + x;
const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const handleOf = unit => String(unit.handle);

/**
 * Index of a cell whose four neighbours all belong to the shape, or -1. X5's
 * centre is the only one in the catalogue: once its four arms arrive nothing can
 * enter the middle, and the formation can never complete. Every X5 left one cell
 * short in live play — sixteen of sixteen — was missing exactly that cell.
 */
function enclosedCell(shape) {
  return shape.cells.findIndex(([x, y]) => NEIGHBOURS.every(([dx, dy]) =>
    shape.cells.some(([cx, cy]) => cx === x + dx && cy === y + dy)));
}

/** Reproduce the reference engine's row-major, non-overlapping match order. */
function matchesFor(occupied, shape, width, height) {
  const claimed = new Set();
  const matches = [];
  for (let y = 0; y <= height - shape.height; y++) {
    for (let x = 0; x <= width - shape.width; x++) {
      const cells = shape.cells.map(([dx, dy]) => keyOf(x + dx, y + dy, width));
      if (cells.every(cell => occupied.has(cell) && !claimed.has(cell))) {
        cells.forEach(cell => claimed.add(cell));
        matches.push({ x, y, cells });
      }
    }
  }
  return matches;
}

function occupiedBy(state, width) {
  const all = new Set(state.units.map(unit => keyOf(unit.x, unit.y, width)));
  const own = new Map(state.ownUnits.map(unit => [keyOf(unit.x, unit.y, width), unit]));
  // Foreign blush is the only public mark a unit carries, and it predicts whether
  // the cell will still be there at round end.
  const blush = new Map(state.units.map(unit => [keyOf(unit.x, unit.y, width), unit.blush ?? null]));
  return { all, own, blush };
}

function candidateAt(x, y, shape, width, occupied, own, available, blocked, turnsLeft, trust, previous, enclosed = -1) {
  const cells = shape.cells.map(([dx, dy]) => ({ x: x + dx, y: y + dy, key: keyOf(x + dx, y + dy, width) }));
  if (cells.some(cell => blocked.has(cell.key))) return null;
  const kept = [];
  let foreign = 0;
  // Each foreign cell is an independent bet that it is still occupied at round end.
  let completion = 1;
  const holes = [];
  for (const cell of cells) {
    const unit = own.get(cell.key);
    if (unit) {
      if (!available.has(handleOf(unit))) return null;
      kept.push(unit);
    } else if (occupied.has(cell.key)) {
      foreign++;
      completion *= trust(cell.key);
    } else {
      holes.push(cell);
    }
  }
  // An unoccupied template with no local owned unit is an expensive blind rendezvous.
  if (!kept.length && !foreign) return null;

  const used = new Set(kept.map(handleOf));
  const assignments = kept.map(unit => ({ unit, target: { x: unit.x, y: unit.y } }));
  let totalDistance = 0;
  let longest = 0;
  // Closest pair first prevents assigning one unit to multiple holes.
  while (holes.length) {
    let best = null;
    for (let i = 0; i < holes.length; i++) {
      for (const unit of available.values()) {
        if (used.has(handleOf(unit))) continue;
        const steps = distance(unit, holes[i]);
        const inertia = previous.get(handleOf(unit)) === holes[i].key ? -0.75 : 0;
        if (!best || steps + inertia < best.cost) best = { i, unit, steps, cost: steps + inertia };
      }
    }
    if (!best || best.steps * ROUTE_SLACK + 1 > turnsLeft) return null;
    const [target] = holes.splice(best.i, 1);
    used.add(handleOf(best.unit));
    assignments.push({ unit: best.unit, target });
    totalDistance += best.steps;
    longest = Math.max(longest, best.steps);
  }

  const ownedCount = assignments.length;
  if (!ownedCount) return null;

  // An enclosed cell has to be occupied before the ring around it closes, so the
  // unit heading there must arrive ahead of the last one heading for its border.
  if (enclosed >= 0) {
    const centre = cells[enclosed];
    if (!occupied.has(centre.key)) {
      const arrival = new Map(assignments.map(({ unit, target }) =>
        [keyOf(target.x, target.y, width), distance(unit, target)]));
      const centreArrival = arrival.get(centre.key);
      if (centreArrival === undefined) return null;
      let ringClosed = 0;
      for (const [dx, dy] of NEIGHBOURS) {
        const key = keyOf(centre.x + dx, centre.y + dy, width);
        ringClosed = Math.max(ringClosed, occupied.has(key) ? 0 : arrival.get(key) ?? 0);
      }
      if (centreArrival >= ringClosed) return null;
    }
  }
  const urgent = assignments.reduce((sum, { unit }) => sum + (unit.energy === 1 ? 0.25 : 0), 0);
  // No rule charges energy for moving, so distance is a deadline and an opportunity
  // cost, never a cost in itself. Scaling by the horizon keeps both terms below one
  // matched unit: a plan that spends the whole round still outranks a closer plan
  // that matches fewer units, while ties go to the plan that keeps units free.
  const span = Math.max(1, turnsLeft);
  const travelPenalty = 0.60 * (longest / span) + 0.30 * (totalDistance / (cells.length * span));
  // Long walks must survive replanning, so committed assignments hold their ground.
  const continuity = assignments.reduce((sum, { unit, target }) =>
    sum + (previous.get(handleOf(unit)) === keyOf(target.x, target.y, width) ? 0.20 : 0), 0);
  const score = (ownedCount + urgent) * completion - travelPenalty + continuity;
  return { x, y, cells: cells.map(cell => cell.key), assignments, foreign, score };
}

function routeDistances(target, occupied, width, height, cache) {
  const targetKey = keyOf(target.x, target.y, width);
  if (cache.has(targetKey)) return cache.get(targetKey);
  const distances = new Int16Array(width * height).fill(-1);
  const queue = new Int32Array(width * height);
  let head = 0, tail = 0;
  distances[targetKey] = 0;
  queue[tail++] = targetKey;
  while (head < tail) {
    const current = queue[head++];
    const x = current % width, y = (current / width) | 0;
    for (const [, dx, dy] of DIRECTIONS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const next = keyOf(nx, ny, width);
      if (distances[next] !== -1 || occupied.has(next)) continue;
      distances[next] = distances[current] + 1;
      queue[tail++] = next;
    }
  }
  cache.set(targetKey, distances);
  return distances;
}

function route(assignments, occupied, width, height, blockedMoves = new Map()) {
  const reserved = new Set();
  const cache = new Map();
  const commands = [];
  const expected = new Map();
  // Nearby destinations first: protect short, nearly complete plans.
  const movers = assignments.filter(({ unit, target }) => unit.x !== target.x || unit.y !== target.y)
    .sort((a, b) => distance(a.unit, a.target) - distance(b.unit, b.target));
  for (const { unit, target } of movers) {
    const field = routeDistances(target, occupied, width, height, cache);
    const options = [];
    for (const [direction, dx, dy] of DIRECTIONS) {
      const nx = unit.x + dx, ny = unit.y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const next = keyOf(nx, ny, width);
      if (occupied.has(next) || reserved.has(next)) continue;
      const path = field[next];
      if (path < 0) continue;
      const penalty = blockedMoves.get(handleOf(unit))?.get(next) ?? 0;
      options.push({ direction, next, cost: path + penalty * 3 });
    }
    options.sort((a, b) => a.cost - b.cost || a.next - b.next);
    if (!options.length) continue;
    const choice = options[0];
    reserved.add(choice.next);
    expected.set(handleOf(unit), choice.next);
    commands.push({ handle: unit.handle, commandName: 'move', params: [choice.direction] });
  }
  return { commands, expected };
}

/** Connected groups of our own units, under 4-adjacency. */
function clumpsOf(units, width) {
  const byCell = new Map(units.map(unit => [keyOf(unit.x, unit.y, width), unit]));
  const seen = new Set();
  const clumps = [];
  for (const unit of units) {
    const start = keyOf(unit.x, unit.y, width);
    if (seen.has(start)) continue;
    const members = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const cell = stack.pop();
      const current = byCell.get(cell);
      members.push(current);
      for (const [, dx, dy] of DIRECTIONS) {
        const next = keyOf(current.x + dx, current.y + dy, width);
        if (byCell.has(next) && !seen.has(next)) { seen.add(next); stack.push(next); }
      }
    }
    clumps.push(members);
  }
  return clumps;
}

/**
 * Where a unit with no formation should walk. Getting k units adjacent is a far
 * easier problem than walking each onto an exact cell, and a clump that big can
 * always be shaped later. So small groups close on larger ones — never the other
 * way round, which would drag a settled pair apart to collect a straggler — and a
 * group already big enough to hold a shape stays where it is.
 */
function rallyTargets(units, shapeSize, width) {
  const clumps = clumpsOf(units, width);
  const targets = new Map();
  if (clumps.length < 2) return targets;
  for (const clump of clumps) {
    if (clump.length >= shapeSize) continue;
    let best = null;
    for (const other of clumps) {
      if (other === clump || other.length < clump.length) continue;
      for (const anchor of other) {
        for (const member of clump) {
          const steps = distance(member, anchor);
          if (!best || steps < best.steps) best = { steps, anchor };
        }
      }
    }
    if (!best) continue;
    for (const member of clump) targets.set(handleOf(member), best.anchor);
  }
  return targets;
}

/** Pure decision function; memory is supplied by the Player adapter. */
function planTurn({ state, width, height, shape, turnsLeft = 64, reliability = 0.82,
  previous = new Map(), blockedMoves = new Map(), persistenceOf = persistence, mode = 'arena',
  rally = mode === 'clash' }) {
  const { all: occupied, own, blush } = occupiedBy(state, width);
  const available = new Map(state.ownUnits.map(unit => [handleOf(unit), unit]));
  const enclosed = enclosedCell(shape);
  const actualMatches = matchesFor(occupied, shape, width, height);
  // One lookup per cell, memoised: candidateAt runs over every placement.
  const trustCache = new Map();
  const trust = key => {
    let value = trustCache.get(key);
    if (value === undefined) {
      value = Math.max(0.02, Math.min(0.99,
        persistenceOf(blush.get(key) ?? null, turnsLeft, mode, reliability)));
      trustCache.set(key, value);
    }
    return value;
  };
  const blocked = new Set(actualMatches.flatMap(match => match.cells));
  const selected = [];

  // Complete, already-scoring formations take precedence over speculative moves.
  for (const match of actualMatches) {
    const assignments = match.cells.filter(cell => own.has(cell)).map(cell => {
      const unit = own.get(cell);
      available.delete(handleOf(unit));
      return { unit, target: { x: unit.x, y: unit.y } };
    });
    if (assignments.length) selected.push({ ...match, assignments, foreign: match.cells.length - assignments.length, complete: true });
  }

  const candidates = [];
  for (let y = 0; y <= height - shape.height; y++) {
    for (let x = 0; x <= width - shape.width; x++) {
      const candidate = candidateAt(x, y, shape, width, occupied, own, available,
        blocked, turnsLeft, trust, previous, enclosed);
      if (candidate && candidate.score > 0) candidates.push(candidate);
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);

  // Reassign after each choice, since two candidate plans may have wanted the same unit.
  for (const draft of candidates.slice(0, 320)) {
    if (!available.size) break;
    const candidate = candidateAt(draft.x, draft.y, shape, width, occupied, own,
      available, blocked, turnsLeft, trust, previous, enclosed);
    if (!candidate || candidate.score <= 0) continue;
    selected.push(candidate);
    candidate.cells.forEach(cell => blocked.add(cell));
    candidate.assignments.forEach(({ unit }) => available.delete(handleOf(unit)));
  }

  const assignments = selected.flatMap(plan => plan.assignments);

  // Unplanned units close on their neighbours rather than standing idle — but only
  // where being unplanned is a standing condition rather than a passing one. In
  // Clash a small force leaves 15% of its units above the solo ceiling, which no
  // formation can ever claim, and rallying them is worth 2.4 points of match rate.
  // In Arena only 4% are idle and they are usually waiting a turn for a plan that
  // is coming, so moving them costs 1.6 points instead.
  const committed = new Set(assignments.map(({ unit }) => handleOf(unit)));
  const idle = rally ? state.ownUnits.filter(unit => !committed.has(handleOf(unit))) : [];
  const targets = rallyTargets(idle, shape.cells.length, width);
  const rallying = [];
  for (const unit of idle) {
    const target = targets.get(handleOf(unit));
    if (target && distance(unit, target) > 1) rallying.push({ unit, target, rally: true });
  }

  const movement = route([...assignments, ...rallying], occupied, width, height, blockedMoves);
  // Rally targets are not commitments, so they do not earn continuity next turn.
  const nextTargets = new Map(assignments.map(({ unit, target }) =>
    [handleOf(unit), keyOf(target.x, target.y, width)]));
  const protectedMixed = selected.filter(plan => plan.complete && plan.foreign > 0)
    .flatMap(plan => plan.assignments.map(({ unit }) => handleOf(unit)));
  return { ...movement, nextTargets, protectedMixed, selected, rallying: rallying.length,
    unassigned: [...available.keys()] };
}

module.exports = { planTurn, matchesFor, occupiedBy, keyOf };
