import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';

const kit = process.argv[2];
if (!kit) {
  console.error('Usage: node scripts/benchmark.mjs /path/to/LACK [games]');
  process.exit(1);
}
const require = createRequire(import.meta.url);
const Game = require(join(resolve(kit), 'game/Game.js'));
const Strategy = require(join(resolve(kit), 'player.js'));
const games = Number.parseInt(process.argv[3] || '5', 10);
const n = Number.parseInt(process.env.BENCH_UNITS || '16', 10);
const rounds = Number.parseInt(process.env.BENCH_ROUNDS || '4', 10);
const turns = Number.parseInt(process.env.LACK_TURNS_PER_ROUND || '64', 10);
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
  const records = ['plan', 'random'].flatMap(playerId => Array.from({ length: n }, (_, i) => ({
    unitId: `${playerId}-${i}`, playerId, playerName: playerId, handle: String(i), energy: 2,
  })));
  const game = new Game(records, { width: 64, height: 64 }, random);
  const player = new Strategy();
  for (let r = 0; r < rounds && game.viableShapes.length; r++) {
    const shape = game.viableShapes[(seed + r * 3) % game.viableShapes.length];
    game.round(shape);
    player.round(64, 64, shape);
    for (let t = 0; t < turns; t++) {
      const start = performance.now();
      const commands = await player.turn(game.observe('plan'), 500);
      slowestMs = Math.max(slowestMs, performance.now() - start);
      const batch = {};
      for (const command of commands) {
        const id = game.unitIdFor('plan', String(command.handle));
        if (id && !Object.hasOwn(batch, id)) batch[id] = command;
      }
      for (const unit of game.observe('random').ownUnits) {
        const directions = ['up', 'down', 'left', 'right'];
        if (random() < 0.8) batch[game.unitIdFor('random', unit.handle)] = {
          commandName: 'move', params: [directions[Math.floor(random() * 4)]],
        };
      }
      game.turn(batch);
    }
    player.roundEnd(game.outcomesFor('plan', game.match()));
  }
  game.finish('round-limit');
  const mine = game.resultFor('plan');
  const theirs = game.resultFor('random');
  results.push({ seed, ownEnergy: mine.totalEnergy, otherEnergy: theirs.totalEnergy,
    survivors: mine.survivorCount, opponentSurvivors: theirs.survivorCount,
    winner: mine.winner });
}
console.log(JSON.stringify({ results, wins: results.filter(result => result.winner).length,
  slowestDecisionMs: Math.round(slowestMs * 10) / 10 }, null, 2));
