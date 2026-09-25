'use strict';
// Per-round, per-competitor outcomes recovered from a replay.
//
// Ownership is hidden, but energy is not: a unit loses exactly one energy when it
// is not part of a match at round end, so a competitor's energy drop is its
// unmatched count. The progress samples carry no stated alignment — the arena
// sends one more sample than there are rounds, with sample `r` describing the
// state *before* round r, while a locally generated archive records the state
// after. Guessing wrong shifts every attribution by a round, so the alignment is
// verified against the board: the derived counts must sum to the cells the engine
// actually matched.

/** Walk the samples at a given offset and score them against the board. */
function attribute(log, players, progress, offset) {
  const startingEnergy = log.config?.startingEnergy ?? 2;
  const state = new Map(players.map(player => [player.userName, {
    energy: (player.initialCount ?? 0) * startingEnergy,
    survivors: player.initialCount ?? 0,
    golem: Boolean(player.golem),
  }]));
  const rounds = [];
  let agreed = 0;
  let checked = 0;
  for (const round of log.rounds.filter(entry => entry.completed)) {
    const sample = progress.find(entry => entry.round === round.index + offset);
    if (!sample) continue;
    const frame = log.turns[round.endTurn];
    const recorded = frame?.targetShape ?? round.targetShape;
    const shapeSize = recorded?.cells?.length ?? null;
    const entries = [];
    let derived = 0;
    for (const [name, start] of state) {
      const totals = sample.players?.find(entry => entry.userName === name);
      if (!totals) continue;
      const unmatched = start.energy - totals.totalEnergy;
      const matched = start.survivors - unmatched;
      derived += matched;
      const solo = shapeSize ? shapeSize * Math.floor(start.survivors / shapeSize) : null;
      entries.push({ name, golem: start.golem, round: round.index, shapeSize,
        survivorsBefore: start.survivors, survivorsAfter: totals.survivorCount,
        matched, unmatched, eliminated: start.survivors - totals.survivorCount,
        solo, assisted: solo === null ? null : Math.max(0, matched - solo),
        matchRate: start.survivors ? matched / start.survivors : null });
      state.set(name, { energy: totals.totalEnergy, survivors: totals.survivorCount, golem: start.golem });
    }
    if (frame?.matches) {
      checked++;
      if (derived === frame.matches.flat().length) agreed++;
    }
    rounds.push({ round: round.index, shape: recorded?.name ?? null, shapeSize,
      startTurn: round.startTurn, endTurn: round.endTurn,
      eliminated: round.eliminatedCount ?? null, players: entries });
  }
  return { rounds, agreed, checked };
}

/** Outcomes under whichever alignment the board confirms. */
export function roundOutcomes(record) {
  const log = record.replay?.log;
  const players = record.summary?.players ?? [];
  const progress = record.summary?.progress ?? [];
  if (!log?.rounds?.length || !players.length) return { rounds: [], offset: null, verified: false };
  const candidates = [1, 0].map(offset => ({ offset, ...attribute(log, players, progress, offset) }));
  const best = candidates.reduce((winner, candidate) =>
    candidate.agreed > winner.agreed ? candidate : winner);
  return { rounds: best.rounds, offset: best.offset,
    verified: best.checked > 0 && best.agreed === best.checked, agreed: best.agreed, checked: best.checked };
}

/** Flattened per-competitor rows, for rate curves and aggregates. */
export function competitorRows(record) {
  return roundOutcomes(record).rounds.flatMap(round =>
    round.players.map(entry => ({ ...entry, game: record.gameId, shape: round.shape })));
}
