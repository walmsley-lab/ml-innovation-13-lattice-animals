'use strict';

const DIRECTIONS = Object.freeze([
  ['up', 0, -1], ['down', 0, 1], ['left', -1, 0], ['right', 1, 0],
]);

// Manhattan distance is a lower bound on arrival: routing detours around traffic.
const ROUTE_SLACK = 1.1;

const keyOf = (x, y, width) => y * width + x;
const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const handleOf = unit => String(unit.handle);

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
  return { all, own };
}

function candidateAt(x, y, shape, width, occupied, own, available, blocked, turnsLeft, reliability, previous) {
  const cells = shape.cells.map(([dx, dy]) => ({ x: x + dx, y: y + dy, key: keyOf(x + dx, y + dy, width) }));
  if (cells.some(cell => blocked.has(cell.key))) return null;
  const kept = [];
  let foreign = 0;
  const holes = [];
  for (const cell of cells) {
    const unit = own.get(cell.key);
    if (unit) {
      if (!available.has(handleOf(unit))) return null;
      kept.push(unit);
    } else if (occupied.has(cell.key)) {
      foreign++;
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
  const urgent = assignments.reduce((sum, { unit }) => sum + (unit.energy === 1 ? 0.25 : 0), 0);
  const completion = Math.pow(reliability, foreign);
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

/** Pure decision function; memory is supplied by the Player adapter. */
function planTurn({ state, width, height, shape, turnsLeft = 64, reliability = 0.82,
  previous = new Map(), blockedMoves = new Map() }) {
  const { all: occupied, own } = occupiedBy(state, width);
  const available = new Map(state.ownUnits.map(unit => [handleOf(unit), unit]));
  const actualMatches = matchesFor(occupied, shape, width, height);
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
        blocked, turnsLeft, reliability, previous);
      if (candidate && candidate.score > 0) candidates.push(candidate);
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);

  // Reassign after each choice, since two candidate plans may have wanted the same unit.
  for (const draft of candidates.slice(0, 320)) {
    if (!available.size) break;
    const candidate = candidateAt(draft.x, draft.y, shape, width, occupied, own,
      available, blocked, turnsLeft, reliability, previous);
    if (!candidate || candidate.score <= 0) continue;
    selected.push(candidate);
    candidate.cells.forEach(cell => blocked.add(cell));
    candidate.assignments.forEach(({ unit }) => available.delete(handleOf(unit)));
  }

  const assignments = selected.flatMap(plan => plan.assignments);
  const movement = route(assignments, occupied, width, height, blockedMoves);
  const nextTargets = new Map(assignments.map(({ unit, target }) =>
    [handleOf(unit), keyOf(target.x, target.y, width)]));
  const protectedMixed = selected.filter(plan => plan.complete && plan.foreign > 0)
    .flatMap(plan => plan.assignments.map(({ unit }) => handleOf(unit)));
  return { ...movement, nextTargets, protectedMixed, selected, unassigned: [...available.keys()] };
}

module.exports = { planTurn, matchesFor, occupiedBy, keyOf };
