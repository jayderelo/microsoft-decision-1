import { performance } from 'node:perf_hooks';
import { writeFile, mkdir } from 'node:fs/promises';
import { Tetris } from '../src/tetris.js';
import { GameSession } from '../src/session.js';
import { loadConfig } from '../src/decision.js';

const config = loadConfig();
if (!config.configured) throw new Error('Configure Foundry in .env before profiling.');
let seed = 42;
const random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
const session = new GameSession(config, () => {});
session.game = new Tetris(random);
session.command({ type: 'speed', speed: 4 });
session.command({ type: 'start' });
const seen = new Map();
const started = performance.now();
const duration = Number(process.env.PROFILE_DURATION_MS || 20000);
const label = process.env.PROFILE_LABEL || 'gameplay';
if (!/^[a-z0-9-]+$/i.test(label)) throw new Error('PROFILE_LABEL must contain only letters, numbers, or hyphens.');
const result = await new Promise(resolve => {
  const timer = setInterval(() => {
    session.tick();
    for (const item of session.history) seen.set(item.id, { source: item.source, outcome: item.outcome });
    if (performance.now() - started < duration && session.status === 'running') return;
    clearInterval(timer);
    resolve({
      speed: 4, elapsedMs: Math.round(performance.now() - started), status: session.status,
      score: session.game.score, lines: session.game.lines, pieces: session.game.pieces,
      modelResponses: session.modelDecisions, modelPlacements: session.modelPlacements, safetyMoves: session.safetyMoves, p50Ms: session.snapshot().stats.p50,
      outcomes: [...seen.values()].reduce((counts, item) => {
        const key = `${item.source}:${item.outcome}`;
        counts[key] = (counts[key] || 0) + 1;
        return counts;
      }, {}),
      error: session.error,
    });
    session.close();
  }, 50);
});
console.log(JSON.stringify(result));
await mkdir('performance-results', { recursive: true });
await writeFile(`performance-results/${label}.json`, JSON.stringify(result, null, 2));
