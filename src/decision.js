import { performance } from 'node:perf_hooks';

const API_PATH = '/providers/microsoft/v1/systemone';

export function decisionEndpoint(endpoint) {
  const url = new URL(endpoint);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('AZURE_ENDPOINT must be an HTTP(S) resource URL without credentials.');
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (path && path !== API_PATH) {
    throw new Error('Use your Foundry resource endpoint, without a project or OpenAI API path.');
  }
  url.pathname = API_PATH;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function loadConfig(env = process.env) {
  const endpoint = env.AZURE_ENDPOINT?.trim() || '';
  const apiKey = env.AZURE_API_KEY?.trim() || '';
  const deployment = env.DEPLOYMENT_NAME?.trim() || 'microsoft-decision-1';
  const timeout = Number(env.DECISION_TIMEOUT_MS || 10000);
  if (!Number.isFinite(timeout) || timeout < 100 || timeout > 60000) {
    throw new Error('DECISION_TIMEOUT_MS must be between 100 and 60000.');
  }
  return {
    endpoint: endpoint ? decisionEndpoint(endpoint) : null,
    apiKey,
    deployment,
    timeout,
    configured: Boolean(endpoint && apiKey && !endpoint.includes('YOUR-RESOURCE')),
  };
}

export function buildDecisionRequest(game, candidates, deployment) {
  return {
    model: deployment,
    state: {
      piece: game.active.type,
      next: game.next.slice(0, 2),
      board: game.board.map((row) => row.map((cell) => cell ? '#' : '.').join('')).join('\n'),
    },
    questions: {
      placement: {
        type: 'choice',
        instructions: 'Choose a safe Tetris placement. Minimize holes; prefer line clears, lower height and a flat surface. Options give resulting clears, holes, total height, peak height, roughness, column (zero based), rotation (degrees).',
        criteria: Object.fromEntries(candidates.map(({ id, target, metrics }) => [id,
          `clears=${metrics.lines}, holes=${metrics.holes}, height=${metrics.aggregateHeight}, peak=${metrics.maxHeight}, roughness=${metrics.bumpiness}, column=${target.x}, rotation=${target.rotation * 90}`,
        ])),
      },
    },
  };
}

export function readChoice(payload, candidates) {
  const answer = payload?.answers?.placement;
  if (answer?.type !== 'choice' || !candidates.some(({ id }) => id === answer.choice)) {
    throw new Error('Foundry returned an invalid placement choice. Check the deployment and API response.');
  }
  // Only display numerical probabilities actually supplied by the API.
  const probabilities = {};
  for (const { id } of candidates) {
    const value = answer.probabilities?.[id];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) {
      probabilities[id] = value;
    }
  }
  return { choice: answer.choice, probabilities };
}

export async function choosePlacement(game, candidates, config, signal, fetchImpl = fetch) {
  if (!config.configured) throw new Error('Add AZURE_ENDPOINT and AZURE_API_KEY to .env, then restart the server.');
  const started = performance.now();
  const request = buildDecisionRequest(game, candidates, config.deployment);
  let response;
  try {
    response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'api-key': config.apiKey },
      body: JSON.stringify(request),
      signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeout)]),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    if (error.name === 'TimeoutError') throw new Error(`Foundry did not respond within ${config.timeout} ms. Resume to retry, or switch to local demo.`);
    throw new Error('Could not reach Foundry. Check AZURE_ENDPOINT and your network connection.');
  }
  if (!response.ok) {
    const hints = {
      400: 'Check the request and deployment configuration.',
      401: 'Check AZURE_API_KEY in .env.',
      403: 'Your key or resource cannot access this deployment.',
      404: 'Check the Foundry resource endpoint and DEPLOYMENT_NAME.',
      422: 'Check DEPLOYMENT_NAME and support for choice questions.',
      429: 'Rate limit reached. Wait before resuming, or lower the play speed.',
    };
    // Do not forward provider bodies: they can contain sensitive request details.
    throw new Error(`Foundry HTTP ${response.status}. ${hints[response.status] || 'Resume to retry.'}`);
  }
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error('Foundry returned invalid JSON. Resume to retry.'); }
  return {
    ...readChoice(payload, candidates),
    latencyMs: Math.round((performance.now() - started) * 10) / 10,
    model: typeof payload.model === 'string' ? payload.model : config.deployment,
    usage: payload.usage || null,
    response: payload,
  };
}
