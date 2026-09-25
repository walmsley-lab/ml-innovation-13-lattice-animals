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
