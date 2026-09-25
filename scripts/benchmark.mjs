// Local evaluation against the reference engine.
//
//   node scripts/benchmark.mjs ../LACK [games] [--vs greedy,hive] [--record]
//
// Opponents come from `node tools/fetch-opponents.mjs`; `random` needs no download.
// `--record` writes replays in the same schema the arena recorder archives, so
// `tools/analyze.mjs` reads local and live games through one code path.
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { writeRecord } from '../tools/archive.mjs';

const kit = process.argv[2];
if (!kit || kit.startsWith('--')) {
  console.error('Usage: node scripts/benchmark.mjs /path/to/LACK [games] [--vs names] [--record]');
  process.exit(1);
}
const require = createRequire(import.meta.url);
const Game = require(join(resolve(kit), 'game/Game.js'));
const Player = require(join(resolve(kit), 'game/Player.js'));
const Strategy = require(join(resolve(kit), 'player.js'));

const argumentAfter = flag => {
  const index = process.argv.indexOf(flag);
  return index > -1 ? process.argv[index + 1] : undefined;
};
const games = Number.parseInt(process.argv[3]?.startsWith('--') ? '5' : process.argv[3] || '5', 10);
const opponentNames = (argumentAfter('--vs') || 'random').split(',').map(name => name.trim()).filter(Boolean);
const record = process.argv.includes('--record');
const runsDirectory = resolve(process.env.LATTICE_RUNS || 'runs');
const opponentsDirectory = resolve(process.env.LACK_OPPONENTS || 'opponents');
const units = Number.parseInt(process.env.BENCH_UNITS || '16', 10);
const rounds = Number.parseInt(process.env.BENCH_ROUNDS || '4', 10);
const turns = Number.parseInt(process.env.LACK_TURNS_PER_ROUND || '64', 10);

/** The site ships bare class declarations that close over a global `Player`. */
async function loadOpponent(name) {
  if (name === 'random') return null;
  if (name === 'self') return Strategy;
  const source = await readFile(join(opponentsDirectory, `${name}.js`), 'utf8')
    .catch(() => { throw new Error(`Missing ${name}. Run: node tools/fetch-opponents.mjs`); });
  const className = source.match(/^\s*class\s+(\w+)/m)?.[1];
  if (!className) throw new Error(`No class declaration in ${name}.js`);
  return new Function('Player', `${source}\nreturn ${className};`)(Player);
}

const directions = ['up', 'down', 'left', 'right'];
const competitors = [{ id: 'plan', Strategy }];
for (const name of opponentNames) competitors.push({ id: name, Strategy: await loadOpponent(name) });

const results = [];
let slowestMs = 0;

for (let seed = 1; seed <= games; seed++) {
  let randomState = seed * 2654435761 >>> 0;
  const random = () => {
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    return (randomState >>> 0) / 4294967296;
  };
  const roster = competitors.flatMap(({ id }) => Array.from({ length: units }, (_, index) => ({
    unitId: `${id}-${index}`, playerId: id, playerName: id, handle: String(index), energy: 2,
  })));
  const game = new Game(roster, { width: 64, height: 64 }, random);
  const players = new Map(competitors.map(({ id, Strategy: Class }) => [id, Class ? new Class() : null]));
  const progress = [];
  const perRound = [];

  for (let index = 0; index < rounds && game.viableShapes.length; index++) {
    const shape = game.viableShapes[(seed + index * 3) % game.viableShapes.length];
    game.round(shape);
    const before = new Map(competitors.map(({ id }) => [id, game.observe(id).ownUnits.length]));
    for (const [id, player] of players) {
      if (player) player.round(64, 64, shape);
    }
    for (let turn = 0; turn < turns; turn++) {
      const batch = {};
      for (const { id } of competitors) {
        const player = players.get(id);
        const state = game.observe(id);
        if (!state.ownUnits.length) continue;
        let commands;
        if (player) {
          const started = performance.now();
          commands = await player.turn(state, 500);
          const elapsed = performance.now() - started;
          if (id === 'plan') slowestMs = Math.max(slowestMs, elapsed);
        } else {
          commands = state.ownUnits.flatMap(unit => random() < 0.8
            ? [{ handle: unit.handle, commandName: 'move', params: [directions[Math.floor(random() * 4)]] }] : []);
        }
        for (const command of commands ?? []) {
          const unitId = game.unitIdFor(id, String(command.handle));
          if (unitId && !Object.hasOwn(batch, unitId)) batch[unitId] = command;
        }
      }
      game.turn(batch);
    }
    const matchResult = game.match();
    const roundSummary = { round: index, shape: shape.name, players: [] };
    for (const { id } of competitors) {
      const outcomes = game.outcomesFor(id, matchResult);
      const player = players.get(id);
      if (player?.roundEnd) player.roundEnd(outcomes);
      roundSummary.players.push({ userName: id, started: before.get(id),
        matched: outcomes.filter(outcome => outcome.won).length, total: outcomes.length,
        eliminated: outcomes.filter(outcome => outcome.eliminated).length, shapeSize: shape.cells.length });
    }
    perRound.push(roundSummary);
    progress.push({ round: index, players: competitors.map(({ id }) => {
      const survivors = game.units.filter(unit => unit.playerId === id);
      return { userName: id, totalEnergy: survivors.reduce((sum, unit) => sum + unit.energy, 0),
        survivorCount: survivors.length };
    }) });
  }

  game.finish('round-limit');
  const outcome = { seed, rounds: perRound,
    standings: competitors.map(({ id }) => ({ name: id, ...game.resultFor(id) })) };
  results.push(outcome);

  if (record) {
    const gameId = `local-${opponentNames.join('-')}-${seed}`;
    await writeRecord(runsDirectory, gameId, {
      gameId, capturedAt: new Date().toISOString(),
      summary: { mode: 'local', width: 64, height: 64, maxRounds: rounds, progress,
        players: competitors.map(({ id }) => ({ userName: id, initialCount: units, golem: false })),
        results: game.view.results },
      replay: { gameId, status: 'finished', endReason: game.view.endReason,
        results: game.view.results, log: game.view },
    });
  }
}

const label = name => name.padEnd(10);
const rate = (matched, total) => total ? `${(100 * matched / total).toFixed(1)}%` : '—';
console.log(`\n${competitors.length} competitors, ${units} units each, ${rounds} rounds x ${turns} turns, ${games} game(s)\n`);
for (const { id } of competitors) {
  const rows = results.flatMap(result => result.rounds.flatMap(round =>
    round.players.filter(player => player.userName === id)));
  const matched = rows.reduce((sum, row) => sum + row.matched, 0);
  const started = rows.reduce((sum, row) => sum + row.started, 0);
  const ceiling = rows.reduce((sum, row) => sum + row.shapeSize * Math.floor(row.started / row.shapeSize), 0);
  const wins = results.filter(result => result.standings.find(standing => standing.name === id)?.winner).length;
  const energy = results.reduce((sum, result) =>
    sum + (result.standings.find(standing => standing.name === id)?.totalEnergy ?? 0), 0) / games;
  // The solo ceiling assumes no foreign units help; exceeding it is legal and good.
  console.log(`${label(id)} match ${rate(matched, started).padStart(6)} of units   ` +
    `${rate(matched, ceiling).padStart(6)} of its solo ceiling   ` +
    `final energy ${energy.toFixed(1).padStart(5)}   wins ${wins}/${games}`);
}
console.log(`\nslowest own decision ${Math.round(slowestMs * 10) / 10}ms`);
if (record) console.log(`replays written to ${runsDirectory}`);
