import test from 'node:test';
import assert from 'node:assert/strict';
import { Tetris, enumeratePlacements } from '../src/tetris.js';
import { decisionEndpoint, loadConfig, buildDecisionRequest, readChoice, choosePlacement } from '../src/decision.js';

const game = new Tetris();
const candidates = enumeratePlacements(game.board, game.active).slice(0, 8);
const config = { configured: true, endpoint: 'https://example.services.ai.azure.com/providers/microsoft/v1/systemone', apiKey: 'test-secret', deployment: 'custom-deployment', timeout: 1000 };

test('resource endpoint normalization does not duplicate the provider path', () => {
  const url = 'https://example.services.ai.azure.com';
  assert.equal(decisionEndpoint(url), `${url}/providers/microsoft/v1/systemone`);
  assert.equal(decisionEndpoint(`${url}/providers/microsoft/v1/systemone/`), `${url}/providers/microsoft/v1/systemone`);
  assert.throws(() => decisionEndpoint(`${url}/api/projects/test`), /resource endpoint/);
  assert.throws(() => decisionEndpoint('file:///etc/passwd'), /HTTP/);
  assert.equal(loadConfig({}).configured, false);
  assert.equal(loadConfig({ AZURE_ENDPOINT: url }).configured, false);
  assert.throws(() => loadConfig({ DECISION_TIMEOUT_MS: 'NaN' }), /TIMEOUT/);
});

test('request uses the deployment, a structured board, and bounded choice criteria', () => {
  const request = buildDecisionRequest(game, candidates, config.deployment);
  assert.equal(request.model, 'custom-deployment');
  assert.equal(request.questions.placement.type, 'choice');
  const rows = request.state.board.split('\n');
  assert.equal(rows.length, 20);
  assert.ok(rows.every((row) => /^[.#]{10}$/.test(row)));
  assert.deepEqual(Object.keys(request.questions.placement.criteria), candidates.map(({ id }) => id));
  assert.equal(request.state.candidates, undefined, 'candidate descriptions are not duplicated in state');
  assert.equal(JSON.stringify(request).includes(config.apiKey), false);
});

test('choice parsing rejects unknown moves and never invents probabilities', () => {
  const choice = candidates[0].id;
  const parsed = readChoice({ answers: { placement: { type: 'choice', choice, probabilities: { [choice]: 0.73, [candidates[1].id]: 2 } } } }, candidates);
  assert.deepEqual(parsed, { choice, probabilities: { [choice]: 0.73 } });
  assert.deepEqual(readChoice({ answers: { placement: { type: 'choice', choice } } }, candidates).probabilities, {});
  assert.throws(() => readChoice({ answers: { placement: { type: 'choice', choice: 'teleport' } } }, candidates), /invalid placement/);
  assert.throws(() => readChoice({ answers: { placement: { type: 'score', choice } } }, candidates), /invalid placement/);
  assert.throws(() => readChoice(null, candidates), /invalid placement/);
});

test('Foundry call uses api-key auth and measures an actual request roundtrip', async () => {
  const controller = new AbortController();
  const payload = {
    model: 'microsoft-decision-1',
    answers: { placement: { type: 'choice', choice: candidates[1].id, confidence: 0.6, probabilities: { [candidates[1].id]: 0.8 } } },
    usage: { input_tokens: 120, output_tokens: 0 },
  };
  const result = await choosePlacement(game, candidates, config, controller.signal, async (url, init) => {
    assert.equal(url, config.endpoint);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['api-key'], 'test-secret');
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(JSON.parse(init.body).model, 'custom-deployment');
    await new Promise((resolve) => setTimeout(resolve, 20));
    return Response.json(payload);
  });
  assert.equal(result.choice, candidates[1].id);
  assert.ok(result.latencyMs >= 15);
  assert.equal(result.model, 'microsoft-decision-1');
  assert.deepEqual(result.response, payload);
});

test('HTTP errors have useful messages without leaking provider response bodies', async () => {
  for (const status of [400, 401, 403, 404, 422, 429, 500]) {
    await assert.rejects(choosePlacement(game, candidates, config, new AbortController().signal,
      async () => new Response('SENSITIVE_PROVIDER_BODY', { status })), (error) => {
      assert.ok(error.message.includes(String(status)));
      assert.ok(!error.message.includes('SENSITIVE_PROVIDER_BODY'));
      return true;
    });
  }
  await assert.rejects(choosePlacement(game, candidates, config, new AbortController().signal,
    async () => new Response('not json')), /invalid JSON/);
});

test('a hung Foundry request times out and cancellation is propagated', async () => {
  const waitForAbort = async (_, { signal }) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  // Keep the event loop active: AbortSignal.timeout timers are unreferenced in Node.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(choosePlacement(game, candidates, { ...config, timeout: 30 }, new AbortController().signal, waitForAbort), /did not respond/);
    const controller = new AbortController();
    const pending = choosePlacement(game, candidates, config, controller.signal, waitForAbort);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
  } finally { clearInterval(keepAlive); }
});
