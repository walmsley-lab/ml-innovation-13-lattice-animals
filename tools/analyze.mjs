// Turns archived replays into the numbers that should drive strategy changes.
//
//   node tools/analyze.mjs [--runs DIR] [--traces DIR] [--me NAME] [--json]
//
// Every metric is derived, not assumed: ownership is recovered from energy deltas
// (a unit loses exactly one energy when it is not part of a match at round end),
// and the matcher's own greedy scan is replayed to measure what the final board
// could have scored under a better arrangement.
import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { listRecords, readRecord } from './archive.mjs';

const require = createRequire(import.meta.url);
const { matchesFor } = require('../src/planner.js');

const argumentAfter = flag => {
  const index = process.argv.indexOf(flag);
  return index > -1 ? process.argv[index + 1] : undefined;
};
const runsDirectory = resolve(argumentAfter('--runs') ?? process.env.LATTICE_RUNS ?? 'runs');
const tracesDirectory = resolve(argumentAfter('--traces') ?? process.env.LACK_TRACES ?? 'traces');
const me = argumentAfter('--me') ?? process.env.LATTICE_ME ?? process.env.LATTICE_USER ?? null;
const asJson = process.argv.includes('--json');
const showGames = process.argv.includes('--games');

const keyOf = (x, y, width) => y * width + x;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const percent = value => value === null || Number.isNaN(value) ? '   —' : `${(value * 100).toFixed(1).padStart(5)}%`;

/** Normalize a match's absolute cells back to shape offsets. */
function shapeFromCells(cells) {
  const minX = Math.min(...cells.map(cell => cell.x));
  const minY = Math.min(...cells.map(cell => cell.y));
  const offsets = cells.map(cell => [cell.x - minX, cell.y - minY]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  return {
    width: Math.max(...offsets.map(offset => offset[0])) + 1,
    height: Math.max(...offsets.map(offset => offset[1])) + 1,
    cells: offsets,
  };
}

function shapeKey(shape) {
  return shape.cells.map(([dx, dy]) => `${dx},${dy}`).join(' ');
}

/** All translations of `shape` whose cells are entirely occupied. */
function placements(occupied, shape, width, height) {
  const found = [];
  for (let y = 0; y <= height - shape.height; y++) {
    for (let x = 0; x <= width - shape.width; x++) {
      const cells = shape.cells.map(([dx, dy]) => keyOf(x + dx, y + dy, width));
      if (cells.every(cell => occupied.has(cell))) found.push(cells);
    }
  }
  return found;
}

/**
 * Lower bound on the maximum set of pairwise cell-disjoint placements. The engine
 * takes them in row-major order, which is rarely optimal; the gap is headroom that
 * a shape-aware arrangement could have claimed on the same board.
 */
function maxDisjoint(all) {
  const byCell = new Map();
  all.forEach((cells, index) => {
    for (const cell of cells) {
      if (!byCell.has(cell)) byCell.set(cell, []);
      byCell.get(cell).push(index);
    }
  });
  const conflicts = all.map((cells, index) => {
    const neighbours = new Set();
    for (const cell of cells) for (const other of byCell.get(cell)) if (other !== index) neighbours.add(other);
    return neighbours;
  });
  // Minimum-degree greedy on the conflict graph: a standard independent-set heuristic.
  const removed = new Set();
  const chosen = [];
  const degree = conflicts.map(neighbours => neighbours.size);
  while (removed.size < all.length) {
    let best = -1;
    for (let index = 0; index < all.length; index++) {
      if (removed.has(index)) continue;
      if (best === -1 || degree[index] < degree[best]) best = index;
    }
    if (best === -1) break;
    chosen.push(best);
    removed.add(best);
    for (const neighbour of conflicts[best]) {
      if (removed.has(neighbour)) continue;
      removed.add(neighbour);
      for (const second of conflicts[neighbour]) degree[second]--;
    }
  }
  return chosen.length;
}

/** Connected components of the occupied cells under 4-adjacency. */
function componentSizes(occupied, width) {
  const seen = new Set();
  const sizes = [];
  for (const start of occupied) {
    if (seen.has(start)) continue;
    let size = 0;
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const cell = stack.pop();
      size++;
      const x = cell % width, y = (cell - x) / width;
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width) continue;
        const next = keyOf(nx, ny, width);
        if (!occupied.has(next) || seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    sizes.push(size);
  }
  return sizes;
}

function analyzeRun(record) {
  const log = record.replay?.log;
  const summary = record.summary ?? {};
  if (!log?.turns?.length) return null;
  const width = log.width ?? summary.width;
  const height = log.height ?? summary.height;
  const rounds = log.rounds ?? [];
  const progress = summary.progress ?? [];
  const players = (summary.players ?? []).map(player => player.userName);

  const before = new Map((summary.players ?? []).map(player => [player.userName, {
    energy: (player.initialCount ?? 0) * (log.config?.startingEnergy ?? 2),
    survivors: player.initialCount ?? 0,
    golem: Boolean(player.golem),
  }]));

  const roundReports = [];
  for (const round of rounds) {
    if (!round.completed) continue;
    const frame = log.turns[round.endTurn];
    if (!frame) continue;
    const occupied = new Set(frame.units.map(unit => keyOf(unit.x, unit.y, width)));
    // Replays carry the round's shape; the match geometry is only a fallback.
    const recorded = frame.targetShape ?? round.targetShape;
    const shape = recorded?.cells?.length
      ? { width: recorded.width ?? Math.max(...recorded.cells.map(cell => cell[0])) + 1,
          height: recorded.height ?? Math.max(...recorded.cells.map(cell => cell[1])) + 1,
          cells: recorded.cells, name: recorded.name }
      : frame.matches.length ? shapeFromCells(frame.matches[0]) : null;
    const size = shape ? shape.cells.length : null;

    const sample = progress.find(entry => entry.round === round.index);
    const perPlayer = [];
    for (const name of players) {
      const start = before.get(name);
      const totals = sample?.players?.find(entry => entry.userName === name);
      if (!start || !totals) continue;
      // Energy falls by exactly one for each unit left out of a match.
      const unmatched = start.energy - totals.totalEnergy;
      const matched = start.survivors - unmatched;
      // What the player could have matched using only its own units. Exceeding it
      // means foreign units completed some shapes, which the rules allow.
      const solo = size ? size * Math.floor(start.survivors / size) : null;
      perPlayer.push({
        name, golem: start.golem,
        survivorsBefore: start.survivors, survivorsAfter: totals.survivorCount,
        matched, unmatched, eliminated: start.survivors - totals.survivorCount,
        solo, assisted: solo === null ? null : Math.max(0, matched - solo),
        matchRate: start.survivors ? matched / start.survivors : null,
      });
      before.set(name, { energy: totals.totalEnergy, survivors: totals.survivorCount, golem: start.golem });
    }

    // What the board was worth versus what the row-major scan collected.
    let engineMatches = frame.matches.length;
    let bestMatches = engineMatches;
    if (shape) {
      const all = placements(occupied, { ...shape }, width, height);
      engineMatches = matchesFor(occupied, { ...shape }, width, height).length;
      bestMatches = maxDisjoint(all);
    }

    // How long the round actually needed.
    const counts = [];
    for (let turn = round.startTurn; turn <= round.endTurn; turn++) {
      counts.push(log.turns[turn]?.matches?.length ?? 0);
    }
    const final = counts.at(-1) ?? 0;
    let settled = counts.length - 1;
    while (settled > 0 && counts[settled - 1] >= final) settled--;

    const sizes = componentSizes(occupied, width);
    roundReports.push({
      round: round.index,
      shape: shape?.name ?? (shape ? shapeKey(shape) : null),
      shapeSize: size,
      eliminated: round.eliminatedCount ?? null,
      engineMatches, bestMatches,
      matcherLoss: bestMatches - engineMatches,
      settledAtTurn: settled, roundTurns: counts.length - 1,
      orphanCells: size ? sizes.filter(value => value < size).reduce((sum, value) => sum + value, 0) : null,
      components: sizes.length,
      players: perPlayer,
    });
  }

  return {
    gameId: record.gameId,
    mode: summary.mode ?? record.replay?.mode ?? 'arena',
    endReason: record.replay?.endReason ?? summary.endReason ?? null,
    players,
    results: record.replay?.results ?? summary.results ?? [],
    turns: log.turns.length,
    rounds: roundReports,
  };
}

async function loadRuns() {
  const runs = [];
  for (const name of await listRecords(runsDirectory)) {
    try { runs.push(await readRecord(runsDirectory, name)); }
    catch { console.error(`Unreadable archive entry: ${name}`); }
  }
  return runs;
}

async function loadTraces() {
  let names;
  try { names = await readdir(tracesDirectory); }
  catch { return []; }
  const traces = [];
  for (const name of names.filter(entry => entry.endsWith('.jsonl'))) {
    const entries = (await readFile(join(tracesDirectory, name), 'utf8')).split('\n')
      .filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    if (entries.length) traces.push({ name, entries });
  }
  return traces;
}

function summarizeTraces(traces) {
  const rounds = [];
  const latencies = [];
  for (const trace of traces) {
    let current = null;
    for (const entry of trace.entries) {
      if (entry.event === 'round') current = { trace: trace.name, round: entry.round, turns: 0, unassigned: [], blocked: [], moving: [] };
      if (entry.event === 'turn' && current) {
        current.turns++;
        latencies.push(entry.decisionMs ?? 0);
        if (entry.plan) {
          current.unassigned.push(entry.plan.unassigned ?? 0);
          current.blocked.push(entry.plan.blocked ?? 0);
          current.moving.push(entry.plan.moving ?? 0);
        }
        current.units = entry.own?.length ?? current.units;
      }
      if (entry.event === 'round-end' && current) {
        const outcomes = entry.outcomes ?? [];
        current.matched = outcomes.filter(outcome => outcome[1] === 1).length;
        current.total = outcomes.length;
        current.lost = outcomes.filter(outcome => outcome[4] === 1).length;
        rounds.push(current);
        current = null;
      }
    }
  }
  if (!rounds.length) return null;
  return {
    rounds: rounds.length,
    matchRate: mean(rounds.filter(round => round.total).map(round => round.matched / round.total)),
    meanUnassigned: mean(rounds.flatMap(round => round.unassigned)),
    meanBlocked: mean(rounds.flatMap(round => round.blocked)),
    meanMoving: mean(rounds.flatMap(round => round.moving)),
    decisionMs: {
      mean: mean(latencies),
      p95: latencies.length ? latencies.slice().sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)] : null,
      max: latencies.length ? Math.max(...latencies) : null,
    },
  };
}

const runs = (await loadRuns()).map(analyzeRun).filter(Boolean);
const traceSummary = summarizeTraces(await loadTraces());

if (asJson) {
  console.log(JSON.stringify({ runs, traces: traceSummary }, null, 2));
} else if (!runs.length && !traceSummary) {
  console.log(`No archived games in ${runsDirectory} and no traces in ${tracesDirectory}.`);
  console.log('Record arena games first:  node --env-file=.env tools/record.mjs --once');
} else {
  if (showGames) {
    for (const run of runs) {
      const winner = run.results.find(result => result.winner)?.name ?? 'draw';
      console.log(`\n${run.gameId}  ${run.mode}  ${run.players.join(' vs ')}  winner: ${winner}  (${run.endReason})`);
      console.log('  rnd  size  matches  settled/turns  orphans  ' +
        run.rounds[0]?.players.map(player => player.name.slice(0, 10).padEnd(10)).join(' '));
      for (const round of run.rounds) {
        const cells = run.rounds[0]?.players.map(player => {
          const entry = round.players.find(candidate => candidate.name === player.name);
          return entry ? `${String(entry.matched).padStart(3)}/${String(entry.survivorsBefore).padEnd(3)}${percent(entry.matchRate)}`.padEnd(10) : ' '.repeat(10);
        }).join(' ');
        console.log(`  ${String(round.round).padStart(3)}  ${String(round.shapeSize ?? '-').padStart(4)}  ` +
          `${String(round.engineMatches).padStart(7)}  ${String(round.settledAtTurn).padStart(7)}/${String(round.roundTurns).padEnd(5)}  ` +
          `${String(round.orphanCells ?? '-').padStart(7)}  ${cells}`);
      }
    }
  }

  if (runs.length) {
    const allRounds = runs.flatMap(run => run.rounds);
    const entries = allRounds.flatMap(round => round.players);
    console.log(`\n${runs.length} game(s), ${allRounds.length} completed round(s)` +
      (showGames ? '' : '  (pass --games for per-round tables)'));

    console.log('\nBoard');
    console.log(`  rounds settle at turn ${mean(allRounds.map(round => round.settledAtTurn)).toFixed(1)} of ` +
      `${mean(allRounds.map(round => round.roundTurns)).toFixed(0)} — later turns are unused leverage`);
    console.log(`  orphaned cells        ${mean(allRounds.map(round => round.orphanCells ?? 0)).toFixed(1)} per round, stranded in components too small to match`);
    console.log(`  matcher headroom      ${mean(allRounds.map(round => round.matcherLoss)).toFixed(2)} extra disjoint placements the row-major scan left behind`);

    // One row per competitor: how much of its force it keeps matched, how often it
    // needs foreign units to do it, and how fast it is bleeding.
    const byName = new Map();
    for (const entry of entries) {
      if (!byName.has(entry.name)) byName.set(entry.name, []);
      byName.get(entry.name).push(entry);
    }
    const table = [...byName].map(([name, rows]) => ({
      name,
      golem: rows.some(row => row.golem),
      rounds: rows.length,
      matchRate: mean(rows.map(row => row.matchRate).filter(value => value !== null)),
      assisted: mean(rows.map(row => row.assisted ?? 0)),
      eliminated: mean(rows.map(row => row.eliminated)),
      survived: rows.at(-1)?.survivorsAfter ?? 0,
    })).sort((a, b) => (b.matchRate ?? 0) - (a.matchRate ?? 0));

    console.log('\nCompetitors                 rounds   match rate   assisted/rnd   lost/rnd');
    for (const row of table) {
      const flag = row.name === me ? ' <- you' : row.golem ? ' (golem)' : '';
      console.log(`  ${row.name.slice(0, 24).padEnd(24)} ${String(row.rounds).padStart(6)}   ` +
        `${percent(row.matchRate).padStart(10)}   ${row.assisted.toFixed(2).padStart(12)}   ` +
        `${row.eliminated.toFixed(2).padStart(8)}${flag}`);
    }
    if (me && !byName.has(me)) {
      console.log(`\n  No rounds found for '${me}'. Connect the client and play, then record again.`);
    }
  }

  if (traceSummary) {
    console.log(`\nLocal traces (${traceSummary.rounds} rounds):`);
    console.log(`  own match rate      ${percent(traceSummary.matchRate)}`);
    console.log(`  units unassigned    ${traceSummary.meanUnassigned?.toFixed(2)} per turn — planned for nothing`);
    console.log(`  blocked move memory ${traceSummary.meanBlocked?.toFixed(2)} entries — collisions the router had to learn around`);
    console.log(`  units moving        ${traceSummary.meanMoving?.toFixed(2)} per turn`);
    console.log(`  decision time       mean ${traceSummary.decisionMs.mean?.toFixed(1)}ms  p95 ${traceSummary.decisionMs.p95?.toFixed(1)}ms  max ${traceSummary.decisionMs.max?.toFixed(1)}ms`);
  }
}
