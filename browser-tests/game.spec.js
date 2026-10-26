import { test, expect } from '@playwright/test';
import http from 'node:http';
import { once } from 'node:events';
import { createApp } from '../server.js';

test('local play renders the board, streams decisions, and supports pause and reset', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#connection-label')).toHaveText('WEBSOCKET CONNECTED');
  await expect(page.locator('[data-mode="demo"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('[data-speed="4"]').click();
  await expect(page.locator('[data-speed="4"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#overlay-start').click();
  await expect.poll(async () => Number(await page.locator('#pieces').textContent())).toBeGreaterThanOrEqual(3);
  await expect(page.locator('#board')).toHaveAttribute('aria-label', /pieces placed\. running/);
  await expect(page.locator('.decision-card').first()).toContainText('Local heuristic');
  await expect(page.locator('#model-calls')).toHaveText('0');
  await expect(page.locator('#model-placements')).toHaveText('0');
  await expect(page.locator('#safety-moves')).toHaveText('0');
  await expect(page.locator('#latency')).toHaveText('—');
  await expect(page.locator('#model-response')).toHaveText('Foundry is not configured.');
  await expect(page.locator('#response-latency')).toHaveText('—');
  await expect(page.locator('#board-overlay')).toBeHidden();
  const viewport = page.viewportSize();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
  if (testInfo.project.name === 'mobile') {
    expect(await page.evaluate(() => matchMedia('(max-width:650px)').matches)).toBe(true);
  }
  await page.screenshot({ path: testInfo.outputPath('game.png'), fullPage: true });
  await page.locator('#play-button').click();
  await expect(page.locator('#game-state')).toHaveText('PAUSED');
  await expect(page.locator('#overlay-title')).toHaveText('Paused');
  await page.locator('#decision-inspector > summary').click();
  await expect(page.locator('#candidate-details tbody tr')).toHaveCount(8);
  await expect(page.locator('#candidate-details tr.selected')).toHaveCount(1);
  await page.locator('#reset-button').click();
  await expect(page.locator('#game-state')).toHaveText('STANDBY');
  await expect(page.locator('#pieces')).toHaveText('0');
  await expect(page.locator('#decisions')).toHaveText('0');
  await expect(page.locator('.stream-empty')).toBeVisible();
  expect(errors).toEqual([]);
});

test('manual keyboard and touch controls work and connection setup stays usable', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#connection-label')).toHaveText('WEBSOCKET CONNECTED');
  await page.locator('[data-mode="model"]').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#setup-title')).toHaveText('Foundry connection');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.locator('[data-mode="manual"]').click();
  await expect(page.locator('[data-mode="manual"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#touch-controls')).toBeVisible();
  await page.locator('#overlay-start').click();
  await expect(page.locator('#board')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Space');
  await expect(page.locator('#pieces')).toHaveText('1');
  await page.locator('[data-action="rotate"]').click();
  await page.locator('[data-action="drop"]').click();
  await expect(page.locator('#pieces')).toHaveText('2');
  await page.keyboard.press('p');
  await expect(page.locator('#game-state')).toHaveText('PAUSED');
  await expect(page.locator('#model-calls')).toHaveText('0');
  expect(errors).toEqual([]);
});

test('model response panel shows raw JSON and the matching latency for current and earlier responses', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let requests = 0;
  const provider = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const choice = Object.keys(body.questions.placement.criteria)[0];
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      model: 'microsoft-decision-1',
      response_id: ++requests,
      answers: { placement: { type: 'choice', choice, probabilities: { [choice]: 0.91 }, confidence: 0.82 } },
      usage: { input_tokens: 123, output_tokens: 0 },
      metadata: '<script>window.untrustedModelContent = true</script>',
    }));
  });
  let liveApp;
  try {
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    // Each project gets independent servers and a local mock, never the real .env.
    liveApp = createApp({
      configured: true, deployment: 'browser-test-deployment', apiKey: 'browser-test-key', timeout: 2000,
      endpoint: `http://127.0.0.1:${provider.address().port}/providers/microsoft/v1/systemone`,
    });
    liveApp.server.listen(0, '127.0.0.1');
    await once(liveApp.server, 'listening');
    await page.goto(`http://127.0.0.1:${liveApp.server.address().port}`);
    await expect(page.locator('#model-response')).toHaveText('No model responses yet.');
    await expect(page.locator('#response-select')).toBeDisabled();
    await page.locator('#overlay-start').click();
    await expect.poll(async () => page.locator('#response-select option').count()).toBeGreaterThanOrEqual(3);
    await page.locator('#play-button').click();
    await expect(page.locator('#game-state')).toHaveText('PAUSED');
    await expect(page.locator('#response-status')).toHaveText('Received');
    await expect(page.locator('#response-model')).toHaveText('microsoft-decision-1');
    const session = [...liveApp.sessions.values()][0];
    const latest = session.modelResponses[0];
    await expect(page.locator('#response-latency')).toHaveText(latest.latencyMs.toFixed(1));
    expect(JSON.parse(await page.locator('#model-response').textContent())).toEqual(latest.payload);
    await expect(page.locator('#model-response script')).toHaveCount(0);
    await page.locator('#response-select').selectOption('1');
    const earlier = session.modelResponses.find(({ id }) => id === 1);
    await expect(page.locator('#response-latency')).toHaveText(earlier.latencyMs.toFixed(1));
    expect(JSON.parse(await page.locator('#model-response').textContent()).response_id).toBe(1);
    await page.locator('[data-mode="demo"]').click();
    await expect(page.locator('#response-select')).toHaveValue('1');
    expect(JSON.parse(await page.locator('#model-response').textContent()).response_id).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize().width);
    await page.locator('#reset-button').click();
    await expect(page.locator('#model-response')).toHaveText('No model responses yet.');
    await expect(page.locator('#response-latency')).toHaveText('—');
    await expect(page.locator('#response-select')).toBeDisabled();
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    if (liveApp) await liveApp.close();
    if (provider.listening) await new Promise((resolve) => provider.close(resolve));
  }
});

test('pieces animate and keep spawning while a model response is held back', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let release;
  let requests = 0;
  const heldResponse = new Promise((resolve) => { release = resolve; });
  const app = createApp({ configured: true, deployment: 'delayed-test' }, {
    decide: async (_, candidates) => {
      const request = ++requests;
      const started = performance.now();
      if (request === 1) await heldResponse;
      return {
        choice: candidates[0].id, probabilities: {}, latencyMs: performance.now() - started,
        response: { model: 'delayed-test', request, answers: { placement: { type: 'choice', choice: candidates[0].id } } },
      };
    },
  });
  try {
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    await page.goto(`http://127.0.0.1:${app.server.address().port}`);
    await expect(page.locator('#connection-label')).toHaveText('WEBSOCKET CONNECTED');
    await page.locator('[data-speed="2"]').click();
    await page.locator('#overlay-start').click();
    await expect.poll(() => requests).toBe(1);
    const session = [...app.sessions.values()][0];
    await expect(page.locator('#response-status')).toHaveText('Requesting');
    await expect(page.locator('#game-state')).toHaveText('IN PLAY');
    const firstFrame = await page.locator('#board').screenshot();
    await expect.poll(async () => (await page.locator('#board').screenshot()).equals(firstFrame), {
      timeout: 1000, intervals: [35, 50, 75],
    }).toBe(false);
    await expect.poll(() => session.game.pieces, { timeout: 4000 }).toBeGreaterThanOrEqual(1);
    await expect.poll(() => session.game.active.y, { timeout: 1000 }).toBeGreaterThanOrEqual(1);
    expect(session.pending).toBe(true);
    expect(session.modelResponses).toHaveLength(0);
    expect(requests).toBe(1);
    await expect(page.getByText('Local safety', { exact: true }).first()).toBeVisible();
    await expect.poll(async () => Number(await page.locator('#safety-moves').textContent())).toBeGreaterThan(0);
    await expect(page.locator('#model-placements')).toHaveText('0');
    await expect(page.locator('#board-overlay')).toBeHidden();
    release();
    await expect.poll(() => session.modelResponses.length).toBeGreaterThan(0);
    await page.locator('#play-button').click();
    await expect(page.locator('#game-state')).toHaveText('PAUSED');
    const late = session.history.find(({ source, outcome }) => source === 'model' && outcome === 'late');
    expect(late).toBeTruthy();
    await page.locator('#response-select').selectOption(String(late.id));
    expect(JSON.parse(await page.locator('#model-response').textContent()).request).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    release();
    await page.close();
    await app.close();
  }
});
