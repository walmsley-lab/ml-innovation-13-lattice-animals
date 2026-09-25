// Projects how a strategy will fare in the arena, from archived play.
//
//   node tools/predict.mjs [--me NAME] [--subject plan]
//
// Rounds are not independent: a competitor that misses matches loses units, and
// fewer units means a lower match rate next round. The archive measures that
// curve, so a projection has to simulate the spiral rather than multiply a mean.
import { resolve } from 'node:path';
import { listRecords, readRecord } from './archive.mjs';

const argumentAfter = flag => {
  const index = process.argv.indexOf(flag);
  return index > -1 ? process.argv[index + 1] : undefined;
};
const runsDirectory = resolve(argumentAfter('--runs') ?? process.env.LATTICE_RUNS ?? 'runs');
const subject = argumentAfter('--subject') ?? 'plan';
const startingUnits = Number.parseInt(argumentAfter('--units') ?? '32', 10);
const maxRounds = Number.parseInt(argumentAfter('--rounds') ?? '16', 10);

const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

/** Per-round observations: how many units a competitor held, and how many matched. */
function observations(record) {
  const log = record.replay?.log;
  const players = record.summary?.players ?? [];
  const progress = record.summary?.progress ?? [];
  if (!log?.rounds) return [];
  const startingEnergy = log.config?.startingEnergy ?? 2;
  const state = new Map(players.map(player => [player.userName, {
    energy: (player.initialCount ?? 0) * startingEnergy, survivors: player.initialCount ?? 0,
  }]));
  const rows = [];
  for (const round of log.rounds) {
    if (!round.completed) continue;
    const sample = progress.find(entry => entry.round === round.index);
    if (!sample) continue;
    const shapeSize = log.turns[round.endTurn]?.targetShape?.cells?.length ?? null;
    for (const [name, start] of state) {
      const totals = sample.players.find(entry => entry.userName === name);
      if (!totals) continue;
      const unmatched = start.energy - totals.totalEnergy;
      if (start.survivors > 0) {
        rows.push({ game: record.gameId, name, round: round.index, shapeSize,
          before: start.survivors, matched: start.survivors - unmatched,
          rate: (start.survivors - unmatched) / start.survivors,
          energyBefore: start.energy, energyAfter: totals.totalEnergy, after: totals.survivorCount });
      }
      state.set(name, { energy: totals.totalEnergy, survivors: totals.survivorCount });
    }
  }
  return rows;
}

/** Match rate against surviving units, as a step function over the observed data. */
function rateCurve(rows) {
  const buckets = new Map();
  for (const row of rows) {
    const bucket = Math.min(8, Math.floor(row.before / 4));
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(row.rate);
  }
  const table = new Map([...buckets].map(([bucket, rates]) => [bucket, mean(rates)]));
  return survivors => {
    let bucket = Math.min(8, Math.floor(survivors / 4));
    while (bucket >= 0 && !table.has(bucket)) bucket--;
    if (bucket < 0) return mean([...table.values()]) ?? 0;
    return table.get(bucket);
  };
}

/**
 * Attrition as two buckets of units, at full and at one energy. Which units go
 * unmatched decides how fast a force dies, so the triage rule is fitted, not assumed.
 */
function simulate(curve, { units = startingUnits, rounds = maxRounds, triage = 'proportional', rates = null } = {}) {
  let full = units, weak = 0;
  const trace = [];
  for (let round = 0; round < rounds; round++) {
    const survivors = full + weak;
    if (survivors <= 0) break;
    const rate = rates ? rates[round] ?? curve(survivors) : curve(survivors);
    const unmatched = survivors * (1 - rate);
    let lostFull, lostWeak;
    if (triage === 'protect-weak') {
      lostFull = Math.min(unmatched, full);
      lostWeak = unmatched - lostFull;
    } else if (triage === 'sacrifice-weak') {
      lostWeak = Math.min(unmatched, weak);
      lostFull = unmatched - lostWeak;
    } else {
      lostFull = unmatched * (full / survivors);
      lostWeak = unmatched * (weak / survivors);
    }
    full -= lostFull;
    weak = weak - lostWeak + lostFull;
    trace.push({ round, survivors: full + weak, energy: 2 * full + weak, rate });
  }
  return { energy: 2 * full + weak, survivors: full + weak, trace };
}

const runs = [];
for (const name of await listRecords(runsDirectory)) runs.push(await readRecord(runsDirectory, name));
const arena = runs.filter(run => !run.gameId.startsWith('local'));
const local = runs.filter(run => run.gameId.startsWith('local'));
const arenaRows = arena.flatMap(observations);
const localRows = local.flatMap(observations);

if (!arenaRows.length) {
  console.error(`No arena games in ${runsDirectory}. Run: npm run record -- --once`);
  process.exit(1);
}

// Which triage rule reproduces real outcomes? Replay each competitor's own
// observed per-round rates and compare the projected finish to the actual one.
const actuals = [];
for (const record of arena) {
  const rows = observations(record);
  // An eliminated competitor stops appearing in progress samples, so its last
  // sample overstates the finish. The declared results are authoritative.
  const results = new Map((record.replay?.results ?? record.summary?.results ?? [])
    .map(result => [result.name, result]));
  for (const name of [...new Set(rows.map(row => row.name))]) {
    const own = rows.filter(row => row.name === name).sort((a, b) => a.round - b.round);
    if (!own.length) continue;
    const declared = results.get(name);
    actuals.push({ name, rates: own.map(row => row.rate), units: own[0].before, rounds: own.length,
      energy: declared?.totalEnergy ?? own.at(-1).energyAfter,
      survivors: declared?.survivorCount ?? own.at(-1).after });
  }
}
const fits = ['proportional', 'protect-weak', 'sacrifice-weak'].map(triage => {
  const errors = actuals.map(actual => {
    const projected = simulate(null, { units: actual.units, rounds: actual.rounds, triage, rates: actual.rates });
    return Math.abs(projected.energy - actual.energy);
  });
  return { triage, error: mean(errors) };
}).sort((a, b) => a.error - b.error);
const triage = fits[0].triage;

console.log(`Archive: ${arena.length} arena game(s), ${arenaRows.length} competitor-rounds` +
  (local.length ? `; ${local.length} local game(s), ${localRows.length} competitor-rounds` : ''));
console.log('\nAttrition model fit (mean error in final energy, replaying observed rates):');
for (const fit of fits) console.log(`  ${fit.triage.padEnd(16)} ${fit.error.toFixed(2)}`);

const fieldCurve = rateCurve(arenaRows);
console.log('\nMatch rate against surviving units (whole field):');
for (const units of [32, 24, 16, 8, 4]) console.log(`  ${String(units).padStart(2)} units  ${(fieldCurve(units) * 100).toFixed(1)}%`);

const subjectRows = localRows.filter(row => row.name === subject);
if (!subjectRows.length) {
  console.error(`\nNo local rounds for '${subject}'. Record some:`);
  console.error('  BENCH_UNITS=32 BENCH_ROUNDS=16 node scripts/benchmark.mjs ../LACK 6 --vs hive --record');
  process.exit(1);
}
const subjectCurve = rateCurve(subjectRows);
console.log(`\nMatch rate for '${subject}' measured locally (${subjectRows.length} rounds):`);
for (const units of [32, 24, 16, 8, 4]) console.log(`  ${String(units).padStart(2)} units  ${(subjectCurve(units) * 100).toFixed(1)}%`);

const flatBaseline = actuals.map(actual => actual.energy).sort((a, b) => a - b);
const projection = simulate(subjectCurve, { triage });
console.log(`\nProjected over ${maxRounds} rounds from ${startingUnits} units (${triage} triage):`);
for (const step of projection.trace.filter((_, index) => index % 4 === 0 || index === projection.trace.length - 1)) {
  console.log(`  round ${String(step.round).padStart(2)}  ${step.survivors.toFixed(1).padStart(5)} units  ` +
    `${step.energy.toFixed(1).padStart(5)} energy  at ${(step.rate * 100).toFixed(1)}%`);
}
console.log(`  final     ${projection.survivors.toFixed(1)} units, ${projection.energy.toFixed(1)} energy`);

// The whole game is one number. Holding a flat match rate, what does it buy?
console.log('\nSensitivity: a flat match rate held all game, from 32 units:');
for (const flat of [0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95]) {
  const result = simulate(() => flat, { triage });
  const beats = actualsReady => actualsReady.filter(energy => energy < result.energy).length;
  console.log(`  ${(flat * 100).toFixed(0).padStart(3)}%  ->  ${result.energy.toFixed(1).padStart(5)} energy, ` +
    `${result.survivors.toFixed(1).padStart(4)} units` + (flatBaseline ? `   beats ${beats(flatBaseline)}% of observed finishes` : ''));
}

// Beat the opponent's finishing energy and you win; the archive supplies theirs.
const opponents = new Map();
for (const actual of actuals) {
  if (!opponents.has(actual.name)) opponents.set(actual.name, []);
  opponents.get(actual.name).push(actual.energy);
}
const all = actuals.map(actual => actual.energy).sort((a, b) => a - b);
const beaten = all.filter(energy => energy < projection.energy).length;
console.log(`\nAgainst ${all.length} observed finishes, ${projection.energy.toFixed(1)} energy beats ` +
  `${beaten} (${(100 * beaten / all.length).toFixed(0)}%), median finish ${all[Math.floor(all.length / 2)]}`);
console.log('\nHead to head, by each opponent\'s observed finishing energy:');
const table = [...opponents].map(([name, energies]) => ({
  name, games: energies.length, median: energies.slice().sort((a, b) => a - b)[Math.floor(energies.length / 2)],
  win: energies.filter(energy => energy < projection.energy).length / energies.length,
})).sort((a, b) => b.median - a.median);
for (const row of table) {
  console.log(`  ${row.name.slice(0, 26).padEnd(26)} ${String(row.games).padStart(3)} games   ` +
    `median ${String(row.median).padStart(3)}e   we win ${(row.win * 100).toFixed(0).padStart(3)}%`);
}
