import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplayAssembler, mergeProgress } from '../tools/replay.mjs';

const chunks = (payload, { baseRevision = null, parts = 1 } = {}) => {
  const data = JSON.stringify(payload);
  const size = Math.ceil(data.length / parts);
  return Array.from({ length: parts }, (_, index) => ({
    type: 'game-chunk', gameId: payload.gameId, watchId: 1,
    baseRevision, revision: payload.revision, index, total: parts,
    data: data.slice(index * size, (index + 1) * size),
  }));
};

const snapshot = (revision, turns, extra = {}) => ({
  gameId: 'g1', revision, status: 'playing', from: 0,
  log: { width: 8, height: 8, rounds: [], turns }, ...extra,
});

test('a multi-part transfer yields one snapshot only when complete', () => {
  const assembler = new ReplayAssembler();
  const parts = chunks(snapshot(1, [{ roundTurn: 0 }, { roundTurn: 1 }]), { parts: 3 });
  assert.equal(assembler.accept(parts[0]), null);
  assert.equal(assembler.accept(parts[1]), null);
  const result = assembler.accept(parts[2]);
  assert.equal(result.log.turns.length, 2);
});

test('a later revision splices new turns onto the retained log', () => {
  const assembler = new ReplayAssembler();
  for (const chunk of chunks(snapshot(1, [{ roundTurn: 0 }, { roundTurn: 1 }]))) assembler.accept(chunk);
  const update = snapshot(2, [{ roundTurn: 2 }], { from: 2 });
  let result;
  for (const chunk of chunks(update, { baseRevision: 1 })) result = assembler.accept(chunk);
  assert.deepEqual(result.log.turns.map(turn => turn.roundTurn), [0, 1, 2]);
});

test('a revision that rewrites earlier turns replaces them', () => {
  const assembler = new ReplayAssembler();
  for (const chunk of chunks(snapshot(1, [{ roundTurn: 0 }, { roundTurn: 1 }]))) assembler.accept(chunk);
  const update = snapshot(2, [{ roundTurn: 1, corrected: true }], { from: 1 });
  let result;
  for (const chunk of chunks(update, { baseRevision: 1 })) result = assembler.accept(chunk);
  assert.equal(result.log.turns.length, 2);
  assert.equal(result.log.turns[1].corrected, true);
});

test('a gap in the revision chain is rejected rather than silently accepted', () => {
  const assembler = new ReplayAssembler();
  for (const chunk of chunks(snapshot(1, [{ roundTurn: 0 }]))) assembler.accept(chunk);
  const [chunk] = chunks(snapshot(5, [{ roundTurn: 9 }], { from: 1 }), { baseRevision: 3 });
  assert.throws(() => assembler.accept(chunk), /Out-of-order/);
});

test('an out-of-order part is rejected', () => {
  const assembler = new ReplayAssembler();
  const parts = chunks(snapshot(1, [{ roundTurn: 0 }]), { parts: 2 });
  assembler.accept(parts[0]);
  assert.throws(() => assembler.accept({ ...parts[1], index: 5 }), /Incomplete/);
});

test('a snapshot without a log keeps the frames already collected', () => {
  const assembler = new ReplayAssembler();
  for (const chunk of chunks(snapshot(1, [{ roundTurn: 0 }]))) assembler.accept(chunk);
  let result;
  for (const chunk of chunks({ gameId: 'g1', revision: 2, status: 'finished' }, { baseRevision: 1 })) {
    result = assembler.accept(chunk);
  }
  assert.equal(result.status, 'finished');
  assert.equal(result.log.turns.length, 1);
});

test('progress samples accumulate and reset when the server resends from zero', () => {
  const first = mergeProgress([], { progressFrom: 0, progress: [{ round: 0 }, { round: 1 }] });
  assert.deepEqual(first.map(sample => sample.round), [0, 1]);
  const appended = mergeProgress(first, { progressFrom: 2, progress: [{ round: 1 }, { round: 2 }] });
  assert.deepEqual(appended.map(sample => sample.round), [0, 1, 2]);
  const reset = mergeProgress(appended, { progressFrom: 0, progress: [{ round: 0 }] });
  assert.deepEqual(reset.map(sample => sample.round), [0]);
});
