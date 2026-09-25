// Fetches the account's player token over the authenticated session socket and
// stores it in .env. The token controls your units, so it is never printed.
//
//   node --env-file-if-exists=.env tools/player-token.mjs [--rotate]
import { readFile, writeFile } from 'node:fs/promises';
import { connect, authenticate, credentialsFromEnvironment, DEFAULT_ENDPOINT } from './protocol.mjs';

const rotate = process.argv.includes('--rotate');
const session = await connect(DEFAULT_ENDPOINT);
let user;
try {
  ({ user } = await authenticate(session, credentialsFromEnvironment()));
} catch (error) {
  session.close();
  console.error(`Cannot authenticate: ${error.message}`);
  process.exit(1);
}

// Rotation permanently detaches control of units in running games.
const { token } = await session.request(rotate ? 'player-token-rotate' : 'player-token');
session.close();
if (typeof token !== 'string' || !token) {
  console.error('The server returned no player token.');
  process.exit(1);
}

const existing = await readFile('.env', 'utf8').catch(() => '');
const line = `LATTICE_PLAYER_TOKEN=${token}`;
const updated = /^LATTICE_PLAYER_TOKEN=.*$/m.test(existing)
  ? existing.replace(/^LATTICE_PLAYER_TOKEN=.*$/m, line)
  : `${existing.replace(/\n*$/, '\n')}${line}\n`;
await writeFile('.env', updated, { mode: 0o600 });
console.log(`Stored player token for ${user?.userName} in .env (${token.length} characters, ends ...${token.slice(-4)}).`);
