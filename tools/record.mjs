// Headless arena recorder. Archives finished games as replay JSON so strategy
// changes can be evaluated against real play instead of guesses.
//
//   node --env-file=.env tools/record.mjs [--once] [--live] [--runs DIR]
//
// Authentication uses the website session, not the player token: set
// LATTICE_SESSION_TOKEN (browser local storage key `latticeanimals.session.v1`)
// or LATTICE_USER and LATTICE_PASSWORD.
import { mkdir, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { connect, authenticate, credentialsFromEnvironment, DEFAULT_ENDPOINT } from './protocol.mjs';
import { ReplayAssembler, mergeProgress } from './replay.mjs';
import { writeRecord, archivedIds } from './archive.mjs';

const CAPTURE_TIMEOUT_MS = 90_000;
const BETWEEN_CAPTURES_MS = 300;

const flags = new Set(process.argv.slice(2).filter(argument => argument.startsWith('--')));
const runsFlagIndex = process.argv.indexOf('--runs');
const runsDirectory = resolve(runsFlagIndex > -1 ? process.argv[runsFlagIndex + 1] : process.env.LATTICE_RUNS || 'runs');
const once = flags.has('--once');
const live = flags.has('--live');

const summaries = new Map();
const archived = new Set();
const queue = [];
let capturing = null;

const log = (...parts) => console.log(new Date().toISOString(), ...parts);

async function loadArchive() {
  await mkdir(runsDirectory, { recursive: true });
  for (const gameId of await archivedIds(runsDirectory)) archived.add(gameId);
  log(`Archive at ${runsDirectory} holds ${archived.size} game(s).`);
}

function enqueue(gameId) {
  if (archived.has(gameId) || queue.includes(gameId) || capturing === gameId) return;
  queue.push(gameId);
}

function receiveArena(message) {
  for (const game of message.games ?? []) {
    const previous = summaries.get(game.gameId);
    const progress = mergeProgress(previous?.progress, game);
    summaries.set(game.gameId, { ...previous, ...game, progress, userColors: message.userColors ?? previous?.userColors });
    if (game.status === 'finished' || (live && game.status === 'playing')) enqueue(game.gameId);
  }
  if (message.clash) {
    const game = message.clash;
    const previous = summaries.get(game.gameId);
    summaries.set(game.gameId, { ...previous, ...game, progress: mergeProgress(previous?.progress, game) });
    if (game.status === 'finished' || live) enqueue(game.gameId);
  }
}

/** Watch one game until its replay is complete, then release the subscription. */
async function capture(session, gameId) {
  const assembler = new ReplayAssembler();
  let settle;
  const finished = new Promise((resolveCapture, rejectCapture) => { settle = { resolveCapture, rejectCapture }; });
  const stop = session.onMessage(message => {
    if (message.gameId !== gameId) return;
    if (message.type === 'game-unavailable') return settle.rejectCapture(new Error('Game is no longer available.'));
    if (message.type !== 'game-chunk') return;
    let snapshot;
    try { snapshot = assembler.accept(message); }
    catch (error) { return settle.rejectCapture(error); }
    if (!snapshot?.log?.turns?.length) return;
    if (snapshot.status === 'finished') settle.resolveCapture(snapshot);
  });
  const timer = setTimeout(() => settle.rejectCapture(new Error('Capture timed out.')), CAPTURE_TIMEOUT_MS);
  try {
    await session.request('watch', { gameId });
    return await finished;
  } finally {
    clearTimeout(timer);
    stop();
    await session.request('unwatch').catch(() => {});
  }
}

async function save(gameId, replay) {
  const summary = summaries.get(gameId) ?? null;
  const record = { gameId, capturedAt: new Date().toISOString(), summary, replay };
  await writeRecord(runsDirectory, gameId, record);
  const results = replay.results ?? summary?.results ?? [];
  await appendFile(join(runsDirectory, 'index.jsonl'), JSON.stringify({
    gameId, capturedAt: record.capturedAt, mode: summary?.mode ?? replay.mode ?? 'arena',
    endReason: replay.endReason ?? summary?.endReason ?? null,
    turns: replay.log?.turns?.length ?? 0, rounds: replay.log?.rounds?.length ?? 0,
    players: (summary?.players ?? []).map(player => player.userName),
    winner: results.find(result => result.winner)?.name ?? null,
  }) + '\n');
  archived.add(gameId);
}

async function drain(session) {
  while (queue.length) {
    const gameId = queue.shift();
    if (archived.has(gameId)) continue;
    capturing = gameId;
    try {
      const replay = await capture(session, gameId);
      await save(gameId, replay);
      log(`Archived ${gameId} (${replay.log.turns.length} turns, ${replay.log.rounds?.length ?? 0} rounds).`);
    } catch (error) {
      log(`Skipped ${gameId}: ${error.message}`);
    } finally {
      capturing = null;
    }
    await new Promise(done => setTimeout(done, BETWEEN_CAPTURES_MS));
  }
}

await loadArchive();
const session = await connect(DEFAULT_ENDPOINT);
let user;
try {
  ({ user } = await authenticate(session, credentialsFromEnvironment()));
} catch (error) {
  session.close();
  console.error(`Cannot spectate: ${error.message}`);
  console.error('Copy .env.example to .env and supply a session token, then rerun.');
  process.exit(1);
}
log(`Spectating as ${user?.userName ?? 'unknown'} at ${DEFAULT_ENDPOINT}.`);

let arenaSeen = false;
session.onMessage(message => {
  if (message.type !== 'arena') return;
  arenaSeen = true;
  receiveArena(message);
});

process.on('SIGINT', () => { log('Stopping.'); session.close(); process.exit(0); });

// The first arena broadcast arrives unsolicited after authentication.
await session.next(message => message.type === 'arena', 30_000)
  .catch(() => log('No arena broadcast yet; waiting.'));

if (once) {
  await drain(session);
  log(`Done. ${archived.size} game(s) archived.`);
  session.close();
} else {
  log('Recording. Press Ctrl-C to stop.');
  const pump = setInterval(() => { if (!capturing) void drain(session); }, 2_000);
  await session.closed;
  clearInterval(pump);
  log(arenaSeen ? 'Connection closed.' : 'Connection closed before any arena data arrived.');
}
