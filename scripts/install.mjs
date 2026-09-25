import { copyFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const destination = process.argv[2];
if (!destination) {
  console.error('Usage: node scripts/install.mjs /path/to/LACK');
  process.exitCode = 1;
} else {
  const root = resolve(import.meta.dirname, '..');
  const kit = resolve(destination);
  await mkdir(join(kit, 'src'), { recursive: true });
  await copyFile(join(root, 'player.js'), join(kit, 'player.js'));
  await copyFile(join(root, 'src/planner.js'), join(kit, 'src/planner.js'));
  console.log(`Installed player.js and src/planner.js in ${kit}`);
}
