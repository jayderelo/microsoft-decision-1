import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApp } from '../server.js';

async function startApp(t, config = { configured: false, deployment: 'test' }) {
  const app = createApp(config);
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base, socketURL: base.replace('http:', 'ws:') + '/ws' };
}

function client(url, options) {
  const ws = new WebSocket(url, options);
  let latest;
  const waiters = new Set();
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    latest = message.type === 'state' ? { ...latest, ...message } : message;
    for (const waiter of waiters) {
      if (waiter.predicate(latest)) { clearTimeout(waiter.timer); waiters.delete(waiter); waiter.resolve(latest); }
    }
  });
  return {
    ws,
    send: (message) => ws.send(JSON.stringify(message)),
    wait: (predicate, timeout = 5000) => {
      if (latest && predicate(latest)) return Promise.resolve(latest);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error('Timed out waiting for game state')); }, timeout) };
        waiters.add(waiter);
      });
    },
  };
}

test('HTTP serves the app and never exposes environment or source files', async (t) => {
  const { base } = await startApp(t);
  const response = await fetch(base);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Decision Arcade/);
  assert.ok(response.headers.get('content-security-policy'));
  for (const pathname of ['/.env', '/.env.example', '/server.js', '/package.json', '/src/decision.js', '/..%2f.env']) {
    assert.equal((await fetch(base + pathname)).status, 404);
  }
  for (const pathname of ['/app.js', '/styles.css', '/favicon.svg']) assert.equal((await fetch(base + pathname)).status, 200);
  assert.deepEqual(await (await fetch(base + '/health')).json(), { ok: true, configured: false });
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
});

test('real WebSocket clients have independent games, control modes, and recover from malformed JSON', async (t) => {
  const { socketURL } = await startApp(t);
  const a = client(socketURL);
  const b = client(socketURL);
  await Promise.all([a.wait((s) => s.status === 'ready'), b.wait((s) => s.status === 'ready')]);
  a.send({ type: 'mode', mode: 'manual' });
  a.send({ type: 'start' });
  a.send({ type: 'input', action: 'drop' });
  await a.wait((s) => s.game?.pieces === 1);
  assert.equal((await b.wait((s) => s.status === 'ready')).game.pieces, 0);
  a.send({ type: 'pause' });
  await a.wait((s) => s.status === 'paused');
  a.ws.send('{bad');
  await a.wait((s) => s.type === 'notice' && /Invalid/.test(s.message));
  a.send({ type: 'reset' });
  const reset = await a.wait((s) => s.status === 'ready' && s.game?.pieces === 0);
  assert.equal(reset.mode, 'manual');
  assert.equal(reset.stats.decisions, 0);
  a.ws.close(); b.ws.close();
});

test('WebSocket rejects a different browser origin', async (t) => {
  const { socketURL } = await startApp(t);
  const ws = new WebSocket(socketURL, { origin: 'https://other.example' });
  const error = await new Promise((resolve) => ws.once('error', resolve));
  assert.match(error.message, /403/);
});

test('live game uses the HTTP Foundry contract and executes the returned candidate', async (t) => {
  let captured;
  const mock = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    captured = { path: req.url, key: req.headers['api-key'], body };
    const choice = Object.keys(body.questions.placement.criteria)[1];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: 'microsoft-decision-1', answers: { placement: { type: 'choice', choice, probabilities: { [choice]: 0.91 } } } }));
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  t.after(() => new Promise((resolve) => mock.close(resolve)));
  const config = {
    configured: true,
    endpoint: `http://127.0.0.1:${mock.address().port}/providers/microsoft/v1/systemone`,
    apiKey: 'integration-only-test-key', deployment: 'my-custom-deployment', timeout: 2000,
  };
  const { socketURL } = await startApp(t, config);
  const c = client(socketURL);
  await c.wait((s) => s.status === 'ready');
  c.send({ type: 'speed', speed: 4 });
  c.send({ type: 'start' });
  const decided = await c.wait((s) => s.stats?.modelDecisions >= 1);
  assert.equal(captured.path, '/providers/microsoft/v1/systemone');
  assert.equal(captured.key, 'integration-only-test-key');
  assert.equal(captured.body.model, 'my-custom-deployment');
  assert.equal(captured.body.questions.placement.type, 'choice');
  assert.equal(decided.history[0].choice, 'move_2');
  assert.equal(decided.history[0].probability, 0.91);
  assert.ok(decided.stats.lastLatency >= 0);
  assert.equal(decided.modelResponses[0].payload.answers.placement.choice, 'move_2');
  assert.equal(decided.modelResponses[0].latencyMs, decided.stats.lastLatency);
  assert.equal(decided.modelResponses[0].payload.answers.placement.probabilities.move_2, 0.91);
  assert.equal(JSON.stringify(decided).includes(config.apiKey), false);
  const executed = await c.wait((s) => s.game?.pieces >= 1);
  assert.ok(executed.game.board.flat().some(Boolean));
  c.send({ type: 'pause' });
  await c.wait((s) => s.status === 'paused');
  c.ws.close();
});
