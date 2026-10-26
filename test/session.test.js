import test from 'node:test';
import assert from 'node:assert/strict';
import { GameSession } from '../src/session.js';
import { Tetris } from '../src/tetris.js';

const offline = { configured: false, deployment: 'microsoft-decision-1' };
// Disable optional policies in lifecycle tests; their interactions are tested below.
const online = { configured: true, deployment: 'custom-deployment', lookahead: false, safety: false };
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

test('demo runs without API calls and model telemetry stays empty', () => {
  const session = new GameSession(offline, () => {}, () => { throw new Error('Demo must not call Azure'); });
  session.command({ type: 'start' });
  let time = session.lastTick;
  for (let i = 0; i < 1800; i++) session.tick(time += 100);
  assert.ok(session.game.pieces > 40);
  assert.ok(session.sequence > 40);
  const stats = session.snapshot().stats;
  assert.equal(stats.modelDecisions, 0);
  assert.equal(stats.lastLatency, null);
  assert.equal(stats.p50, null);
  assert.ok(session.history.every((decision) => ['demo', 'forced'].includes(decision.source)));
});

for (const action of ['pause', 'reset', 'mode', 'close']) {
  test(`${action} invalidates a late model response`, async () => {
    const response = deferred();
    let signal;
    let candidates;
    const session = new GameSession(online, () => {}, async (_, options, config, requestSignal) => {
      signal = requestSignal;
      candidates = options;
      return response.promise;
    });
    session.command({ type: 'start' });
    const pending = session.requestDecision();
    assert.equal(session.pending, true);
    if (action === 'close') session.close();
    else session.command({ type: action, mode: 'manual' });
    assert.equal(signal.aborted, true);
    response.resolve({ choice: candidates[0].id, probabilities: {}, latencyMs: 123 });
    await pending;
    assert.equal(session.sequence, 0);
    assert.equal(session.plan, null);
    assert.equal(session.pending, false);
    assert.equal(session.history.length, 0);
    assert.equal(session.modelResponses.length, 0);
  });
}

test('API failure pauses live mode and retry uses a new request', async () => {
  let calls = 0;
  const session = new GameSession(online, () => {}, async (_, candidates) => {
    if (++calls === 1) throw new Error('Foundry HTTP 429. Rate limit reached.');
    return { choice: candidates[1].id, probabilities: { [candidates[1].id]: 0.8 }, latencyMs: 86 };
  });
  session.command({ type: 'start' });
  await session.requestDecision();
  assert.equal(session.status, 'paused');
  assert.equal(session.mode, 'model');
  assert.match(session.error, /429/);
  assert.equal(session.modelDecisions, 0);
  session.command({ type: 'start' });
  await session.requestDecision();
  assert.equal(session.status, 'running');
  assert.equal(session.error, null);
  assert.equal(session.history[0].choice, 'move_2');
  assert.equal(session.history[0].probability, 0.8);
  assert.equal(session.snapshot().stats.p50, 86);
  assert.equal(session.snapshot().stats.modelDecisions, 1);
});

test('manual mode never calls the model and pause freezes the simulation', () => {
  const session = new GameSession(online, () => {}, () => { throw new Error('Manual must not call Azure'); });
  session.command({ type: 'mode', mode: 'manual' });
  session.command({ type: 'start' });
  session.command({ type: 'input', action: 'drop' });
  assert.equal(session.game.pieces, 1);
  session.command({ type: 'pause' });
  const before = structuredClone(session.game.snapshot());
  session.tick(session.lastTick + 10000);
  session.command({ type: 'input', action: 'drop' });
  assert.deepEqual(session.game.snapshot(), before);
});

test('4x playback executes more steps than 2x between WebSocket ticks', () => {
  const advance = (speed) => {
    const session = new GameSession(offline, () => {}, undefined, () => 0);
    session.status = 'running';
    session.speed = speed;
    session.lastAction = 0;
    session.lastTick = 0;
    session.lastGravity = 0;
    session.requestedPieceId = session.game.pieceId;
    session.plan = { pieceId: session.game.pieceId, path: [] };
    session.tick(125);
    return session.game.active.y;
  };
  assert.equal(advance(1), 1);
  assert.equal(advance(2), 2);
  assert.equal(advance(4), 4);
});

test('a sole legal placement is labeled forced and never sent to the API', async () => {
  const session = new GameSession(online, () => {}, () => { throw new Error('One option is not a model choice'); });
  session.game.active = { type: 'O', rotation: 0, x: 4, y: 0 };
  for (let y = 0; y < 20; y++) session.game.board[y] = Array.from({ length: 10 }, (_, x) => x === 4 || x === 5 ? null : 'L');
  session.command({ type: 'start' });
  await session.requestDecision();
  assert.equal(session.history[0].source, 'forced');
  assert.equal(session.modelDecisions, 0);
  assert.ok(session.plan);
  assert.deepEqual(session.modelResponses, []);
});

test('model responses retain matching timing and payloads, survive mode changes, and clear on reset', async () => {
  let calls = 0;
  const frames = [];
  const session = new GameSession(online, (frame) => frames.push(frame), async (_, candidates) => {
    calls++;
    return {
      choice: candidates[0].id, probabilities: {}, latencyMs: 100 + calls,
      response: { model: 'microsoft-decision-1', response_id: calls, answers: { placement: { type: 'choice', choice: candidates[0].id } } },
    };
  });
  session.command({ type: 'start' });
  for (let i = 0; i < 12; i++) await session.requestDecision();
  const responses = session.snapshot().modelResponses;
  assert.equal(responses.length, 10);
  assert.equal(responses[0].id, 12);
  assert.equal(responses[0].payload.response_id, 12);
  assert.equal(responses[0].latencyMs, 112);
  assert.equal(responses.at(-1).id, 3);
  assert.ok(Number.isFinite(Date.parse(responses[0].receivedAt)));
  assert.equal(frames.at(-1).modelResponses[0].payload.response_id, 12);
  session.publish();
  assert.equal(Object.hasOwn(frames.at(-1), 'modelResponses'), false, 'unchanged bodies are not sent on every tick');
  session.command({ type: 'mode', mode: 'demo' });
  await session.requestDecision();
  assert.deepEqual(session.modelResponses, responses);
  assert.equal(calls, 12);
  session.command({ type: 'reset' });
  assert.deepEqual(session.modelResponses, []);
  assert.deepEqual(frames.at(-1).modelResponses, []);
});

test('gravity advances during a slow model request and its response does not reset the fall clock', async () => {
  let now = 0;
  let offered;
  let captured;
  let calls = 0;
  const response = deferred();
  const session = new GameSession(online, () => {}, async (input, candidates) => {
    calls++;
    captured = input;
    offered = candidates;
    return response.promise;
  }, () => now);
  session.game.active = { type: 'O', rotation: 0, x: 4, y: 0 };
  session.command({ type: 'start' });
  const pending = session.requestDecision();
  for (now = 25; now <= 500; now += 25) session.tick(now);
  now = 500;
  assert.equal(session.game.active.y, 4);
  assert.equal(session.pending, true);
  assert.equal(calls, 1);
  assert.equal(captured.active.y, 0, 'the request retains its original piece snapshot');
  const gravityBefore = session.lastGravity;
  response.resolve({ choice: offered[0].id, probabilities: {}, latencyMs: 500 });
  await pending;
  assert.equal(session.lastGravity, gravityBefore);
  assert.equal(session.history[0].outcome, 'planned');
  assert.ok(session.plan);
  now = 625;
  session.tick(now);
  assert.equal(session.game.active.y, 5);
  assert.equal(session.status, 'running');
});

test('a new piece falls while an older request is pending, and its late result is recorded without steering', async () => {
  let now = 0;
  let offered;
  let captured;
  let calls = 0;
  const response = deferred();
  const session = new GameSession(online, () => {}, async (input, candidates) => {
    calls++;
    captured = input;
    offered = candidates;
    return response.promise;
  }, () => now);
  session.game.active = { type: 'O', rotation: 0, x: 4, y: 0 };
  session.command({ type: 'start' });
  const pending = session.requestDecision();
  for (now = 25; now <= 2700; now += 25) session.tick(now);
  now = 2700;
  assert.equal(session.game.pieces, 1);
  assert.ok(session.game.active.y >= 1);
  assert.equal(session.pending, true);
  assert.equal(calls, 1, 'slow inference must not create concurrent requests');
  assert.ok(captured.board.flat().every((cell) => cell === null));
  const before = { ...session.game.active };
  response.resolve({ choice: offered[0].id, probabilities: {}, latencyMs: 2700, response: { model: 'test', answers: { placement: { type: 'choice', choice: offered[0].id } } } });
  await pending;
  assert.deepEqual(session.game.active, before);
  assert.equal(session.plan, null);
  assert.equal(session.history[0].outcome, 'late');
  assert.equal(session.history[0].piece, 'O');
  assert.equal(session.modelResponses[0].piece, 'O');
  assert.equal(session.modelResponses[0].latencyMs, 2700);
  assert.equal(session.status, 'running');
});

test('a choice that becomes unreachable during inference is skipped without stopping gravity', async () => {
  let now = 0;
  let offered;
  const response = deferred();
  const session = new GameSession(online, () => {}, async (_, candidates) => { offered = candidates; return response.promise; }, () => now);
  session.game.active = { type: 'O', rotation: 0, x: 4, y: 0 };
  // This wall can be crossed at spawn but cannot be crossed after falling below it.
  for (let y = 2; y < 20; y++) session.game.board[y][3] = 'J';
  session.command({ type: 'start' });
  const pending = session.requestDecision();
  const left = offered.find(({ target }) => target.x === 0);
  assert.ok(left);
  for (now = 25; now <= 500; now += 25) session.tick(now);
  now = 500;
  response.resolve({ choice: left.id, probabilities: {}, latencyMs: 500 });
  await pending;
  assert.equal(session.plan, null);
  assert.equal(session.history[0].outcome, 'unreachable');
  now = 625;
  session.tick(now);
  assert.equal(session.game.active.y, 5);
  assert.equal(session.game.active.x, 4);
  assert.equal(session.status, 'running');
});

test('steering a long path does not postpone a scheduled gravity step', () => {
  let now = 0;
  const session = new GameSession(offline, () => {}, undefined, () => now);
  session.game.active = { type: 'O', rotation: 0, x: 4, y: 0 };
  session.command({ type: 'start' });
  session.requestedPieceId = session.game.pieceId;
  session.plan = { pieceId: session.game.pieceId, path: ['left', 'left', 'left', 'left'], target: { type: 'O', rotation: 0, x: 0, y: 18 } };
  now = 125;
  session.tick(now);
  assert.equal(session.game.active.y, 1);
  assert.equal(session.game.active.x, 1, 'gravity occurs before the fourth sideways step');
  now = 250;
  session.tick(now);
  assert.equal(session.game.active.y, 2);
  assert.equal(session.game.active.x, 0);
});

test('the next piece decision is fetched before spawn and applied only to its predicted board', async () => {
  let now = 0;
  const requests = [];
  const session = new GameSession({ configured: true, deployment: 'lookahead-test' }, () => {}, (input, candidates, _, signal) => {
    const gate = deferred();
    requests.push({ input, candidates, signal, ...gate });
    return gate.promise;
  }, () => now);
  session.command({ type: 'start' });
  const current = session.requestDecision();
  const answer = (request) => ({ choice: request.candidates[0].id, probabilities: {}, latencyMs: 300 });
  requests[0].resolve(answer(requests[0]));
  await current;
  assert.equal(requests.length, 2, 'lookahead starts as soon as the current choice is available');
  assert.equal(session.game.pieces, 0);
  assert.equal(session.pendingContext.pieceId, session.game.pieceId + 1);
  const futureBoard = requests[1].input.board;
  requests[1].resolve(answer(requests[1]));
  await requests[1].promise;
  assert.ok(session.prepared);
  assert.equal(session.history[0].outcome, 'prepared');
  for (now = 25; session.game.pieces === 0 && now < 3000; now += 25) session.tick(now);
  assert.equal(session.game.pieces, 1);
  assert.deepEqual(session.game.board, futureBoard);
  assert.equal(session.modelPlacements, 1);
  assert.equal(session.plan.source, 'model');
  assert.equal(session.plan.pieceId, session.game.pieceId);
  assert.equal(session.plan.decisionId, 2);
  assert.equal(session.history.find(({ id }) => id === 2).outcome, 'planned');
  assert.equal(requests.length, 3, 'the pipeline remains one piece ahead');
  session.close();
});

test('pause cancels a lookahead request without exposing its late result', async () => {
  const requests = [];
  const session = new GameSession({ configured: true, deployment: 'lookahead-test' }, () => {}, (input, candidates, _, signal) => {
    const gate = deferred();
    requests.push({ candidates, signal, ...gate });
    return gate.promise;
  });
  session.command({ type: 'start' });
  const first = session.requestDecision();
  requests[0].resolve({ choice: requests[0].candidates[0].id, probabilities: {}, latencyMs: 1 });
  await first;
  assert.equal(requests.length, 2);
  session.command({ type: 'pause' });
  assert.equal(requests[1].signal.aborted, true);
  requests[1].resolve({ choice: requests[1].candidates[0].id, probabilities: {}, latencyMs: 200 });
  await requests[1].promise;
  assert.equal(session.modelDecisions, 1);
  assert.equal(session.modelResponses.length, 1);
  assert.equal(session.prepared, null);
  assert.equal(session.pending, false);
  assert.equal(session.status, 'paused');
});

test('a prepared choice for a different board is discarded and requested again', async () => {
  let now = 0;
  const requests = [];
  const session = new GameSession({ configured: true, deployment: 'lookahead-test' }, () => {}, (input, candidates) => {
    const gate = deferred();
    requests.push({ input, candidates, ...gate });
    return gate.promise;
  }, () => now);
  session.game.active = { type: 'O', rotation: 0, x: 4, y: 0 };
  session.command({ type: 'start' });
  const first = session.requestDecision();
  requests[0].resolve({ choice: requests[0].candidates[0].id, probabilities: {}, latencyMs: 1 });
  await first;
  requests[1].resolve({ choice: requests[1].candidates[0].id, probabilities: {}, latencyMs: 1 });
  await requests[1].promise;
  assert.ok(session.prepared);
  session.game.board[19][9] = 'J';
  for (now = 25; session.game.pieces === 0 && now < 3000; now += 25) session.tick(now);
  assert.equal(session.game.pieces, 1);
  assert.equal(session.history.find(({ id }) => id === 2).outcome, 'unreachable');
  assert.equal(session.prepared, null);
  assert.equal(session.plan.source, 'fallback');
  assert.equal(session.pendingContext.pieceId, session.game.pieceId);
  assert.deepEqual(requests[2].input.board, session.game.board);
  session.close();
});

test('a stalled model cannot force straight drops: explicit local safety moves survive 4x', () => {
  let now = 0;
  let seed = 42;
  let requests = 0;
  const session = new GameSession({ configured: true, deployment: 'safety-test' }, () => {}, () => {
    requests++;
    return new Promise(() => {});
  }, () => now);
  session.game = new Tetris(() => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; });
  session.command({ type: 'speed', speed: 4 });
  session.command({ type: 'start' });
  for (now = 25; now <= 100000 && !session.game.over; now += 25) session.tick(now);
  assert.ok(session.game.pieces > 100);
  assert.ok(session.game.lines > 20);
  assert.equal(session.game.over, false);
  assert.equal(requests, 1);
  assert.equal(session.modelDecisions, 0);
  assert.equal(session.modelPlacements, 0);
  assert.equal(session.safetyMoves, session.game.pieces);
  assert.ok(session.history.every(({ source }) => source === 'fallback'));
  session.close();
});
