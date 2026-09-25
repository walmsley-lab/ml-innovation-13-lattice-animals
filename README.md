# LatticeAnimals formation player

A coordinated player for the [CIMC LACK contest kit](https://github.com/cimcai/LACK). The contest kit supplies the client and game engine; this repository supplies the strategy. It requires Node.js 24 or newer and no npm dependencies.

## Run

```sh
git clone https://github.com/cimcai/LACK.git ../LACK
npm test
npm run install:kit -- ../LACK
cd ../LACK
node --test tests/*.test.js
node client.js YOUR_PLAYER_TOKEN wss://latticeanimals.com/ws
```

Register at [latticeanimals.com](https://latticeanimals.com) to obtain the client command and token. Keep the token private and out of commits. Re-run `npm run install:kit -- ../LACK` from this repository after editing its player or planner. The install command replaces `player.js` in the kit and copies `src/planner.js`; keep a backup if you edited the kit's starter.

The kit's reference configuration has 64 turns per round. If the organizer changes that, set `LACK_TURNS_PER_ROUND` in the client environment. The game server's configuration, not this default, controls the actual round. `remainingMs` is the per-turn deadline and cannot be used to infer round length.

## Strategy

- Preserve shapes already recognized by the game's row-major, nonoverlapping matcher.
- Enumerate translated target shapes. Assign distinct owned units to unoccupied required cells; other players' dots may supply the remaining cells.
- Prefer short, high-value formations. Route around occupied cells with a bounded breadth-first search and replan after every turn.
- Track blocked movement and apply a small game-level reliability estimate to plans that depend on anonymous foreign dots. No foreign ownership, energy, or persistent identity is assumed.

The player does not attack or defect yet. A deliberate late departure from a mixed shape is an experimental policy because it also costs our unit energy and can benefit a third competitor or damage a noncompetitive golem.

## Modes

Connecting opts into **both** Arena and Clash. The site's own client has no
request that selects one — its whole vocabulary is login/register/resume/logout,
watch/unwatch, player-token, and the three player messages — and declining a
`player-join` suspends the client rather than filtering it. So play cannot be
restricted to one mode; only evaluation and strategy can differ.

The strategy tells them apart from the roster it is handed, since the kit's
client does not pass the match configuration through: more than 24 units is
Arena, otherwise Clash. They differ in ways that matter. Clash puts up to eight
competitors on one board, so it is denser (84.8 units at round end against 50.8)
and its cells churn far more — a foreign cell with forty turns to go survives to
round end 28.8% of the time in Clash against 41.7% in Arena. `tools/fit-persistence.mjs`
fits the two separately, and the planner uses whichever applies.

Clash fitting rests on three games, so treat it as provisional. The site sends no
per-round `progress` for Clash, so per-competitor attribution is unavailable
there and only our own traces carry round outcomes.

```sh
npm run arena    # evaluate at Arena configuration: 2 competitors, 32 units
npm run clash    # evaluate at Clash configuration: 8 competitors, 16 units
npm run watch    # live results as history accumulates
```

## Playing continuously

Arena ranks on accumulated wins, so disconnected time is rank not earned. The
contest client does not reconnect — it logs the close code and exits — so it needs
a supervisor.

```sh
npm run token     # fetch the player token into .env, once
npm run play      # foreground; Ctrl-C to stop
```

It restarts the client, backing off from 2s to 120s when failures are immediate
and resetting once a connection has held for two minutes. Two close codes are
special: 4001 means another client took the account, so it waits longer rather
than fighting for it, and 4003 means the token was rotated, which cannot be
recovered by reconnecting, so it stops and says so. A lock file refuses to start
beside a live supervisor, because one connection controls an account and a
second would evict the first.

Every twenty minutes it archives finished games and compresses traces older than
six hours, so a long session stays analysable without filling the disk.

To keep it running across logouts and reboots:

```sh
cp tools/latticeanimals.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now latticeanimals
loginctl enable-linger $USER          # survive logout
journalctl --user -u latticeanimals -f
```

## Inspecting real games

Nothing in the contest kit keeps a record: `client.js` discards every frame it
receives. These tools close that gap, because strategy changes should answer to
measurements from real play rather than to intuition.

The website's own session socket exposes a spectator protocol. `watch` streams a
game as chunked JSON that reassembles into a full replay: every turn's unit
positions and blush, the engine's accepted matches, and per-round `totalEnergy`
and `survivorCount` for each competitor.

```sh
cp .env.example .env            # add your session token
npm run record -- --once        # archive every finished game the arena still lists
npm run record                  # or stay connected and archive as games end
npm run analyze -- --me YOUR_NAME
```

Authentication uses the **website session**, not the player token, and it is
read-only: the recorder watches and unwatches, and never joins a game. Arena
history is short, so a long-running recorder accumulates an archive that the site
itself does not keep.

Replays hide ownership, as the rules require. Two things recover it:

- **Energy deltas.** A unit loses exactly one energy when it is not part of a match
  at round end, so a competitor's energy drop *is* its unmatched count, and matched
  units follow from the survivor count. Summing the derived counts across
  competitors reproduces the matched cells on the board exactly, every round.
- **Local traces.** `src/recorder.js` wraps the strategy and writes each decision
  to `traces/` — owned positions, issued commands, planner internals and per-turn
  outcomes. Set `LACK_TRACE=0` to disable it.

`tools/analyze.mjs` reports, per competitor: the share of its surviving units
matched each round, how many of those needed foreign units to complete a shape
(the **solo ceiling** is `shapeSize × floor(units / shapeSize)`, and beating it means
other players' units filled the gaps), and units lost per round. Per round it also
reports the turn play stopped improving, cells stranded in connected components too
small to ever match, and the gap between what the engine's row-major scan collected
and the largest set of disjoint placements the board actually supported. Pass
`--games` for per-round tables and `--json` for the raw figures.

Archives are gzipped: fifty 16-round games are about 6 MB.

### Preserve a shareable snapshot

The live `runs/` and `traces/` directories are ignored by Git. Export a bounded
snapshot when you want results available for review in the repository:

```sh
node tools/preserve.mjs --label arena-2026-09-25
node tools/analyze.mjs --runs evidence/arena-2026-09-25/replays \
  --traces evidence/arena-2026-09-25/traces --me YOUR_NAME
git add evidence/arena-2026-09-25
```

The exporter accepts `--runs DIR` and `--traces DIR` if your recordings live
elsewhere. It compresses traces and replays, writes a manifest with SHA-256
checksums and counts, and rejects credential-like fields in replay data. It keeps
only the recorder's known trace fields. Review the snapshot before committing:
traces include your unit handles, positions, commands, and planner diagnostics;
replays include public competitor names and game history. Use a new label for
each snapshot. The manifest does not assert a precise trace-to-replay pairing;
the two streams have different IDs and can be aligned by their timestamps.

`evidence/local-2026-09-25/` is a small, checked-in benchmark sample, so these
commands can be tried without access to the arena session or the original raw
files. It is a local reproduction against kit bots, not an arena sample.

## Profiling opponents

```sh
node tools/opponents.mjs --me YOUR_NAME
```

Replays anonymise units, so each competitor's behaviour is recovered from three
sources in decreasing order of certainty: energy deltas give everyone's matched
count in every game; in games we played, subtracting our own traced units from
the board leaves the opponent's exactly; and blush is self-applied and persists,
so a competitor that reuses a colour has fingerprinted itself.

Blush is attributed only where one competitor was present every time a colour
appeared. Crediting a colour to both players in a game would attribute an
opponent's blush to us — we set none at all.

## Predicting arena results

```sh
BENCH_UNITS=32 BENCH_ROUNDS=16 node scripts/benchmark.mjs ../LACK 6 --vs hive --record
node tools/predict.mjs --subject plan
```

Rounds are not independent. A competitor that misses matches loses units, and a
smaller force matches worse next round, so a projection has to simulate that
spiral rather than multiply an average. The archive measures the curve: across the
field, match rate falls from 90.7% at 32 units to 61.1% at 4.

`tools/predict.mjs` fits the attrition rule against real games — replaying each
competitor's own observed per-round rates reproduces its declared finishing energy
to within about one energy — then runs the same model on locally measured rates.
It reports the projected finish, a head-to-head estimate against every competitor
in the archive, and how final energy responds to match rate. That last table is
the one worth reading: the payoff is sharply convex, so match rate at full strength
is the variable that decides everything else.

## Local evaluation

After installing into a kit checkout:

```sh
node tools/fetch-opponents.mjs                                 # cache the site's bots
node scripts/benchmark.mjs ../LACK 5 --vs greedy,hive --record
npm run analyze -- --me plan
```

`--vs` accepts `random`, `dummy`, `greedy`, `hive`, and `self`; several run at once
as separate competitors, and `--golem NAME` seats a noncompetitive one. Arena games
in the archive are 1v1 with 32 units and no golem, which is what `BENCH_UNITS=32
BENCH_ROUNDS=16` reproduces. `--record` writes replays in the same schema the arena
recorder archives, so one analysis path serves local and live games. Measuring
against `random` flatters any strategy and should not be trusted on its own.

The strategy entry point is `player.js`; the pure board planning functions live in
`src/planner.js`. The [contest rules](https://github.com/cimcai/LACK/blob/main/docs/rules.md) remain authoritative.
