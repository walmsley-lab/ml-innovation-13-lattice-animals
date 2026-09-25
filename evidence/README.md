# Preserved game evidence

Each named directory contains compressed `.jsonl.gz` player traces, `.json.gz`
public game replays, and a manifest of counts and SHA-256 hashes. The traces
record owned units and decisions; the spectator replay records all visible board
positions and match results. See the export and analysis commands in the root
README.

## local-2026-09-25

Twelve local benchmark games run on 2026-09-25 against the LACK kit's `hive`
and `greedy` bots: six seeds per opponent, 32 starting units, up to 16 rounds,
64 turns per round. These files were produced by a local reproduction, not by
the user's arena session. The older benchmark recorder did not write a `finish`
event, so these traces have completed `round-end` events but `complete: false`
in the manifest. The benchmark now calls the player's `finish` hook.

To inspect this sample:

```sh
node tools/analyze.mjs --runs evidence/local-2026-09-25/replays \
  --traces evidence/local-2026-09-25/traces --me plan
```

The 12 games yield 183 completed rounds. The player's aggregate match rate is
84.2%, versus 59.7% for `hive` and 42.6% for `greedy` in their respective games.
These are bot benchmarks; they are not evidence of performance against arena
players. Trace and replay filenames do not encode a reliable pair relationship.
