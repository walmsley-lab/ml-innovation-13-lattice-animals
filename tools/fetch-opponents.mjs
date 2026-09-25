// Downloads the site's reference strategies so local evaluation faces real play.
// They are cached, not vendored: they belong to the contest kit, not this repository.
//
//   node tools/fetch-opponents.mjs [DIR]
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const SOURCES = ['dummy', 'greedy', 'hive'];
const origin = process.env.LATTICE_ORIGIN || 'https://latticeanimals.com';
const directory = resolve(process.argv[2] || process.env.LACK_OPPONENTS || 'opponents');

await mkdir(directory, { recursive: true });
for (const name of SOURCES) {
  const url = `${origin}/players/${name}.js`;
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`${name}: ${response.status} ${response.statusText}`);
    process.exitCode = 1;
    continue;
  }
  const source = await response.text();
  await writeFile(join(directory, `${name}.js`), source);
  console.log(`${name.padEnd(8)} ${source.length} bytes`);
}
console.log(`Cached in ${directory}`);
