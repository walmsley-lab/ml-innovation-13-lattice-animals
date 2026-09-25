import { copyFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const FILES = ['player.js', 'src/planner.js', 'src/recorder.js'];

export async function install(destination) {
  const root = resolve(import.meta.dirname, '..');
  const kit = resolve(destination);
  await mkdir(join(kit, 'src'), { recursive: true });
  for (const file of FILES) await copyFile(join(root, file), join(kit, file));
  return kit;
}

// Only act as a command when run directly, so the benchmark can import it.
if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const destination = process.argv[2];
  if (!destination) {
    console.error('Usage: node scripts/install.mjs /path/to/LACK');
    process.exitCode = 1;
  } else {
    console.log(`Installed ${FILES.join(', ')} in ${await install(destination)}`);
  }
}
