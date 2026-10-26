import { performance } from 'node:perf_hooks';
import { writeFile, mkdir } from 'node:fs/promises';
import { Tetris, enumeratePlacements } from '../src/tetris.js';
import { loadConfig, buildDecisionRequest } from '../src/decision.js';

const config = loadConfig();
if (!config.configured) throw new Error('Configure Foundry in .env before profiling.');
const game = new Tetris(() => 0.4);
const timings = [];
let candidates;
for (let i = 0; i < 100; i++) {
  const start = performance.now();
  candidates = enumeratePlacements(game.board, game.active).slice(0, 8);
  timings.push(performance.now() - start);
}
const gameRequest = buildDecisionRequest(game, candidates, config.deployment);
const minimal = { model: config.deployment, state: 'Tetris: choose a safe move.', questions: { placement: { type: 'choice', instructions: 'Prefer fewer holes.', criteria: { move_1: '0 holes', move_2: '3 holes' } } } };
const bodies = { game: gameRequest, minimal };
const measurements = [];
for (let round = 0; round < 6; round++) {
  for (const [variant, body] of Object.entries(bodies)) {
    const json = JSON.stringify(body);
    const started = performance.now();
    const response = await fetch(config.endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'api-key': config.apiKey },
      body: json, signal: AbortSignal.timeout(config.timeout),
    });
    const headersMs = performance.now() - started;
    if (!response.ok) throw new Error(`Foundry returned HTTP ${response.status}.`);
    const payload = await response.json();
    const sample = { variant, round, bytes: Buffer.byteLength(json), inputTokens: payload.usage?.input_tokens ?? null, headersMs: Math.round(headersMs), totalMs: Math.round(performance.now() - started) };
    measurements.push(sample);
    console.log(JSON.stringify(sample));
  }
}
const percentile = (values, p) => [...values].sort((a,b) => a-b)[Math.ceil(values.length * p) - 1];
const summary = {
  simulation: { p50Ms: +percentile(timings, .5).toFixed(3), p95Ms: +percentile(timings, .95).toFixed(3) },
  variants: Object.fromEntries(Object.keys(bodies).map(variant => {
    const samples = measurements.filter(sample => sample.variant === variant && sample.round > 0);
    return [variant, { bytes: samples[0].bytes, inputTokens: samples[0].inputTokens, warmP50Ms: percentile(samples.map(s => s.totalMs), .5), warmP95Ms: percentile(samples.map(s => s.totalMs), .95) }];
  })),
};
console.log(JSON.stringify({ summary }));
await mkdir('performance-results', { recursive: true });
await writeFile('performance-results/latency-profile.json', JSON.stringify({ summary, measurements }, null, 2));
