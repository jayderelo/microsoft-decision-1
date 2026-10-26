(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const COLORS = { I: '#65d9e2', O: '#edce70', T: '#b199ed', S: '#b6f26a', Z: '#ec849a', J: '#7b9df2', L: '#e6aa71' };
  const SHAPES = { I: [[1,1,1,1]], O: [[1,1],[1,1]], T: [[0,1,0],[1,1,1]], S: [[0,1,1],[1,1,0]], Z: [[1,1,0],[0,1,1]], J: [[1,0,0],[1,1,1]], L: [[0,0,1],[1,1,1]] };
  const board = $('board');
  const ctx = board.getContext('2d');
  const nextCtx = $('next').getContext('2d');
  const chart = $('latency-chart');
  const chartCtx = chart.getContext('2d');
  let ws;
  let state = null;
  let connected = false;
  let retry = 0;
  let retryTimer;
  let toastTimer;
  let lastStreamKey = '';
  let lastPieceId = 0;
  let lastStatus = '';
  let latencyPoints = [];
  let lastChartKey = '';
  let lastDrawn = '';
  let lastConnectionKey = '';
  let lastResponseListKey = null;
  let lastResponseKey = '';
  let leaving = false;
  let stateReceivedAt = performance.now();
  let lastFrameAt = stateReceivedAt;
  let renderedPieceId = null;
  let renderedX = 0;
  let renderedY = 0;
  let animationFrame;

  function shapeFor(type, rotation = 0) {
    let shape = SHAPES[type];
    for (let i = 0; i < rotation; i++) shape = shape[0].map((_, x) => shape.map((row) => row[x]).reverse());
    return shape;
  }

  function send(message) {
    if (connected && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500);
  }

  function setConnection(online) {
    connected = online;
    $('play-button').disabled = !online;
    $('reset-button').disabled = !online;
    $('overlay-start').disabled = !online;
    document.querySelectorAll('[data-mode],[data-speed],[data-action]').forEach((button) => { button.disabled = !online; });
    $('connection-dot').className = `status-dot${online ? ' online' : ' error'}`;
    $('connection-label').textContent = online ? 'WEBSOCKET CONNECTED' : 'RECONNECTING';
    if (!online) {
      $('game-state').textContent = 'OFFLINE';
      $('board-overlay').hidden = false;
      $('overlay-title').textContent = 'Reconnecting…';
      $('overlay-copy').textContent = 'The server connection was lost.\nA fresh game will be ready on reconnect.';
      $('overlay-copy').hidden = false;
      $('thinking-indicator').hidden = true;
      $('response-status').textContent = 'Offline';
    }
  }

  function connect() {
    clearTimeout(retryTimer);
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.addEventListener('open', () => {
      retry = 0;
      lastStreamKey = '';
      lastChartKey = '';
      lastConnectionKey = '';
      lastResponseListKey = null;
      lastResponseKey = '';
      lastPieceId = 0;
      lastDrawn = '';
      state = null;
      renderedPieceId = null;
      latencyPoints = [];
      setConnection(true);
    });
    ws.addEventListener('message', ({ data }) => {
      let message;
      try { message = JSON.parse(data); } catch { return; }
      if (message.type === 'notice') { showToast(message.message); return; }
      if (message.type !== 'state') return;
      state = { ...state, ...message };
      stateReceivedAt = performance.now();
      render();
    });
    ws.addEventListener('close', () => {
      setConnection(false);
      if (!leaving) retryTimer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 10000));
    });
    ws.addEventListener('error', () => { ws.close(); });
  }

  function cell(context, x, y, size, color, style = 'solid') {
    const pad = size * .065;
    const left = x * size + pad;
    const top = y * size + pad;
    const width = size - pad * 2;
    context.save();
    if (style === 'ghost' || style === 'target') {
      context.fillStyle = `${color}${style === 'target' ? '16' : '10'}`;
      context.fillRect(left, top, width, width);
      context.strokeStyle = `${color}${style === 'target' ? 'aa' : '62'}`;
      context.lineWidth = style === 'target' ? 1.3 : 1;
      context.setLineDash(style === 'target' ? [3, 3] : []);
      context.strokeRect(left + .5, top + .5, width - 1, width - 1);
    } else {
      const fill = context.createLinearGradient(left, top, left, top + width);
      fill.addColorStop(0, color);
      fill.addColorStop(1, `${color}cb`);
      context.fillStyle = fill;
      context.fillRect(left, top, width, width);
      context.fillStyle = '#ffffff30';
      context.fillRect(left, top, width, 2);
      context.strokeStyle = '#ffffff10';
      context.strokeRect(left + .5, top + .5, width - 1, width - 1);
      context.fillStyle = '#0000000d';
      context.fillRect(left + width * .25, top + width * .25, width * .5, width * .5);
    }
    context.restore();
  }

  function drawPiece(piece, style = 'solid') {
    if (!piece) return;
    shapeFor(piece.type, piece.rotation).forEach((row, y) => row.forEach((filled, x) => {
      if (filled) cell(ctx, x + piece.x, y + piece.y, 30, COLORS[piece.type], style);
    }));
  }

  function drawBoard(now = performance.now()) {
    ctx.fillStyle = '#0b1018';
    ctx.fillRect(0, 0, 300, 600);
    ctx.strokeStyle = '#1a2431';
    ctx.lineWidth = .65;
    for (let x = 1; x < 10; x++) { ctx.beginPath(); ctx.moveTo(x * 30, 0); ctx.lineTo(x * 30, 600); ctx.stroke(); }
    for (let y = 1; y < 20; y++) { ctx.beginPath(); ctx.moveTo(0, y * 30); ctx.lineTo(300, y * 30); ctx.stroke(); }
    if (!state) return;
    state.game.board.forEach((row, y) => row.forEach((type, x) => { if (type) cell(ctx, x, y, 30, COLORS[type]); }));
    if (!state.game.over) {
      drawPiece(state.game.ghost, 'ghost');
      drawPiece(state.target, 'target');
      const active = state.game.active;
      const moving = connected && state.status === 'running';
      const elapsed = Math.max(0, now - stateReceivedAt);
      const progress = moving && state.motion ? Math.min(1, (state.motion.gravityElapsedMs + elapsed) / state.motion.gravityIntervalMs) : 0;
      const y = Math.min(state.game.ghost.y, active.y + progress);
      if (renderedPieceId !== state.game.pieceId || !moving) {
        renderedPieceId = state.game.pieceId;
        renderedX = active.x;
        renderedY = y;
      } else {
        const blend = Math.min(1, Math.max(0, now - lastFrameAt) / 45);
        renderedX += (active.x - renderedX) * blend;
        renderedY = Math.min(state.game.ghost.y, Math.max(renderedY, y));
      }
      drawPiece({ ...active, x: renderedX, y: renderedY });
    }
    lastFrameAt = now;
  }

  function drawNext() {
    if (!state) return;
    nextCtx.clearRect(0, 0, 80, 300);
    state.game.next.forEach((type, index) => {
      const shape = shapeFor(type);
      nextCtx.save();
      nextCtx.translate((80 - shape[0].length * 16) / 2, index * 56 + (40 - shape.length * 16) / 2);
      nextCtx.globalAlpha = 1 - index * .13;
      shape.forEach((row, y) => row.forEach((filled, x) => { if (filled) cell(nextCtx, x, y, 16, COLORS[type]); }));
      nextCtx.restore();
    });
    $('next').setAttribute('aria-label', `Next pieces: ${state.game.next.join(', ')}`);
  }

  function animate(now) {
    if (state?.status === 'running' && connected && !document.hidden) drawBoard(now);
    animationFrame = requestAnimationFrame(animate);
  }

  function drawChart() {
    const w = chart.width;
    const h = chart.height;
    chartCtx.clearRect(0, 0, w, h);
    chartCtx.strokeStyle = '#273142';
    chartCtx.lineWidth = 1;
    chartCtx.setLineDash([5, 7]);
    for (const y of [h * .3, h * .7]) { chartCtx.beginPath(); chartCtx.moveTo(0, y); chartCtx.lineTo(w, y); chartCtx.stroke(); }
    chartCtx.setLineDash([]);
    if (!latencyPoints.length) {
      chartCtx.strokeStyle = '#506342';
      chartCtx.beginPath(); chartCtx.moveTo(0, h * .7); chartCtx.lineTo(w, h * .7); chartCtx.stroke();
      return;
    }
    const max = Math.max(...latencyPoints, 1) * 1.2;
    const points = latencyPoints.map((value, i) => [w * i / Math.max(latencyPoints.length - 1, 1), h - 12 - value / max * (h - 24)]);
    const fill = chartCtx.createLinearGradient(0, 0, 0, h);
    fill.addColorStop(0, '#b6f23035'); fill.addColorStop(1, '#b6f23000');
    chartCtx.beginPath(); chartCtx.moveTo(0, h);
    points.forEach(([x, y]) => chartCtx.lineTo(x, y));
    chartCtx.lineTo(points.at(-1)[0], h); chartCtx.closePath(); chartCtx.fillStyle = fill; chartCtx.fill();
    chartCtx.strokeStyle = '#b6f26a'; chartCtx.lineWidth = 2;
    chartCtx.beginPath(); points.forEach(([x, y], i) => i ? chartCtx.lineTo(x, y) : chartCtx.moveTo(x, y)); chartCtx.stroke();
    const [x, y] = points.at(-1);
    chartCtx.fillStyle = '#b6f26a'; chartCtx.beginPath(); chartCtx.arc(Math.min(w - 4, Math.max(4, x)), y, 4, 0, Math.PI * 2); chartCtx.fill();
    chart.setAttribute('aria-label', `Last ${latencyPoints.length} model request latencies in milliseconds: ${latencyPoints.map((value) => Math.round(value)).join(', ')}`);
  }

  function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function renderHistory() {
    const latest = state.history[0];
    const key = `${state.historyVersion}:${state.mode}`;
    if (key === lastStreamKey) return;
    lastStreamKey = key;
    if (!latest) {
      $('decision-stream').replaceChildren();
      const empty = element('div', 'stream-empty');
      empty.append(element('p', '', 'No decisions yet.'));
      $('decision-stream').append(empty);
      $('candidate-details').textContent = 'Start a game to see candidate placements.';
      return;
    }
    const fragment = document.createDocumentFragment();
    state.history.slice(0, 8).forEach((decision) => {
      const selected = decision.candidates.find((candidate) => candidate.id === decision.choice);
      const card = element('article', 'decision-card');
      const heading = element('div', 'decision-card-heading');
      const badge = element('span', 'piece-badge', decision.piece);
      badge.style.color = COLORS[decision.piece];
      heading.append(badge, element('span', '', decision.source === 'model' ? 'Decision-1' : decision.source === 'forced' ? 'Only legal move' : decision.source === 'fallback' ? 'Local safety' : 'Local heuristic'), element('span', 'decision-id', `#${String(decision.id).padStart(3, '0')}`));
      const move = element('div', 'decision-card-move');
      move.append(element('span', '', `Column ${selected.column} · ${selected.rotation}°`), element('span', '', `${decision.latencyMs < 1 ? '<1' : Math.round(decision.latencyMs)} ms`));
      const meta = element('div', 'decision-card-meta', `Clears ${selected.metrics.lines} lines · ${selected.metrics.holes} holes · height ${selected.metrics.maxHeight}`);
      const footer = element('div', 'decision-card-footer');
      footer.append(element('span', '', `${decision.candidates.length} candidates`), element('span', '', decision.source === 'fallback' ? 'LOCAL SAFETY' : decision.source === 'forced' ? 'FORCED MOVE' : decision.source === 'demo' ? 'LOCAL DEMO' : decision.probability === null ? 'PROB. N/A' : `${(decision.probability * 100).toFixed(1)}% PROB.`));
      card.append(heading, move, meta, footer);
      if (decision.outcome === 'late' || decision.outcome === 'unreachable') {
        card.append(element('div', 'decision-card-meta', decision.outcome === 'late' ? 'Not applied: piece already placed.' : 'Not applied: placement no longer reachable.'));
      }
      if (decision.outcome === 'prepared') card.append(element('div', 'decision-card-meta', 'Prepared for next piece.'));
      fragment.append(card);
    });
    $('decision-stream').replaceChildren(fragment);
    const details = $('candidate-details');
    details.replaceChildren(element('p', '', `${latest.candidates.length} shortlisted / ${latest.legalMoves} reachable placements. Metrics come from board simulation.`));
    const table = element('table');
    const thead = element('thead');
    const row = element('tr');
    ['Move', 'Col / °', 'Lines', 'Holes', 'Prob.'].forEach((text) => row.append(element('th', '', text)));
    thead.append(row); table.append(thead);
    const tbody = element('tbody');
    latest.candidates.forEach((candidate) => {
      const tr = element('tr', candidate.id === latest.choice ? 'selected' : '');
      [candidate.id.replace('move_', '#'), `${candidate.column} / ${candidate.rotation}`, candidate.metrics.lines, candidate.metrics.holes,
        candidate.probability === null ? '—' : `${(candidate.probability * 100).toFixed(1)}%`].forEach((text) => tr.append(element('td', '', String(text))));
      tbody.append(tr);
    });
    table.append(tbody); details.append(table);
    details.append(element('p', '', latest.source === 'model' ? `Reported model: ${latest.model}. Probabilities are shown only when returned by Foundry.` : latest.source === 'forced' ? 'Only one legal placement remains. The engine executes it without a model call.' : latest.source === 'fallback' ? 'A local safety move was used while the model response was pending. This is not a model decision.' : 'Local demo uses a deterministic board heuristic. It makes no model calls and provides no model probabilities.'));
  }

  function renderResponses() {
    const responses = state.modelResponses || [];
    const select = $('response-select');
    const failed = state.mode === 'model' && Boolean(state.error);
    const pending = state.mode === 'model' && state.thinking;
    $('response-status').textContent = !connected ? 'Offline' : pending ? 'Requesting' : failed ? 'Error' : responses.length ? 'Received' : !state.configured ? 'Not configured' : 'Waiting';
    $('response-status').className = `response-status${pending ? ' pending' : failed ? ' failed' : ''}`;
    $('response-error').hidden = !failed;
    $('response-error').textContent = failed ? state.error : '';

    const listKey = responses.map(({ id, receivedAt }) => `${id}:${receivedAt}`).join('|');
    if (listKey !== lastResponseListKey) {
      lastResponseListKey = listKey;
      const selection = select.value;
      const options = [element('option', '', 'Latest response')];
      options[0].value = 'latest';
      for (const response of responses) {
        const option = element('option', '', `#${String(response.id).padStart(3, '0')} · ${response.piece} · ${response.latencyMs.toFixed(1)} ms`);
        option.value = String(response.id);
        options.push(option);
      }
      select.replaceChildren(...options);
      select.value = responses.some(({ id }) => String(id) === selection) ? selection : 'latest';
    }
    select.disabled = !responses.length;
    const selected = select.value === 'latest' ? responses[0] : responses.find(({ id }) => String(id) === select.value);
    const responseKey = selected ? `${selected.id}:${selected.receivedAt}` : `empty:${state.configured}`;
    if (responseKey === lastResponseKey) return;
    lastResponseKey = responseKey;
    $('response-latency').textContent = selected ? selected.latencyMs.toFixed(1) : '—';
    $('response-model').textContent = selected ? typeof selected.payload?.model === 'string' ? selected.payload.model : 'Not returned' : '—';
    $('response-received').textContent = selected ? new Date(selected.receivedAt).toLocaleTimeString() : '—';
    if (selected) $('response-received').dateTime = selected.receivedAt;
    else $('response-received').removeAttribute('datetime');
    $('model-response').textContent = selected
      ? selected.payload === null ? 'Response body unavailable.' : JSON.stringify(selected.payload, null, 2)
      : state.configured ? 'No model responses yet.' : 'Foundry is not configured.';
  }

  function render() {
    const { game, mode, status, stats } = state;
    const running = status === 'running';
    $('score').textContent = String(game.score).padStart(6, '0');
    $('lines').textContent = String(game.lines).padStart(2, '0');
    $('level').textContent = String(game.level).padStart(2, '0');
    $('pieces').textContent = game.pieces;
    $('decisions').textContent = stats.decisions;
    $('model-calls').textContent = stats.modelDecisions;
    $('model-placements').textContent = stats.modelPlacements;
    $('safety-moves').textContent = stats.safetyMoves;
    $('game-state').textContent = ({ ready: 'STANDBY', running: 'IN PLAY', paused: 'PAUSED', gameover: 'GAME OVER' })[status];
    $('game-state').className = `game-state ${status}`;
    $('play-label').textContent = running ? 'Pause game' : status === 'paused' ? (state.error ? 'Retry decision' : 'Resume game') : status === 'gameover' ? 'Play again' : 'Start game';
    $('play-icon').textContent = running ? 'Ⅱ' : '▶';
    const seconds = Math.floor(stats.elapsedMs / 1000);
    $('runtime').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    document.querySelectorAll('[data-mode]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.mode === mode)));
    document.querySelectorAll('[data-speed]').forEach((button) => button.setAttribute('aria-pressed', String(Number(button.dataset.speed) === state.speed)));
    $('config-note').hidden = state.configured;
    $('source-tag').textContent = mode === 'model' ? 'FOUNDRY' : mode === 'demo' ? 'LOCAL' : 'HUMAN';
    $('source-tag').className = `source-tag${mode === 'model' ? ' live' : ''}`;
    $('latency').textContent = stats.lastLatency === null ? '—' : Math.round(stats.lastLatency);
    const p = (value) => value === null ? '—' : Math.round(value);
    for (const id of ['p50', 'p95']) {
      $(id).replaceChildren(document.createTextNode(`${p(stats[id])} `), element('small', '', 'ms'));
    }
    $('latency-live').textContent = mode === 'model' ? state.thinking ? 'MEASURING' : stats.lastLatency !== null ? 'MEASURED' : 'AWAITING API' : stats.lastLatency !== null ? 'LAST LIVE CALL' : 'AWAITING API';
    $('latency-live').className = `latency-live${mode === 'model' && stats.lastLatency !== null ? ' active' : ''}`;
    $('stream-indicator').replaceChildren(element('span', `status-dot${running && mode !== 'manual' ? ' online' : ''}`), document.createTextNode(state.thinking ? ' DECIDING' : running && mode !== 'manual' ? ' LIVE' : ' IDLE'));
    $('touch-controls').hidden = mode !== 'manual';
    $('thinking-indicator').hidden = !state.thinking || !running;
    $('board-overlay').hidden = running;
    if (!running) {
      $('overlay-title').textContent = status === 'ready' ? 'Ready' : status === 'gameover' ? 'Game over' : state.error ? 'Connection error' : 'Paused';
      $('overlay-copy').textContent = state.error || (status === 'gameover' ? `${game.score.toLocaleString()} points · ${game.lines} lines` : '');
      $('overlay-copy').hidden = !$('overlay-copy').textContent;
      $('overlay-start').textContent = status === 'ready' ? 'Start game ↗' : status === 'gameover' ? 'Play again ↗' : state.error ? 'Retry decision ↗' : 'Resume game ↗';
    }
    const drawKey = JSON.stringify([game.board, game.active, state.target, game.next, game.over, status, game.score]);
    if (drawKey !== lastDrawn) {
      lastDrawn = drawKey;
      drawBoard();
      drawNext();
      board.setAttribute('aria-label', `Tetris board. Score ${game.score}, ${game.lines} lines cleared, ${game.pieces} pieces placed. ${status}. Active ${game.active.type}, column ${game.active.x + 1}, row ${game.active.y + 1}.`);
    }
    if (lastPieceId && game.pieceId > lastPieceId && game.lastClear > 0) {
      $('line-flash').classList.remove('flash');
      void $('line-flash').offsetWidth;
      $('line-flash').classList.add('flash');
      $('announcement').textContent = `${game.lastClear} lines cleared. Score ${game.score}.`;
    }
    lastPieceId = game.pieceId;
    const chartKey = `${stats.modelDecisions}:${stats.decisions === 0}`;
    if (chartKey !== lastChartKey) {
      lastChartKey = chartKey;
      if (!stats.decisions) latencyPoints = [];
      else if (stats.lastLatency !== null) latencyPoints.push(stats.lastLatency);
      latencyPoints = latencyPoints.slice(-30);
      drawChart();
    }
    renderHistory();
    renderResponses();
    const statusKey = `${status}:${state.error || ''}`;
    if (statusKey !== lastStatus) {
      lastStatus = statusKey;
      $('announcement').textContent = state.error || `Game ${status}. ${mode === 'model' ? 'Microsoft Decision' : mode === 'demo' ? 'Local demo' : 'Manual'} mode.`;
      if (state.error) showToast(state.error);
    }
    const connectionKey = `${connected}:${state.configured}`;
    if (lastConnectionKey !== connectionKey) {
      lastConnectionKey = connectionKey;
      $('setup-button').title = state.configured ? 'Foundry configured · connection setup' : 'Configure your Foundry connection';
    }
  }

  function focusBoard() { if (state?.mode === 'manual') board.focus({ preventScroll: true }); }
  function togglePlay() { if (state) { send({ type: state.status === 'running' ? 'pause' : 'start' }); focusBoard(); } }
  function openSetup() { if (!$('setup-dialog').open) $('setup-dialog').showModal(); }
  $('play-button').addEventListener('click', togglePlay);
  $('overlay-start').addEventListener('click', () => { send({ type: 'start' }); focusBoard(); });
  $('reset-button').addEventListener('click', () => send({ type: 'reset' }));
  $('response-select').addEventListener('change', () => { if (state) renderResponses(); });
  $('setup-button').addEventListener('click', openSetup);
  $('config-setup').addEventListener('click', openSetup);
  $('close-setup').addEventListener('click', () => $('setup-dialog').close());
  $('setup-dialog').addEventListener('click', (event) => { if (event.target === $('setup-dialog')) { const bounds = event.target.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.target.close(); } });
  document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => {
    if (button.dataset.mode === 'model' && !state?.configured) { openSetup(); return; }
    send({ type: 'mode', mode: button.dataset.mode });
    if (button.dataset.mode === 'manual') board.focus({ preventScroll: true });
  }));
  document.querySelectorAll('[data-speed]').forEach((button) => button.addEventListener('click', () => send({ type: 'speed', speed: Number(button.dataset.speed) })));
  document.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => send({ type: 'input', action: button.dataset.action })));
  window.addEventListener('keydown', (event) => {
    if ($('setup-dialog').open || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
    // Preserve native activation and arrow-key behavior when a control has focus.
    if (event.target.closest('button,a,summary') && [' ', 'Enter'].includes(event.key)) return;
    if (event.key.toLowerCase() === 'p' && !event.repeat) { event.preventDefault(); togglePlay(); return; }
    if (state?.mode !== 'manual' || state?.status !== 'running') return;
    const action = ({ ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'rotate', ArrowDown: 'down', ' ': 'drop', z: 'rotateBack', Z: 'rotateBack' })[event.key];
    if (action) {
      event.preventDefault();
      if (!event.repeat || ['left', 'right', 'down'].includes(action)) send({ type: 'input', action });
    }
  });
  window.addEventListener('pagehide', () => { leaving = true; clearTimeout(retryTimer); cancelAnimationFrame(animationFrame); ws?.close(); });
  window.addEventListener('pageshow', (event) => { if (event.persisted) { leaving = false; connect(); animationFrame = requestAnimationFrame(animate); } });
  drawBoard();
  drawChart();
  connect();
  animationFrame = requestAnimationFrame(animate);
})();
