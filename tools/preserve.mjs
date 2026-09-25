// Export an auditable, compact snapshot of ignored traces and game replays.
//
// node tools/preserve.mjs --label local-2026-09-25 [--traces traces] [--runs runs]
//
// Only known recorder fields are carried over. Replay archives are the public
// spectator representation; reject any source that contains credential-like keys.
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const arg = name => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
};
const label = arg('--label');
if (!label || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(label)) {
  console.error('Usage: node tools/preserve.mjs --label LABEL [--traces DIR] [--runs DIR]');
  process.exit(1);
}
const tracesDir = resolve(arg('--traces') || 'traces');
const runsDir = resolve(arg('--runs') || 'runs');
const destination = resolve('evidence', label);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const compressed = text => gzipSync(Buffer.from(text), { level: 9, mtime: 0 });

function publicTrace(record) {
  if (!record || typeof record !== 'object' || typeof record.event !== 'string') {
    throw new Error('Invalid trace event');
  }
  const { event, at } = record;
  if (!['start', 'round', 'turn', 'round-end', 'finish'].includes(event)) {
    throw new Error(`Unknown trace event ${event}`);
  }
  const common = { event, at };
  if (event === 'start') return { ...common, run: record.run };
  if (event === 'round') return { ...common, round: record.round,
    width: record.width, height: record.height, shape: record.shape };
  if (event === 'turn') return { ...common, round: record.round, turn: record.turn,
    remainingMs: record.remainingMs, decisionMs: record.decisionMs,
    boardUnits: record.boardUnits, own: record.own,
    commands: record.commands, plan: record.plan };
  if (event === 'round-end') return { ...common, round: record.round, outcomes: record.outcomes };
  return { ...common, result: record.result };
}

function rejectSecrets(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/(?:token|password|cookie|authorization|secret|credential|session)/i.test(key)) {
      throw new Error(`Refusing credential-like field: ${key}`);
    }
    rejectSecrets(child);
  }
}

async function exportTrace(name) {
  const source = await readFile(join(tracesDir, name), 'utf8');
  const records = source.trim().split('\n').map(line => publicTrace(JSON.parse(line)));
  for (const record of records) rejectSecrets(record);
  if (records[0]?.event !== 'start' || !records.some(item => item.event === 'round-end')) {
    throw new Error(`Trace has no completed rounds: ${name}`);
  }
  const output = compressed(records.map(record => JSON.stringify(record)).join('\n') + '\n');
  const file = `${name}.gz`;
  await writeFile(join(destination, 'traces', file), output);
  return { file: `traces/${file}`, sha256: digest(output), bytes: output.length,
    turns: records.filter(record => record.event === 'turn').length,
    rounds: records.filter(record => record.event === 'round-end').length,
    complete: records.some(record => record.event === 'finish'),
    result: records.findLast(record => record.event === 'finish')?.result ?? null };
}

async function exportReplay(name) {
  const bytes = await readFile(join(runsDir, name));
  const record = JSON.parse(name.endsWith('.gz') ? gunzipSync(bytes) : bytes.toString('utf8'));
  rejectSecrets(record);
  if (!record.replay?.log?.turns || !record.summary?.progress || !record.gameId) {
    throw new Error(`Incomplete replay: ${name}`);
  }
  const output = compressed(JSON.stringify(record));
  const file = `${record.gameId}.json.gz`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(record.gameId)) {
    throw new Error(`Invalid game ID in ${name}`);
  }
  await writeFile(join(destination, 'replays', file), output);
  return { file: `replays/${file}`, sha256: digest(output), bytes: output.length,
    gameId: record.gameId, mode: record.summary.mode, rounds: record.replay.log.rounds.length,
    results: record.replay.results };
}

const [traceNames, runNames] = await Promise.all([
  readdir(tracesDir), readdir(runsDir),
]);
const traces = traceNames.filter(name => /^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/.test(name)).sort();
const runs = runNames.filter(name => /^[A-Za-z0-9][A-Za-z0-9._-]*\.json(?:\.gz)?$/.test(name)).sort();
if (!traces.length && !runs.length) throw new Error('No traces or replays found');
await Promise.all(['traces', 'replays'].map(folder => mkdir(join(destination, folder), { recursive: true })));
const manifest = {
  format: 1, label,
  note: 'Trace ownership is private to our player; replay positions are public spectator data. Filenames do not establish a trace-to-replay pair.',
  traces: [], replays: [],
};
for (const name of traces) manifest.traces.push(await exportTrace(name));
for (const name of runs) manifest.replays.push(await exportReplay(name));
await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Preserved ${traces.length} traces and ${runs.length} replays in ${destination}`);
