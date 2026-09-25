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

`tools/analyze.mjs` reports, per round and per competitor: units matched against
the **reachable ceiling** (`shapeSize × floor(units / shapeSize)`), the turn a round
stopped improving, cells stranded in connected components too small to ever match,
and the gap between what the engine's row-major scan collected and the largest set
of disjoint placements the final board actually supported.

## Local evaluation

After installing into a kit checkout:

```sh
node tools/fetch-opponents.mjs                                 # cache the site's bots
node scripts/benchmark.mjs ../LACK 5 --vs greedy,hive --record
npm run analyze -- --me plan
```

`--vs` accepts `random`, `dummy`, `greedy`, `hive`, and `self`; several run at once
as separate competitors. `--record` writes replays in the same schema the arena
recorder archives, so one analysis path serves local and live games. Measuring
against `random` flatters any strategy and should not be trusted on its own.

The strategy entry point is `player.js`; the pure board planning functions live in
`src/planner.js`. The [contest rules](https://github.com/cimcai/LACK/blob/main/docs/rules.md) remain authoritative.
