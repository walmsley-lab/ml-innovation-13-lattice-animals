// How each competitor converges through a round.
//
//   node tools/convergence.mjs
//
// Forming a shape needs units adjacent to each other, and getting them adjacent is
// a far easier objective than walking each one onto an exact cell. This measures
// both: the share of a competitor's units sitting in a clump at least as big as
// the target shape, and the formations actually standing, sampled through a round.
//
// Units are attributed by matching each colour group's size and matched count at
// round end against the per-competitor counts derived from energy deltas. A group
// whose colour is applied late is skipped, since its units only enter the
// measurement once blushed, by which time they have already settled.
import { listRecords, readRecord } from './archive.mjs';
import { roundOutcomes } from './rounds.mjs';

const bins = 8;
const profile = new Map();
const get = n => {
  if (!profile.has(n)) profile.set(n, Array.from({ length: bins }, () => ({ big: 0, comps: 0, units: 0, matched: 0, s: 0 })));
  return profile.get(n);
};
const components = cells => {
  const seen = new Set(); const sizes = [];
  for (const start of cells) {
    if (seen.has(start)) continue;
    let size = 0; const stack = [start]; seen.add(start);
    while (stack.length) {
      const [x, y] = stack.pop().split(',').map(Number); size++;
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const k = `${x + dx},${y + dy}`;
        if (cells.has(k) && !seen.has(k)) { seen.add(k); stack.push(k); }
      }
    }
    sizes.push(size);
  }
  return sizes;
};

for (const n of await listRecords('runs')) {
  const r = await readRecord('runs', n);
  if (r.gameId.startsWith('local')) continue;
  if ((r.summary?.mode ?? 'arena') !== 'arena') continue;
  const log = r.replay?.log; if (!log?.turns?.length) continue;
  const outcomes = roundOutcomes(r);
  if (!outcomes.verified) continue;
  for (const rd of outcomes.rounds) {
    const end = log.turns[rd.endTurn]; if (!end?.matches || rd.players.length !== 2) continue;
    const inMatch = new Set(end.matches.flat().map(p => `${p.x},${p.y}`));
    const groups = new Map();
    for (const u of end.units) {
      const key = u.blush ?? '';
      const g = groups.get(key) ?? { size: 0, matched: 0 };
      g.size++; if (inMatch.has(`${u.x},${u.y}`)) g.matched++;
      groups.set(key, g);
    }
    const rosters = [...groups].filter(([, g]) => g.size >= 5);
    if (rosters.length !== 2) continue;
    const assign = new Map(); let ok = true;
    for (const p of rd.players) {
      const hits = rosters.filter(([, g]) => g.matched === p.matched && g.size === p.survivorsAfter);
      if (hits.length !== 1) { ok = false; break; }
      assign.set(p.name, hits[0][0]);
    }
    if (!ok || new Set(assign.values()).size !== 2) continue;
    // Only unblushed groups, or groups applied immediately, are safe to track early.
    const k = rd.shapeSize ?? 4;
    const span = rd.endTurn - rd.startTurn;
    for (const [name, colour] of assign) {
      if (colour !== '') {
        const max = groups.get(colour).size;
        const early = log.turns[rd.startTurn + 3];
        if (!early || early.units.filter(u => (u.blush ?? '') === colour).length < max) continue;
      }
      const curve = get(name);
      for (let t = rd.startTurn; t <= rd.endTurn; t++) {
        const frame = log.turns[t]; if (!frame) continue;
        const cells = new Set(frame.units.filter(u => (u.blush ?? '') === colour).map(u => `${u.x},${u.y}`));
        if (!cells.size) continue;
        const idx = Math.min(bins - 1, Math.floor(bins * (t - rd.startTurn) / Math.max(1, span)));
        const sizes = components(cells);
        const slot = curve[idx];
        slot.big += sizes.filter(s => s >= k).reduce((a, b) => a + b, 0);
        slot.comps += sizes.length;
        slot.units += cells.size;
        slot.s++;
        let mine = 0;
        for (const m of frame.matches) if (m.every(p => cells.has(`${p.x},${p.y}`))) mine++;
        slot.matched += mine;
      }
    }
  }
}
console.log('Share of a player\'s units sitting in a clump at least as big as the target shape,');
console.log('through the round, against the formations actually standing.\n');
console.log('player                  ' + Array.from({ length: bins }, (_, i) => `${Math.round(100 * i / bins)}%`.padStart(7)).join(''));
for (const [name, curve] of [...profile].filter(([, c]) => c[0].s >= 15).sort((a, b) => b[1][0].s - a[1][0].s)) {
  console.log(`  ${name.slice(0, 20).padEnd(20)} clumped` + curve.map(c => c.s ? `${(100 * c.big / c.units).toFixed(0)}%`.padStart(7) : '      —').join(''));
  console.log(`  ${' '.repeat(20)} formed ` + curve.map(c => c.s ? (c.matched / c.s).toFixed(1).padStart(7) : '      —').join(''));
}
