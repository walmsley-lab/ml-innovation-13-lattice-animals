'use strict';
// Reassembles the site's chunked replay transfers. The server sends a snapshot as
// `total` ordered parts of one JSON document; later revisions splice new turns onto
// the previous log instead of resending it.

export class ReplayAssembler {
  #transfer = null;
  #revision = null;
  #snapshot = null;

  get snapshot() { return this.#snapshot; }

  reset() {
    this.#transfer = null;
    this.#revision = null;
    this.#snapshot = null;
  }

  /** Returns the completed snapshot when a transfer finishes, otherwise null. */
  accept(message) {
    if (message.type !== 'game-chunk') return null;
    if (message.baseRevision !== this.#revision || !Number.isSafeInteger(message.revision) ||
      message.revision <= (this.#revision ?? -1) || !Number.isSafeInteger(message.total) ||
      message.total < 1 || message.total > 8192 || typeof message.data !== 'string') {
      throw new Error(`Out-of-order replay revision for ${message.gameId}.`);
    }
    if (message.index === 0) this.#transfer = { revision: message.revision, total: message.total, parts: [] };
    const transfer = this.#transfer;
    if (!transfer || transfer.revision !== message.revision || transfer.total !== message.total ||
      message.index !== transfer.parts.length) {
      throw new Error(`Incomplete replay update for ${message.gameId}.`);
    }
    transfer.parts.push(message.data);
    if (transfer.parts.length !== transfer.total) return null;

    const next = JSON.parse(transfer.parts.join(''));
    if (next.gameId !== message.gameId || next.revision !== message.revision) {
      throw new Error(`Mismatched replay for ${message.gameId}.`);
    }
    const current = this.#snapshot;
    if (next.log) {
      if (next.from === 0 && !current?.log) {
        // First frame-bearing snapshot establishes the log.
      } else {
        if (!current?.log || next.from < 0 || next.from > current.log.turns.length) {
          throw new Error(`Missing replay frames for ${message.gameId}.`);
        }
        const turns = current.log.turns;
        turns.splice(next.from, turns.length - next.from, ...next.log.turns);
        Object.assign(current.log, next.log, { turns });
        next.log = current.log;
      }
    } else if (current?.log) {
      next.log = current.log;
    }
    this.#revision = next.revision;
    this.#transfer = null;
    this.#snapshot = next;
    return next;
  }
}

/** Merge the incremental `progress` samples the arena broadcast sends per game. */
export function mergeProgress(previous = [], { progressFrom = 0, progress = [] } = {}) {
  const retained = progressFrom === 0 ? [] : previous;
  const lastRound = retained.at(-1)?.round ?? -1;
  const appended = progress.filter(sample => sample.round > lastRound);
  return appended.length ? [...retained, ...appended] : retained;
}
