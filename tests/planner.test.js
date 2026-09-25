'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planTurn, matchesFor, keyOf } = require('../src/planner');

const I3 = { name: 'I3', width: 1, height: 3, cells: [[0, 0], [0, 1], [0, 2]] };
const V3 = { name: 'V3', width: 2, height: 2, cells: [[0, 0], [0, 1], [1, 1]] };
const unit = (handle, x, y, energy = 2) => ({ handle, x, y, energy, blush: null });
const state = (ownUnits, others = []) => ({
  ownUnits, units: [...ownUnits, ...others].map(({ x, y }) => ({ x, y, blush: null })), messages: [],
});

test('matcher claims nonoverlapping exact translations in row-major order', () => {
  const occupied = new Set([[1, 1], [1, 2], [2, 2], [2, 1]].map(([x, y]) => keyOf(x, y, 6)));
  const matches = matchesFor(occupied, V3, 6, 6);
  assert.equal(matches.length, 1);
  assert.deepEqual([matches[0].x, matches[0].y], [1, 1]);
});

test('completed mixed formation stays still while free units seek another shape', () => {
  const input = state([unit('a', 1, 1), unit('b', 5, 5), unit('c', 6, 5), unit('d', 6, 6)],
    [{ x: 1, y: 2 }, { x: 1, y: 3 }]);
  const result = planTurn({ state: input, width: 12, height: 12, shape: I3, turnsLeft: 10 });
  assert.equal(result.commands.some(command => command.handle === 'a'), false);
  assert.deepEqual(result.protectedMixed, ['a']);
  assert.equal(result.commands.some(command => command.handle === 'b' || command.handle === 'c'), true);
});

test('one unit never receives two commands or multiple formation assignments', () => {
  const input = state([unit('a', 1, 1), unit('b', 3, 1), unit('c', 5, 2), unit('d', 8, 8)]);
  const result = planTurn({ state: input, width: 12, height: 12, shape: V3, turnsLeft: 20 });
  const assigned = result.selected.flatMap(plan => plan.assignments.map(item => item.unit.handle));
  assert.equal(new Set(assigned).size, assigned.length);
  assert.equal(new Set(result.commands.map(command => command.handle)).size, result.commands.length);
});

test('routing avoids occupied squares and colliding destinations', () => {
  const input = state([unit('a', 1, 1), unit('b', 1, 3), unit('c', 4, 3)], [{ x: 2, y: 1 }]);
  const result = planTurn({ state: input, width: 8, height: 8, shape: I3, turnsLeft: 12 });
  const occupied = new Set(input.units.map(point => keyOf(point.x, point.y, 8)));
  const destinations = [...result.expected.values()];
  assert.equal(new Set(destinations).size, destinations.length);
  assert.equal(destinations.some(destination => occupied.has(destination)), false);
});

test('returns without a plan when too few units can form the target', () => {
  const result = planTurn({ state: state([unit('a', 0, 0)]), width: 8, height: 8,
    shape: I3, turnsLeft: 3 });
  assert.deepEqual(result.commands, []);
});

test('a distant unit is recruited when the horizon allows the walk', () => {
  // Two units hold the top of an I3; the only candidate for the third is far away.
  const input = state([unit('a', 5, 5), unit('b', 5, 6), unit('c', 5, 32)]);
  const result = planTurn({ state: input, width: 40, height: 40, shape: I3, turnsLeft: 60 });
  const move = result.commands.find(command => command.handle === 'c');
  assert.ok(move, 'the distant unit should be recruited');
  assert.equal(move.params[0], 'up');
});

test('the same walk is refused when it cannot finish before the round ends', () => {
  const input = state([unit('a', 5, 5), unit('b', 5, 6), unit('c', 5, 32)]);
  const result = planTurn({ state: input, width: 40, height: 40, shape: I3, turnsLeft: 12 });
  assert.equal(result.commands.some(command => command.handle === 'c'), false);
});

test('a nearer formation is preferred when both match the same number of units', () => {
  // 'c' can complete the column at (5,5) or the one at (5,30); the near one wins.
  const input = state([unit('a', 5, 5), unit('b', 5, 6), unit('c', 5, 10),
    unit('d', 5, 30), unit('e', 5, 31)]);
  const result = planTurn({ state: input, width: 40, height: 40, shape: I3, turnsLeft: 60 });
  const move = result.commands.find(command => command.handle === 'c');
  assert.ok(move, 'the free unit should be assigned somewhere');
  assert.equal(move.params[0], 'up', 'it should close on the nearer column');
});


const X5 = { name: 'X5', width: 3, height: 3, cells: [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]] };

test('an X5 is never planned with its centre arriving after the arms', () => {
  // The centre is enclosed by the four arms, so a unit that reaches it last finds
  // it walled off and the formation can never complete.
  const layouts = [
    [unit('a', 10, 10), unit('b', 11, 10), unit('c', 12, 10), unit('d', 10, 11),
      unit('e', 10, 12), unit('f', 30, 30)],
    [unit('a', 11, 10), unit('b', 10, 11), unit('c', 12, 11), unit('d', 11, 12),
      unit('e', 28, 28)],
    [unit('a', 5, 5), unit('b', 6, 5), unit('c', 7, 5), unit('d', 8, 5),
      unit('e', 9, 5), unit('f', 5, 20), unit('g', 20, 5)],
  ];
  for (const own of layouts) {
    const result = planTurn({ state: state(own), width: 40, height: 40, shape: X5, turnsLeft: 60 });
    for (const plan of result.selected) {
      const centre = { x: plan.x + 1, y: plan.y + 1 };
      const reach = ({ unit: from, target }) =>
        Math.abs(from.x - target.x) + Math.abs(from.y - target.y);
      const toCentre = plan.assignments.find(item =>
        item.target.x === centre.x && item.target.y === centre.y);
      if (!toCentre || reach(toCentre) === 0) continue;
      const ring = plan.assignments.filter(item =>
        Math.abs(item.target.x - centre.x) + Math.abs(item.target.y - centre.y) === 1);
      const last = Math.max(0, ...ring.map(reach));
      assert.ok(reach(toCentre) < last,
        `centre arrives at ${reach(toCentre)} but the ring closes at ${last}`);
    }
  }
});

test('a foreign cell is trusted by how long the round still has to run', () => {
  // (5,5) is ours and (5,7) is foreign; the middle still has to be walked into,
  // so this is a plan being weighed, not a formation already standing.
  const own = [unit('a', 5, 5), unit('b', 9, 6), unit('c', 20, 20), unit('d', 21, 20)];
  const board = state(own, [{ x: 5, y: 7 }]);
  const scoreFor = turnsLeft => {
    const result = planTurn({ state: board, width: 40, height: 40, shape: I3, turnsLeft });
    const plan = result.selected.find(entry => entry.foreign > 0 && !entry.complete);
    return plan ? plan.score : null;
  };
  const late = scoreFor(6);
  const early = scoreFor(60);
  assert.ok(late !== null, 'a mixed plan should be worth making late in the round');
  assert.ok(early === null || early < late,
    `a mixed plan should not be valued as highly early (${early}) as late (${late})`);
});

test('an unreliable colour is trusted less than a reliable one', () => {
  const own = [unit('a', 5, 5), unit('b', 9, 6)];
  const build = blush => ({
    ownUnits: own,
    units: [...own.map(({ x, y }) => ({ x, y, blush: null })), { x: 5, y: 7, blush }],
    messages: [],
  });
  const score = blush => {
    const result = planTurn({ state: build(blush), width: 40, height: 40, shape: I3, turnsLeft: 30 });
    const plan = result.selected.find(entry => entry.foreign > 0 && !entry.complete);
    return plan ? plan.score : null;
  };
  // #dc2626 persists at about 0.09 in the fitted table; #2563eb at about 0.95.
  const flighty = score('#dc2626');
  const steady = score('#2563eb');
  assert.ok(steady !== null, 'a steady colour should support a mixed plan');
  assert.ok(flighty === null || flighty < steady,
    `a flighty colour (${flighty}) should score below a steady one (${steady})`);
});
