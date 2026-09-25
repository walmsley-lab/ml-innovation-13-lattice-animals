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

## Local evaluation

After installing into a kit checkout:

```sh
node scripts/benchmark.mjs ../LACK 5
```

The benchmark plays against a random-moving competitor using the official reference engine. It prints surviving energy, survivors, wins, and the slowest local decision. Increase the game count after the first smoke run. This harness does not model server latency or strategic opponents.

The strategy entry point is `player.js`; the pure board planning functions live in `src/planner.js`. The [contest rules](https://github.com/cimcai/LACK/blob/main/docs/rules.md) remain authoritative.
