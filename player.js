'use strict';

// Copy this file and src/planner.js into the official LACK contestant kit.
const Player = require('./game/Player');
const { planTurn, keyOf } = require('./src/planner');
const { withRecording } = require('./src/recorder');

const TURN_HORIZON = Number.parseInt(process.env.LACK_TURNS_PER_ROUND || '64', 10);

class FormationPlayer extends Player {
  constructor() {
    super();
    this.reliability = { success: 4, failure: 1 };
    this.previousTargets = new Map();
    this.blockedMoves = new Map();
    this.expectedMoves = new Map();
    this.lastMixedPrediction = [];
    this.turnIndex = 0;
  }

  round(width, height, targetShape) {
    super.round(width, height, targetShape);
    this.turnIndex = 0;
    this.previousTargets = new Map();
    this.blockedMoves = new Map();
    this.expectedMoves = new Map();
    this.lastMixedPrediction = [];
  }

  async turn(state, remainingMs) {
    this.turnIndex++;
    // The deadline includes network transit. Do not start expensive work when late.
    if (remainingMs < 35) return [];
    const own = new Map(state.ownUnits.map(unit => [String(unit.handle), unit]));
    for (const [handle, destination] of this.expectedMoves) {
      const unit = own.get(handle);
      if (unit && keyOf(unit.x, unit.y, this.width) !== destination) {
        const failures = this.blockedMoves.get(handle) || new Map();
        failures.set(destination, Math.min(3, (failures.get(destination) || 0) + 1));
        this.blockedMoves.set(handle, failures);
      }
    }

    const decision = planTurn({
      state, width: this.width, height: this.height, shape: this.targetShape,
      turnsLeft: Math.max(1, TURN_HORIZON - this.turnIndex + 1),
      reliability: Math.max(0.55, Math.min(0.95,
        this.reliability.success / (this.reliability.success + this.reliability.failure))),
      previous: this.previousTargets, blockedMoves: this.blockedMoves,
    });
    // Published for the trace recorder; offline analysis needs the plan, not just
    // the commands, to tell a bad decision apart from a blocked one.
    this.diagnostics = {
      formations: decision.selected.length,
      complete: decision.selected.filter(plan => plan.complete).length,
      mixed: decision.selected.filter(plan => plan.foreign > 0).length,
      assigned: decision.selected.reduce((sum, plan) => sum + plan.assignments.length, 0),
      unassigned: decision.unassigned.length,
      moving: decision.commands.length,
      blocked: [...this.blockedMoves.values()].reduce((sum, failures) => sum + failures.size, 0),
    };
    this.previousTargets = decision.nextTargets;
    this.expectedMoves = decision.expected;
    // Only use the latest prediction. An earlier snapshot is not the final board.
    this.lastMixedPrediction = decision.protectedMixed.filter(handle =>
      !decision.expected.has(handle));
    return decision.commands;
  }

  roundEnd(outcomes) {
    const byHandle = new Map(outcomes.map(outcome => [String(outcome.handle), outcome]));
    for (const handle of new Set(this.lastMixedPrediction)) {
      const outcome = byHandle.get(handle);
      if (!outcome) continue;
      if (outcome.won) this.reliability.success += 0.25;
      else this.reliability.failure += 0.25;
    }
    // Keep the prior influential over long games, without unbounded growth.
    if (this.reliability.success + this.reliability.failure > 30) {
      this.reliability.success *= 0.75;
      this.reliability.failure *= 0.75;
    }
  }
}

module.exports = withRecording(FormationPlayer);
