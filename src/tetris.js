export const WIDTH = 10;
export const HEIGHT = 20;

// Clockwise rotations are generated from the spawn shapes.
const SHAPES = {
  I: [[1, 1, 1, 1]],
  O: [[1, 1], [1, 1]],
  T: [[0, 1, 0], [1, 1, 1]],
  S: [[0, 1, 1], [1, 1, 0]],
  Z: [[1, 1, 0], [0, 1, 1]],
  J: [[1, 0, 0], [1, 1, 1]],
  L: [[0, 0, 1], [1, 1, 1]],
};

export const TYPES = Object.keys(SHAPES);
const ROTATIONS = Object.fromEntries(TYPES.map((type) => {
  let shape = SHAPES[type];
  const rotations = [];
  for (let i = 0; i < 4; i++) {
    rotations.push(Object.freeze(shape.map((row) => Object.freeze([...row]))));
    shape = shape[0].map((_, x) => shape.map((row) => row[x]).reverse());
  }
  return [type, Object.freeze(rotations)];
}));
export function shapeFor(type, rotation = 0) { return ROTATIONS[type][((rotation % 4) + 4) % 4]; }

export function fits(board, piece) {
  const shape = shapeFor(piece.type, piece.rotation);
  return shape.every((row, y) => row.every((cell, x) => !cell || (
    piece.x + x >= 0 && piece.x + x < WIDTH && piece.y + y >= 0 &&
    piece.y + y < HEIGHT && !board[piece.y + y][piece.x + x]
  )));
}

export function transform(board, piece, action) {
  const next = { ...piece };
  if (action === 'left') next.x--;
  else if (action === 'right') next.x++;
  else if (action === 'down') next.y++;
  else if (action === 'rotate' || action === 'rotateBack') {
    next.rotation = (next.rotation + (action === 'rotate' ? 1 : 3)) % 4;
    // Small horizontal wall kicks; this demo deliberately uses a compact ruleset.
    for (const kick of [0, -1, 1, -2, 2]) {
      const kicked = { ...next, x: next.x + kick };
      if (fits(board, kicked)) return kicked;
    }
    return null;
  } else return null;
  return fits(board, next) ? next : null;
}

export function landing(board, piece) {
  let result = { ...piece };
  while (fits(board, { ...result, y: result.y + 1 })) result.y++;
  return result;
}

export function placementKey(piece) {
  return shapeFor(piece.type, piece.rotation).flatMap((row, y) =>
    row.flatMap((cell, x) => cell ? [`${piece.x + x},${piece.y + y}`] : [])).sort().join('|');
}

export function reachablePlacement(board, piece, target) {
  if (!fits(board, piece)) return null;
  const key = placementKey(target);
  const queue = [{ piece, path: [] }];
  const visited = new Set();
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    const poseKey = `${current.piece.x}:${current.piece.rotation}`;
    if (visited.has(poseKey)) continue;
    visited.add(poseKey);
    const dropped = landing(board, current.piece);
    if (placementKey(dropped) === key) return { target: dropped, path: current.path };
    for (const action of ['left', 'right', 'rotate']) {
      const next = transform(board, current.piece, action);
      if (next && !visited.has(`${next.x}:${next.rotation}`)) queue.push({ piece: next, path: [...current.path, action] });
    }
  }
  return null;
}

export function place(board, piece) {
  const result = board.map((row) => [...row]);
  shapeFor(piece.type, piece.rotation).forEach((row, y) => row.forEach((cell, x) => {
    if (cell) result[piece.y + y][piece.x + x] = piece.type;
  }));
  const remaining = result.filter((row) => row.some((cell) => !cell));
  const lines = HEIGHT - remaining.length;
  while (remaining.length < HEIGHT) remaining.unshift(Array(WIDTH).fill(null));
  return { board: remaining, lines };
}

export function boardMetrics(board) {
  const heights = Array(WIDTH).fill(0);
  let holes = 0;
  for (let x = 0; x < WIDTH; x++) {
    let covered = false;
    for (let y = 0; y < HEIGHT; y++) {
      if (board[y][x]) {
        if (!covered) heights[x] = HEIGHT - y;
        covered = true;
      } else if (covered) holes++;
    }
  }
  return {
    holes,
    aggregateHeight: heights.reduce((sum, height) => sum + height, 0),
    maxHeight: Math.max(...heights),
    bumpiness: heights.slice(1).reduce((sum, height, i) => sum + Math.abs(height - heights[i]), 0),
  };
}

export function enumeratePlacements(board, piece) {
  if (!fits(board, piece)) return [];
  const queue = [{ piece: { ...piece }, path: [] }];
  const visited = new Set();
  const placements = new Map();
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    const key = `${current.piece.x}:${current.piece.rotation}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const target = landing(board, current.piece);
    const cells = placementKey(target);
    if (!placements.has(cells)) {
      const outcome = place(board, target);
      const metrics = { ...boardMetrics(outcome.board), lines: outcome.lines };
      const value = metrics.lines * 8 - metrics.holes * 6.5 - metrics.aggregateHeight * 0.45
        - metrics.bumpiness * 0.32 - Math.max(0, metrics.maxHeight - 12) * 3;
      placements.set(cells, { target, path: current.path, metrics, value });
    }
    for (const action of ['left', 'right', 'rotate']) {
      const next = transform(board, current.piece, action);
      if (next && !visited.has(`${next.x}:${next.rotation}`)) {
        queue.push({ piece: next, path: [...current.path, action] });
      }
    }
  }
  return [...placements.values()].sort((a, b) => b.value - a.value)
    .map((candidate, index) => ({ ...candidate, id: `move_${index + 1}` }));
}

export class Tetris {
  constructor(random = Math.random) {
    this.random = random;
    this.board = Array.from({ length: HEIGHT }, () => Array(WIDTH).fill(null));
    this.bag = [];
    this.next = Array.from({ length: 5 }, () => this.draw());
    this.score = 0;
    this.lines = 0;
    this.pieces = 0;
    this.pieceId = 0;
    this.over = false;
    this.lastClear = 0;
    this.spawn();
  }

  draw() {
    if (!this.bag.length) {
      this.bag = [...TYPES];
      for (let i = this.bag.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
      }
    }
    return this.bag.pop();
  }

  get level() { return Math.floor(this.lines / 10) + 1; }

  spawn() {
    const type = this.next.shift();
    this.next.push(this.draw());
    this.active = { type, rotation: 0, x: Math.floor((WIDTH - shapeFor(type)[0].length) / 2), y: 0 };
    this.pieceId++;
    if (!fits(this.board, this.active)) this.over = true;
  }

  move(action) {
    if (this.over) return false;
    const next = transform(this.board, this.active, action);
    if (next) this.active = next;
    return Boolean(next);
  }

  lock() {
    const outcome = place(this.board, this.active);
    this.board = outcome.board;
    this.lastClear = outcome.lines;
    this.score += [0, 100, 300, 500, 800][outcome.lines] * this.level;
    this.lines += outcome.lines;
    this.pieces++;
    this.spawn();
  }

  softDrop() {
    if (this.over) return;
    if (!this.move('down')) this.lock();
  }

  hardDrop() {
    if (this.over) return;
    const target = landing(this.board, this.active);
    this.score += (target.y - this.active.y) * 2;
    this.active = target;
    this.lock();
  }

  snapshot() {
    return {
      board: this.board,
      active: this.active,
      ghost: this.over ? null : landing(this.board, this.active),
      next: this.next,
      score: this.score,
      lines: this.lines,
      level: this.level,
      pieces: this.pieces,
      pieceId: this.pieceId,
      over: this.over,
      lastClear: this.lastClear,
    };
  }
}
