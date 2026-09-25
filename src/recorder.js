'use strict';
// Wraps a strategy so every decision is written to a trace file. Spectator replays
// show the whole board but hide ownership; this supplies the owned half, and the
// two join on wall-clock time plus the competitor name reported by `finish`.
//
// Recording must never affect play: buffered in memory, flushed off the turn path,
// and every hook guarded so a logging fault cannot lose a game.

const { appendFile, mkdir } = require('node:fs/promises');
const { join } = require('node:path');

const TRACES = process.env.LACK_TRACES || 'traces';
const ENABLED = process.env.LACK_TRACE !== '0';

let runCounter = 0;

function withRecording(Strategy) {
  if (!ENABLED) return Strategy;

  return class RecordingPlayer extends Strategy {
    constructor(...args) {
      super(...args);
      this.__run = `${new Date().toISOString().replace(/[:.]/g, '-')}-${++runCounter}`;
      this.__file = join(TRACES, `${this.__run}.jsonl`);
      this.__buffer = [];
      this.__roundIndex = -1;
      this.__turnIndex = 0;
      this.__ready = mkdir(TRACES, { recursive: true }).catch(() => {});
      this.__write({ event: 'start', run: this.__run });
    }

    __write(entry) {
      try { this.__buffer.push(JSON.stringify({ at: Date.now(), ...entry })); } catch {}
    }

    __flush() {
      if (!this.__buffer.length) return;
      const payload = this.__buffer.join('\n') + '\n';
      this.__buffer = [];
      this.__ready = this.__ready
        .then(() => appendFile(this.__file, payload))
        .catch(() => {});
    }

    round(width, height, targetShape) {
      const result = super.round(width, height, targetShape);
      this.__roundIndex++;
      this.__turnIndex = 0;
      this.__write({ event: 'round', round: this.__roundIndex, width, height, shape: targetShape });
      this.__flush();
      return result;
    }

    async turn(state, remainingMs) {
      const started = performance.now();
      const commands = await super.turn(state, remainingMs);
      const elapsed = performance.now() - started;
      try {
        const own = state.ownUnits ?? [];
        this.__write({
          event: 'turn',
          round: this.__roundIndex,
          turn: this.__turnIndex++,
          remainingMs,
          decisionMs: Math.round(elapsed * 100) / 100,
          boardUnits: state.units?.length ?? 0,
          own: own.map(unit => [String(unit.handle), unit.x, unit.y, unit.energy]),
          commands: (commands ?? []).map(command => [String(command.handle), command.commandName, command.params?.[0]]),
          // The strategy may publish planner internals for offline diagnosis.
          plan: this.diagnostics ?? null,
        });
      } catch {}
      return commands;
    }

    roundEnd(outcomes) {
      this.__write({
        event: 'round-end',
        round: this.__roundIndex,
        outcomes: (outcomes ?? []).map(outcome =>
          [String(outcome.handle), outcome.won ? 1 : 0, outcome.energyBefore, outcome.energyAfter, outcome.eliminated ? 1 : 0]),
      });
      this.__flush();
      if (typeof super.roundEnd === 'function') return super.roundEnd(outcomes);
    }

    finish(result) {
      this.__write({ event: 'finish', result: result ?? null });
      this.__flush();
      if (typeof super.finish === 'function') return super.finish(result);
    }
  };
}

module.exports = { withRecording };
