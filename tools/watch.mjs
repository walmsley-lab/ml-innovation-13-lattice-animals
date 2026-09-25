// Live view of results as they accumulate.
//
//   npm run watch            # refreshes until Ctrl-C
//   npm run watch -- --once  # print once and exit
//
// Reads our own traces, which carry per-unit outcomes the spectator feed does
// not, and falls back to the archive for anything we did not play.
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const argumentAfter = flag => {
  const index = process.argv.indexOf(flag);
  return index > -1 ? process.argv[index + 1] : undefined;
};
const tracesDirectory = resolve(argumentAfter('--traces') ?? process.env.LACK_TRACES ?? 'traces');
const logFile = resolve(process.env.LATTICE_LOGS ?? 'logs', 'player.log');
const lockFile = resolve('.player.lock');
const once = process.argv.includes('--once');
const every = Number.parseInt(argumentAfter('--every') ?? '20', 10) * 1000;

const pct = (part, whole) => whole ? `${(100 * part / whole).toFixed(1)}%` : '—';

async function readTraces() {
  const names = await readdir(tracesDirectory).catch(() => []);
  const games = [];
  for (const name of names.filter(n => n.endsWith('.jsonl') || n.endsWith('.jsonl.gz'))) {
    const path = join(tracesDirectory, name);
    const bytes = await readFile(path).catch(() => null);
    if (!bytes) continue;
    const text = name.endsWith('.gz') ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
    const rows = text.split('\n').filter(Boolean)
      .flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const shapes = new Map(rows.filter(r => r.event === 'round').map(r => [r.round, r.shape?.name]));
    const ends = rows.filter(r => r.event === 'round-end');
    const finish = rows.find(r => r.event === 'finish');
    const firstTurn = rows.find(r => r.event === 'turn');
    if (!ends.length && !firstTurn) continue;
    const units = ends.reduce((sum, e) => sum + e.outcomes.length, 0);
    const matched = ends.reduce((sum, e) => sum + e.outcomes.filter(o => o[1] === 1).length, 0);
    games.push({
      name, rounds: ends.length, units, matched, finish: finish?.result ?? null,
      mode: (firstTurn?.plan?.mode) ?? (firstTurn && firstTurn.own.length > 24 ? 'arena' : 'clash'),
      updated: (await stat(path)).mtimeMs,
      shapes: ends.map(e => ({ shape: shapes.get(e.round),
        units: e.outcomes.length, matched: e.outcomes.filter(o => o[1] === 1).length })),
    });
  }
  return games.sort((a, b) => a.updated - b.updated);
}

async function render() {
  const games = await readTraces();
  const done = games.filter(g => g.finish);
  const live = games.filter(g => !g.finish && g.rounds >= 0);
  const wins = done.filter(g => g.finish.winner).length;
  const lines = [];

  let supervisor = 'not running';
  const pid = await readFile(lockFile, 'utf8').catch(() => null);
  if (pid) { try { process.kill(Number(pid), 0); supervisor = `running (pid ${pid})`; } catch { supervisor = 'stale lock'; } }
  const tail = (await readFile(logFile, 'utf8').catch(() => '')).trimEnd().split('\n').slice(-1)[0] ?? '';

  lines.push(`supervisor: ${supervisor}`);
  if (tail) lines.push(`last log  : ${tail.slice(0, 110)}`);
  lines.push('');

  for (const mode of ['arena', 'clash']) {
    const inMode = done.filter(g => g.mode === mode);
    if (!inMode.length) { lines.push(`${mode.padEnd(6)} no finished games yet`); continue; }
    const units = inMode.reduce((s, g) => s + g.units, 0);
    const matched = inMode.reduce((s, g) => s + g.matched, 0);
    const modeWins = inMode.filter(g => g.finish.winner).length;
    const energy = inMode.map(g => g.finish.totalEnergy).sort((a, b) => a - b);
    lines.push(`${mode.padEnd(6)} ${String(inMode.length).padStart(3)} games  ` +
      `${String(modeWins).padStart(3)} wins (${pct(modeWins, inMode.length)})  ` +
      `match ${pct(matched, units).padStart(6)}  ` +
      `median finish ${energy[Math.floor(energy.length / 2)]}e`);
  }
  lines.push('');
  lines.push(`total  ${done.length} finished, ${wins} wins (${pct(wins, done.length)}), ${live.length} in progress`);

  const byShape = new Map();
  for (const g of done) for (const r of g.shapes) {
    if (!r.shape) continue;
    const entry = byShape.get(r.shape) ?? { units: 0, matched: 0 };
    entry.units += r.units; entry.matched += r.matched;
    byShape.set(r.shape, entry);
  }
  const worst = [...byShape].map(([shape, v]) => ({ shape, rate: v.matched / v.units, units: v.units }))
    .filter(s => s.units >= 60).sort((a, b) => a.rate - b.rate).slice(0, 4);
  if (worst.length) {
    lines.push('');
    lines.push(`weakest shapes: ${worst.map(s => `${s.shape} ${(100 * s.rate).toFixed(1)}%`).join('   ')}`);
  }

  if (live.length) {
    lines.push('');
    for (const g of live.slice(-4)) {
      lines.push(`  in play: ${g.mode.padEnd(5)} round ${String(g.rounds).padStart(2)}/16  match ${pct(g.matched, g.units)}`);
    }
  }
  const recent = done.slice(-6).reverse();
  if (recent.length) {
    lines.push('');
    lines.push('recent finishes (newest first):');
    for (const g of recent) {
      lines.push(`  ${g.mode.padEnd(5)} ${String(g.rounds).padStart(2)}r  match ${pct(g.matched, g.units).padStart(6)}  ` +
        `rank ${g.finish.rank}  ${g.finish.totalEnergy}e/${g.finish.survivorCount}u${g.finish.winner ? '  WIN' : ''}`);
    }
  }
  return lines.join('\n');
}

if (once) {
  console.log(await render());
} else {
  const draw = async () => {
    process.stdout.write('\x1b[2J\x1b[H');
    console.log(new Date().toLocaleTimeString() + '  (Ctrl-C to stop)\n');
    console.log(await render());
  };
  await draw();
  const timer = setInterval(() => void draw(), every);
  process.on('SIGINT', () => { clearInterval(timer); process.stdout.write('\n'); process.exit(0); });
}
