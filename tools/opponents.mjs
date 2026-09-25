// Profiles each competitor from archived play.
//
//   node tools/opponents.mjs [--me NAME] [--traces DIR]
//
// Replays anonymise units, so a competitor's behaviour has to be recovered.
// Three sources, in decreasing order of certainty:
//   1. Energy deltas give every competitor's matched count in every game.
//   2. In games we played, subtracting our own traced units from the board
//      leaves the opponent's units exactly.
//   3. Blush is self-applied and persists, so a competitor that always uses one
//      colour has fingerprinted itself for every game it appears in.
import { resolve, join } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { listRecords, readRecord } from './archive.mjs';
import { roundOutcomes } from './rounds.mjs';

const argumentAfter = flag => {
  const index = process.argv.indexOf(flag);
  return index > -1 ? process.argv[index + 1] : undefined;
};
const runsDirectory = resolve(argumentAfter('--runs') ?? process.env.LATTICE_RUNS ?? 'runs');
const tracesDirectory = resolve(argumentAfter('--traces') ?? process.env.LACK_TRACES ?? 'traces');
const me = argumentAfter('--me') ?? process.env.LATTICE_ME ?? null;

const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const pct = value => value === null ? '   — ' : `${(100 * value).toFixed(1).padStart(5)}%`;

async function loadTraces() {
  const names = await readdir(tracesDirectory).catch(() => []);
  const traces = [];
  for (const name of names.filter(n => n.endsWith('.jsonl') || n.endsWith('.jsonl.gz'))) {
    const bytes = await readFile(join(tracesDirectory, name));
    const text = name.endsWith('.gz') ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
    const entries = text.split('\n').filter(Boolean)
      .flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    if (entries.length) traces.push(entries);
  }
  return traces;
}

/** Our own board positions per round, keyed by the shapes and unit counts we saw. */
function ourRoundPositions(traces) {
  const index = [];
  for (const entries of traces) {
    const shapes = new Map();
    const last = new Map();
    for (const entry of entries) {
      if (entry.event === 'round') shapes.set(entry.round, entry.shape?.name);
      if (entry.event === 'turn') last.set(entry.round, entry);
    }
    for (const [round, turn] of last) {
      index.push({ round, shape: shapes.get(round), units: turn.own.length,
        cells: new Set(turn.own.map(unit => `${unit[1]},${unit[2]}`)) });
    }
  }
  return index;
}

/** Connected components under 4-adjacency, over a set of "x,y" keys. */
function components(cells) {
  const seen = new Set();
  const sizes = [];
  for (const start of cells) {
    if (seen.has(start)) continue;
    let size = 0;
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const [x, y] = stack.pop().split(',').map(Number);
      size++;
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
        const key = `${x + dx},${y + dy}`;
        if (cells.has(key) && !seen.has(key)) { seen.add(key); stack.push(key); }
      }
    }
    sizes.push(size);
  }
  return sizes;
}

const runs = [];
for (const name of await listRecords(runsDirectory)) {
  const record = await readRecord(runsDirectory, name);
  if (!record.gameId.startsWith('local')) runs.push(record);
}
const ours = ourRoundPositions(await loadTraces());

const colourRosters = new Map();
const profiles = new Map();
const profile = name => {
  if (!profiles.has(name)) profiles.set(name, { name, games: new Set(), rounds: 0,
    units: 0, matched: 0, assisted: 0, eliminated: 0, finishes: [], wins: 0,
    colours: new Map(), gamesWithColour: 0, shapes: new Map(), versus: new Map(),
    clustering: [], convergence: [] });
  return profiles.get(name);
};

for (const record of runs) {
  const players = (record.summary?.players ?? []).map(player => player.userName);
  const results = record.replay?.results ?? [];
  const outcomes = roundOutcomes(record);
  const log = record.replay?.log;

  for (const name of players) {
    const entry = profile(name);
    entry.games.add(record.gameId);
    const declared = results.find(result => result.name === name);
    if (declared) {
      entry.finishes.push(declared.totalEnergy);
      if (declared.winner) entry.wins++;
    }
    for (const other of players) if (other !== name) {
      const record0 = entry.versus.get(other) ?? { games: 0, wins: 0 };
      record0.games++;
      if (declared?.winner) record0.wins++;
      entry.versus.set(other, record0);
    }
  }

  for (const round of outcomes.rounds) {
    for (const item of round.players) {
      const entry = profile(item.name);
      entry.rounds++;
      entry.units += item.survivorsBefore;
      entry.matched += item.matched;
      entry.assisted += item.assisted ?? 0;
      entry.eliminated += item.eliminated;
      if (round.shape) {
        const shape = entry.shapes.get(round.shape) ?? { units: 0, matched: 0 };
        shape.units += item.survivorsBefore;
        shape.matched += item.matched;
        entry.shapes.set(round.shape, shape);
      }
    }

    // Our own units are known from the trace, so what is left on the board at
    // round end belongs to the opponent — exact, not inferred.
    if (!me || !players.includes(me) || players.length !== 2) continue;
    const opponent = players.find(name => name !== me);
    const frame = log?.turns?.[round.endTurn];
    const mine = round.players.find(item => item.name === me);
    if (!frame || !mine) continue;
    const match = ours.find(entry => entry.round === round.round && entry.shape === round.shape &&
      entry.units === mine.survivorsAfter + (mine.eliminated ?? 0));
    if (!match) continue;
    const theirs = new Set(frame.units.map(unit => `${unit.x},${unit.y}`));
    for (const cell of match.cells) theirs.delete(cell);
    if (!theirs.size) continue;
    const sizes = components(theirs);
    const entry = profile(opponent);
    entry.clustering.push(sizes.filter(size => size >= (round.shapeSize ?? 4))
      .reduce((sum, size) => sum + size, 0) / theirs.size);
  }

  // Colours seen in this game, with the roster that could have set them. A colour
  // belongs to whoever was present every time it appeared; crediting it to both
  // players would attribute an opponent's blush to us.
  const colours = new Set();
  for (const turn of log?.turns ?? []) for (const unit of turn.units) if (unit.blush) colours.add(unit.blush);
  for (const colour of colours) {
    if (!colourRosters.has(colour)) colourRosters.set(colour, []);
    colourRosters.get(colour).push(new Set(players));
  }
}

// Intersect the rosters: a colour with exactly one survivor has an owner.
const colourOwner = new Map();
for (const [colour, rosters] of colourRosters) {
  const owners = rosters.reduce((left, right) => new Set([...left].filter(name => right.has(name))));
  if (owners.size === 1) colourOwner.set(colour, { owner: [...owners][0], games: rosters.length });
}
for (const [colour, { owner, games }] of colourOwner) profile(owner).colours.set(colour, games);

const table = [...profiles.values()].filter(entry => entry.rounds)
  .sort((a, b) => b.matched / b.units - a.matched / a.units);

console.log(`${runs.length} arena games, ${table.length} competitors\n`);
console.log('competitor                games  rounds  match   assist/rnd  lost/rnd  median finish  wins');
for (const entry of table) {
  const finishes = entry.finishes.slice().sort((a, b) => a - b);
  console.log(`  ${entry.name.slice(0, 24).padEnd(24)} ${String(entry.games.size).padStart(4)}  ` +
    `${String(entry.rounds).padStart(6)}  ${pct(entry.matched / entry.units)}  ` +
    `${(entry.assisted / entry.rounds).toFixed(2).padStart(10)}  ` +
    `${(entry.eliminated / entry.rounds).toFixed(2).padStart(8)}  ` +
    `${String(finishes[Math.floor(finishes.length / 2)] ?? '—').padStart(13)}  ` +
    `${String(entry.wins).padStart(4)}${entry.name === me ? '  <- you' : ''}`);
}

console.log('\nWeakest shape per competitor (where to contest them):');
for (const entry of table) {
  const shapes = [...entry.shapes].filter(([, value]) => value.units >= 40)
    .map(([name, value]) => ({ name, rate: value.matched / value.units }))
    .sort((a, b) => a.rate - b.rate);
  if (!shapes.length) continue;
  const worst = shapes.slice(0, 2).map(shape => `${shape.name} ${pct(shape.rate).trim()}`).join(', ');
  console.log(`  ${entry.name.slice(0, 24).padEnd(24)} ${worst}`);
}

console.log('\nBlush, attributed only where one competitor was present every time the colour appeared:');
const ambiguous = [...colourRosters.keys()].filter(colour => !colourOwner.has(colour)).length;
for (const entry of table) {
  const owned = [...entry.colours].sort((a, b) => b[1] - a[1]);
  if (!owned.length) {
    console.log(`  ${entry.name.slice(0, 24).padEnd(24)} no colour attributable — may not blush at all`);
    continue;
  }
  const reused = owned.filter(([, games]) => games > 1).length;
  const habit = owned.length > 8 && reused <= 1
    ? `${owned.length} single-use colours — randomised, deliberately untrackable`
    : `${owned.map(([colour, games]) => `${colour}x${games}`).slice(0, 5).join(' ')}`;
  console.log(`  ${entry.name.slice(0, 24).padEnd(24)} ${habit}`);
}
console.log(`  (${ambiguous} colour(s) could not be pinned to one competitor)`);

if (me) {
  const mine = profiles.get(me);
  if (mine?.versus.size) {
    console.log(`\nHead to head for ${me}:`);
    for (const [other, record] of [...mine.versus].sort((a, b) => b[1].games - a[1].games)) {
      console.log(`  vs ${other.slice(0, 24).padEnd(24)} ${record.games} game(s), ${record.wins} win(s)`);
    }
  }
  const clustered = table.filter(entry => entry.clustering.length);
  if (clustered.length) {
    console.log('\nOpponent units in components large enough to match (from subtracting our traces):');
    for (const entry of clustered) {
      console.log(`  ${entry.name.slice(0, 24).padEnd(24)} ${pct(mean(entry.clustering))} of their units, over ${entry.clustering.length} round(s)`);
    }
  }
}
