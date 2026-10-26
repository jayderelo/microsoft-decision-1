import { performance } from 'node:perf_hooks';
import { Tetris, enumeratePlacements, reachablePlacement, placementKey, place, shapeFor, WIDTH } from './tetris.js';
import { choosePlacement } from './decision.js';

function sameBoard(a, b) {
  return a === b || a.every((row, y) => row.every((cell, x) => cell === b[y][x]));
}

export class GameSession {
  constructor(config, send, decide = choosePlacement, clock = performance.now.bind(performance)) {
    Object.assign(this, { config, send, decide, clock });
    this.game = new Tetris();
    this.mode = config.configured ? 'model' : 'demo';
    this.status = 'ready';
    this.speed = 1;
    this.epoch = 0;
    this.job = 0;
    this.sequence = 0;
    this.historyVersion = 0;
    this.requestedPieceId = null;
    this.plan = null;
    this.prepared = null;
    this.pending = false;
    this.pendingContext = null;
    this.controller = null;
    this.history = [];
    this.latencies = [];
    this.percentiles = { p50: null, p95: null };
    this.modelDecisions = 0;
    this.modelPlacements = 0;
    this.safetyMoves = 0;
    this.modelResponses = [];
    this.lastHistorySent = '';
    this.lastResponsesSent = '';
    this.elapsed = 0;
    this.lastTick = this.clock();
    this.lastAction = this.lastTick;
    this.lastGravity = this.lastTick;
    this.error = null;
    this.closed = false;
  }

  invalidate() {
    this.epoch++;
    this.job++;
    this.controller?.abort();
    this.controller = null;
    this.pending = false;
    this.pendingContext = null;
    if (this.plan) this.markOutcome(this.plan.decisionId, 'cancelled');
    if (this.prepared) this.markOutcome(this.prepared.decisionId, 'cancelled');
    this.plan = null;
    this.prepared = null;
    this.requestedPieceId = null;
  }

  abandonAhead() {
    if (this.prepared) this.markOutcome(this.prepared.decisionId, 'unreachable');
    this.prepared = null;
    if (this.pendingContext?.pieceId > this.game.pieceId) {
      this.job++;
      this.controller?.abort();
      this.controller = null;
      this.pendingContext = null;
      this.pending = false;
    }
    if (this.requestedPieceId > this.game.pieceId) this.requestedPieceId = null;
  }

  gravityInterval() {
    return (this.mode === 'manual' ? Math.max(100, 800 - (this.game.level - 1) * 65) : 125) / this.speed;
  }

  markOutcome(id, outcome) {
    const decision = this.history.find((item) => item.id === id);
    if (decision && decision.outcome !== outcome) {
      if (outcome === 'placed' && decision.source === 'model') this.modelPlacements++;
      decision.outcome = outcome;
      this.historyVersion++;
    }
  }

  context(ahead = false) {
    const started = performance.now();
    let board = this.game.board;
    let active = { ...this.game.active };
    let next = [...this.game.next];
    let pieceId = this.game.pieceId;
    let parentTarget = null;
    if (ahead) {
      if (!this.plan || !['model', 'forced'].includes(this.plan.source)) return null;
      parentTarget = placementKey(this.plan.target);
      board = place(board, this.plan.target).board;
      const type = next.shift();
      active = { type, rotation: 0, x: Math.floor((WIDTH - shapeFor(type)[0].length) / 2), y: 0 };
      pieceId++;
    }
    const all = enumeratePlacements(board, active);
    return {
      pieceId, parentTarget, input: { board, active, next },
      candidates: all.slice(0, 8), legalMoves: all.length,
      localMs: performance.now() - started,
    };
  }

  adopt(context, selected, source, decisionId, route) {
    this.plan = {
      pieceId: context.pieceId, path: [...route.path], target: route.target,
      source, decisionId, context, selected,
    };
    this.lastAction = this.clock() - 35 / this.speed;
  }

  ensureDecision() {
    if (this.status !== 'running' || this.mode === 'manual') return;
    if (this.prepared?.context.pieceId === this.game.pieceId) {
      const { context, selected, source, decisionId } = this.prepared;
      this.prepared = null;
      const route = sameBoard(context.input.board, this.game.board)
        ? reachablePlacement(this.game.board, this.game.active, selected.target) : null;
      if (route) {
        this.adopt(context, selected, source, decisionId, route);
        this.markOutcome(decisionId, 'planned');
      } else {
        this.markOutcome(decisionId, 'unreachable');
        this.requestedPieceId = null;
      }
    }
    let context;
    if (!this.plan && (this.mode === 'demo' || this.config.safety !== false)) {
      context = this.context();
      const selected = context.candidates[0];
      if (selected) {
        const source = this.mode === 'demo' ? 'demo' : 'fallback';
        this.adopt(context, selected, source, null, selected);
      }
    }
    if (this.pending || this.mode === 'demo') return;
    if (this.plan && ['model', 'forced'].includes(this.plan.source)) {
      if (this.config.lookahead !== false && !this.prepared && this.requestedPieceId !== this.game.pieceId + 1) {
        const ahead = this.context(true);
        if (ahead?.candidates.length) void this.requestDecision(ahead);
      }
    } else if (this.requestedPieceId !== this.game.pieceId) {
      void this.requestDecision(context || this.context());
    }
  }

  command(message) {
    if (this.closed) return;
    const now = this.clock();
    switch (message.type) {
      case 'start':
        if (this.status === 'running') return;
        if (this.status === 'gameover') this.reset();
        this.status = 'running';
        this.error = null;
        this.lastTick = now;
        this.lastAction = now;
        this.lastGravity = now;
        break;
      case 'pause':
        if (this.status === 'running') { this.status = 'paused'; this.invalidate(); }
        break;
      case 'reset': this.reset(); break;
      case 'mode':
        if (!['model', 'demo', 'manual'].includes(message.mode)) return;
        if (message.mode === 'model' && !this.config.configured) {
          this.send({ type: 'notice', message: 'Add your Foundry endpoint and API key to .env, then restart the server.' });
          return;
        }
        this.invalidate();
        this.mode = message.mode;
        this.error = null;
        break;
      case 'speed': {
        if (![0.5, 1, 2, 4].includes(message.speed)) return;
        const progress = Math.min(1, Math.max(0, (now - this.lastGravity) / this.gravityInterval()));
        this.speed = message.speed;
        this.lastGravity = now - progress * this.gravityInterval();
        break;
      }
      case 'input':
        if (this.mode !== 'manual' || this.status !== 'running') return;
        if (message.action === 'drop') { this.game.hardDrop(); this.lastGravity = now; }
        else if (message.action === 'down') { this.game.softDrop(); this.lastGravity = now; }
        else this.game.move(message.action);
        break;
      default: return;
    }
    this.updateGameOver();
    this.publish();
  }

  reset() {
    this.invalidate();
    this.game = new Tetris();
    this.status = 'ready';
    this.history = [];
    this.latencies = [];
    this.percentiles = { p50: null, p95: null };
    this.modelDecisions = 0;
    this.modelPlacements = 0;
    this.safetyMoves = 0;
    this.modelResponses = [];
    this.sequence = 0;
    this.historyVersion++;
    this.elapsed = 0;
    this.error = null;
    this.lastTick = this.clock();
    this.lastGravity = this.lastTick;
    this.lastAction = this.lastTick;
  }

  updateGameOver() {
    if (this.game.over) { this.status = 'gameover'; this.invalidate(); }
  }

  record(context, selected, decision, source, outcome) {
    const id = ++this.sequence;
    this.history.unshift({
      id, piece: context.input.active.type, outcome, source, choice: selected.id,
      latencyMs: decision.latencyMs,
      probability: decision.probabilities?.[selected.id] ?? null,
      candidates: context.candidates.map(({ id, target, metrics }) => ({
        id, column: target.x + 1, rotation: target.rotation * 90, metrics,
        probability: decision.probabilities?.[id] ?? null,
      })),
      legalMoves: context.legalMoves, model: decision.model || null,
    });
    this.history.length = Math.min(this.history.length, 20);
    this.historyVersion++;
    if (source === 'fallback') this.safetyMoves++;
    if (source === 'model') {
      this.modelDecisions++;
      this.latencies.push(decision.latencyMs);
      if (this.latencies.length > 500) this.latencies.shift();
      // Percentiles change only after a response, not on every 50 ms broadcast.
      const sorted = [...this.latencies].sort((a, b) => a - b);
      this.percentiles = {
        p50: sorted[Math.ceil(sorted.length * .5) - 1],
        p95: sorted[Math.ceil(sorted.length * .95) - 1],
      };
      this.modelResponses.unshift({
        id, piece: context.input.active.type, latencyMs: decision.latencyMs,
        receivedAt: new Date().toISOString(), payload: decision.response ?? null,
      });
      this.modelResponses.length = Math.min(this.modelResponses.length, 10);
    }
    return id;
  }

  async requestDecision(context = this.context()) {
    if (this.closed || this.pending || this.status !== 'running' || this.mode === 'manual' || !context?.candidates.length) return;
    this.pending = true;
    this.pendingContext = context;
    const epoch = this.epoch;
    const job = ++this.job;
    const mode = this.mode;
    this.requestedPieceId = context.pieceId;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const source = context.candidates.length === 1 ? 'forced' : mode;
      const decision = source === 'model'
        ? await this.decide(context.input, context.candidates, this.config, controller.signal)
        : { choice: context.candidates[0].id, probabilities: {}, latencyMs: context.localMs };
      if (this.closed || this.epoch !== epoch || this.job !== job || this.status !== 'running') return;
      const selected = context.candidates.find(({ id }) => id === decision.choice);
      if (!selected) throw new Error('The decision selected an unavailable move.');
      const current = context.pieceId === this.game.pieceId;
      const route = current && sameBoard(context.input.board, this.game.board)
        ? reachablePlacement(this.game.board, this.game.active, selected.target) : null;
      const ahead = context.pieceId === this.game.pieceId + 1 && this.plan
        && context.parentTarget === placementKey(this.plan.target);
      const outcome = route ? 'planned' : ahead ? 'prepared' : current ? 'unreachable' : 'late';
      const id = this.record(context, selected, decision, source, outcome);
      if (route) this.adopt(context, selected, source, id, route);
      else if (ahead) this.prepared = { context, selected, source, decisionId: id };
    } catch (error) {
      if (this.closed || this.epoch !== epoch || this.job !== job || controller.signal.aborted) return;
      this.error = error.message;
      this.status = 'paused';
      this.plan = null;
    } finally {
      if (this.epoch === epoch && this.job === job && !this.closed) {
        this.pending = false;
        this.pendingContext = null;
        this.controller = null;
        // Start the next request before serializing UI diagnostics.
        if (this.config.lookahead !== false && this.plan && ['model', 'forced'].includes(this.plan.source)) this.ensureDecision();
        this.publish();
      }
    }
  }

  tick(now = this.clock()) {
    if (this.closed) return;
    const delta = Math.min(1000, Math.max(0, now - this.lastTick));
    this.lastTick = now;
    if (this.status !== 'running') return;
    this.elapsed += delta;
    this.ensureDecision();
    this.lastGravity = Math.max(this.lastGravity, now - 1000);
    this.lastAction = Math.max(this.lastAction, now - 1000);
    for (let steps = 0; steps < 64 && this.status === 'running'; steps++) {
      const nextGravity = this.lastGravity + this.gravityInterval();
      const nextSteer = this.mode !== 'manual' && this.plan?.path.length ? this.lastAction + 35 / this.speed : Infinity;
      if (Math.min(nextGravity, nextSteer) > now) break;
      if (nextSteer <= nextGravity) {
        if (!this.game.move(this.plan.path.shift())) {
          const route = reachablePlacement(this.game.board, this.game.active, this.plan.target);
          if (route) this.plan.path = [...route.path];
          else {
            this.markOutcome(this.plan.decisionId, 'unreachable');
            this.abandonAhead();
            this.plan = null;
            this.ensureDecision();
          }
        }
        this.lastAction = nextSteer;
      } else {
        const pieceId = this.game.pieceId;
        const finalPose = this.game.active;
        this.game.softDrop();
        this.lastGravity = nextGravity;
        if (this.game.pieceId !== pieceId) {
          if (this.plan) {
            const outcome = placementKey(finalPose) === placementKey(this.plan.target) ? 'placed' : 'unreachable';
            if (this.plan.decisionId) this.markOutcome(this.plan.decisionId, outcome);
            else if (this.plan.context) this.record(this.plan.context, this.plan.selected, { latencyMs: this.plan.context.localMs }, this.plan.source, outcome);
            if (outcome !== 'placed') this.abandonAhead();
          }
          this.plan = null;
          this.lastAction = nextGravity;
          this.updateGameOver();
          this.ensureDecision();
        }
      }
    }
    this.updateGameOver();
  }

  snapshot() {
    return {
      type: 'state', game: this.game.snapshot(), mode: this.mode, status: this.status,
      speed: this.speed, thinking: this.pending,
      motion: {
        gravityIntervalMs: this.gravityInterval(),
        gravityElapsedMs: Math.min(this.gravityInterval(), Math.max(0, this.lastTick - this.lastGravity)),
      },
      historyVersion: this.historyVersion, target: this.plan?.target || null,
      configured: this.config.configured, deployment: this.config.deployment,
      error: this.error, history: this.history, modelResponses: this.modelResponses,
      stats: {
        decisions: this.sequence, modelDecisions: this.modelDecisions, modelPlacements: this.modelPlacements, safetyMoves: this.safetyMoves,
        lastLatency: this.latencies.at(-1) ?? null, ...this.percentiles,
        elapsedMs: Math.round(this.elapsed),
      },
    };
  }

  publish() {
    if (this.closed) return;
    const snapshot = this.snapshot();
    const historyKey = `${this.epoch}:${this.historyVersion}`;
    if (this.lastHistorySent === historyKey) delete snapshot.history;
    this.lastHistorySent = historyKey;
    const responsesKey = `${this.epoch}:${this.modelDecisions}`;
    if (this.lastResponsesSent === responsesKey) delete snapshot.modelResponses;
    this.lastResponsesSent = responsesKey;
    this.send(snapshot);
  }

  close() { this.closed = true; this.invalidate(); }
}
