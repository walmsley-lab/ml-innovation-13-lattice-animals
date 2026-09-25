'use strict';
// One archive format for captured and simulated games. Replays are large and
// highly repetitive, so they are stored compressed; readers accept either form.
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

export async function writeRecord(directory, gameId, record) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${gameId}.json.gz`);
  await writeFile(path, gzipSync(Buffer.from(JSON.stringify(record)), { level: 6 }));
  return path;
}

export async function listRecords(directory) {
  const names = await readdir(directory).catch(() => []);
  return names.filter(name => name.endsWith('.json') || name.endsWith('.json.gz'));
}

/** Game ids already held, whichever form they were stored in. */
export async function archivedIds(directory) {
  return new Set((await listRecords(directory)).map(name => name.replace(/\.json(\.gz)?$/, '')));
}

export async function readRecord(directory, name) {
  const raw = await readFile(join(directory, name));
  return JSON.parse(name.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8'));
}
