// Keeps a player client connected so wins keep accumulating.
//
//   npm run play                 # foreground, Ctrl-C to stop
//   npm run play -- --once       # run a single client, do not restart it
//
// The contest client does not reconnect: it logs the close code and exits. Arena
// ranks on accumulated wins, so every minute disconnected is rank not earned.
// This restarts it, backing off when the failure is immediate, and refuses to
// race a second copy because one connection controls an account — a duplicate
// would close the first (4001) and the two would fight.
import { spawn } from 'node:child_process';
import { readFile, writeFile, unlink, mkdir, readdir, stat, rename } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { resolve, join } from 'node:path';

const argumentAfter = flag => {
  const index = process.argv.indexOf(flag);
  return index > -1 ? process.argv[index + 1] : undefined;
};
const kit = resolve(argumentAfter('--kit') ?? process.env.LACK_KIT ?? '../LACK');
const endpoint = process.env.LATTICE_ENDPOINT || 'wss://latticeanimals.com/ws';
const token = process.env.LATTICE_PLAYER_TOKEN;
const tracesDirectory = resolve(process.env.LACK_TRACES ?? 'traces');
const logDirectory = resolve(process.env.LATTICE_LOGS ?? 'logs');
const lockFile = resolve('.player.lock');
const once = process.argv.includes('--once');
const archiveEvery = Number.parseInt(process.env.LATTICE_ARCHIVE_MINUTES ?? '20', 10);

const MIN_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 120_000;
const HEALTHY_MS = 120_000;
const COMPRESS_AFTER_MS = 6 * 60 * 60 * 1000;

if (!token) {
  console.error('No LATTICE_PLAYER_TOKEN. Run: node --env-file-if-exists=.env tools/player-token.mjs');
  process.exit(1);
}

const stamp = () => new Date().toISOString();
let logStream;
const log = async message => {
  const line = `${stamp()} ${message}\n`;
  process.stdout.write(line);
  logStream?.write(line);
};

/** Refuse to start beside a live supervisor; a second client would evict the first. */
async function claimLock() {
  const existing = await readFile(lockFile, 'utf8').catch(() => null);
  if (existing) {
    const pid = Number.parseInt(existing, 10);
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch {}
    if (alive) {
      console.error(`A supervisor is already running as pid ${pid}. Stop it first, or delete ${lockFile} if it is stale.`);
      process.exit(1);
    }
    await log(`Clearing a stale lock from pid ${pid}.`);
  }
  await writeFile(lockFile, String(process.pid));
}

/** Still ours? A supervisor that lost the lock must not fight the one that holds it. */
async function holdsLock() {
  const current = await readFile(lockFile, 'utf8').catch(() => null);
  return current === String(process.pid);
}

async function releaseLock() {
  const current = await readFile(lockFile, 'utf8').catch(() => null);
  if (current === String(process.pid)) await unlink(lockFile).catch(() => {});
}

/** Old traces compress well and are only read in bulk; keep the directory small. */
async function compressOldTraces() {
  const names = await readdir(tracesDirectory).catch(() => []);
  const cutoff = Date.now() - COMPRESS_AFTER_MS;
  for (const name of names.filter(entry => entry.endsWith('.jsonl'))) {
    const path = join(tracesDirectory, name);
    const info = await stat(path).catch(() => null);
    if (!info || info.mtimeMs > cutoff) continue;
    try {
      await pipeline(createReadStream(path), createGzip(), createWriteStream(`${path}.gz`));
      await unlink(path);
    } catch {}
  }
}

/** Archive finished games so the analysis tools see this session's play. */
function archive() {
  const child = spawn(process.execPath, [resolve('tools/record.mjs'), '--once'], {
    env: process.env, stdio: ['ignore', 'ignore', 'ignore'],
  });
  child.on('error', () => {});
}

let child = null;
let stopping = false;

function runClient() {
  return new Promise(resolve => {
    child = spawn(process.execPath, ['client.js', token, endpoint], {
      cwd: kit,
      env: { ...process.env, LACK_TRACES: tracesDirectory },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let closeCode = null;
    const watch = stream => stream.on('data', data => {
      for (const line of String(data).split('\n').filter(Boolean)) {
        const match = line.match(/Disconnected (\d+)/);
        if (match) closeCode = Number.parseInt(match[1], 10);
        void log(`  client | ${line}`);
      }
    });
    watch(child.stdout);
    watch(child.stderr);
    child.on('error', error => { void log(`Client failed to start: ${error.message}`); });
    child.on('exit', (code, signal) => {
      child = null;
      resolve({ code, signal, closeCode });
    });
  });
}

await mkdir(logDirectory, { recursive: true });
await mkdir(tracesDirectory, { recursive: true });
logStream = createWriteStream(join(logDirectory, 'player.log'), { flags: 'a' });
await claimLock();

const shutdown = async signal => {
  if (stopping) return;
  stopping = true;
  await log(`Stopping on ${signal}.`);
  child?.kill('SIGTERM');
  await releaseLock();
  process.exit(0);
};
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void shutdown(signal));

await log(`Supervising ${kit} against ${endpoint}. Traces in ${tracesDirectory}.`);
let backoff = MIN_BACKOFF_MS;
let sinceArchive = Date.now();

while (!stopping) {
  // Checked before every start, not just at boot: a supervisor that was launched
  // in a way that outlived its shell can otherwise sit here evicting the live one
  // with 4001 for as long as it runs.
  if (!await holdsLock()) {
    await log('Another supervisor holds the lock. Exiting rather than fighting it.');
    break;
  }
  const startedAt = Date.now();
  const { code, signal, closeCode } = await runClient();
  const ranFor = Date.now() - startedAt;
  await log(`Client exited (code ${code}, signal ${signal ?? 'none'}, close ${closeCode ?? 'none'}) after ${Math.round(ranFor / 1000)}s.`);

  // Rotation permanently detaches control; reconnecting cannot recover it.
  if (closeCode === 4003) {
    await log('The player token was rotated. Fetch a new one with tools/player-token.mjs, then restart.');
    break;
  }
  if (once || stopping) break;
  // A replacement connection means something else holds the account.
  if (closeCode === 4001) {
    await log('Another client took over this account. Waiting longer before trying again.');
    backoff = MAX_BACKOFF_MS;
  } else {
    backoff = ranFor > HEALTHY_MS ? MIN_BACKOFF_MS : Math.min(MAX_BACKOFF_MS, backoff * 2);
  }

  if (archiveEvery > 0 && Date.now() - sinceArchive > archiveEvery * 60_000) {
    sinceArchive = Date.now();
    await compressOldTraces();
    archive();
  }
  await log(`Reconnecting in ${Math.round(backoff / 1000)}s.`);
  await new Promise(done => setTimeout(done, backoff));
}

await releaseLock();
