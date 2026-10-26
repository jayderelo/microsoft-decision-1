import test from 'node:test';
import assert from 'node:assert/strict';
import { Tetris, WIDTH, HEIGHT, enumeratePlacements, fits, landing, place, transform, boardMetrics, reachablePlacement, placementKey } from '../src/tetris.js';

function seeded(seed) {
  return () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

test('every candidate is reachable and predicts the actual board after locking', () => {
  const game = new Tetris(seeded(42));
  let clears = 0;
  for (let piece = 0; piece < 250 && !game.over; piece++) {
    const candidates = enumeratePlacements(game.board, game.active);
    assert.ok(candidates.length > 0);
    for (const candidate of candidates) {
      let pose = { ...game.active };
      for (const action of candidate.path) {
        pose = transform(game.board, pose, action);
        assert.ok(pose, 'each path action must be collision free');
      }
      assert.deepEqual(landing(game.board, pose), candidate.target);
      if (piece < 30) {
        const route = reachablePlacement(game.board, game.active, candidate.target);
        assert.ok(route, 'the fast path search must preserve every simulated reachable placement');
        let replay = { ...game.active };
        for (const action of route.path) {
          replay = transform(game.board, replay, action);
          assert.ok(replay);
        }
        assert.equal(placementKey(landing(game.board, replay)), placementKey(candidate.target));
      }
      assert.ok(fits(game.board, candidate.target));
      assert.equal(fits(game.board, { ...candidate.target, y: candidate.target.y + 1 }), false);
      const predicted = place(game.board, candidate.target);
      assert.deepEqual({ ...boardMetrics(predicted.board), lines: predicted.lines }, candidate.metrics);
    }
    const chosen = candidates[0];
    const predicted = place(game.board, chosen.target);
    const occupied = game.board.flat().filter(Boolean).length;
    chosen.path.forEach((action) => assert.ok(game.move(action)));
    game.hardDrop();
    assert.deepEqual(game.board, predicted.board);
    assert.equal(game.board.flat().filter(Boolean).length, occupied + 4 - predicted.lines * WIDTH);
    assert.equal(game.board.length, HEIGHT);
    assert.ok(game.board.every((row) => row.length === WIDTH));
    clears += predicted.lines;
  }
  assert.ok(clears > 20, 'long-running local play should clear lines');
});

test('four-line clear compacts the board and scores using the current level', () => {
  const game = new Tetris(seeded(7));
  for (let y = HEIGHT - 4; y < HEIGHT; y++) game.board[y] = Array.from({ length: WIDTH }, (_, x) => x === 9 ? null : 'J');
  game.active = { type: 'I', rotation: 1, x: 9, y: 0 };
  game.lines = 9;
  game.hardDrop();
  assert.equal(game.lastClear, 4);
  assert.equal(game.lines, 13);
  assert.equal(game.level, 2);
  assert.equal(game.score, 832);
  assert.equal(game.pieces, 1);
  assert.ok(game.board.flat().every((cell) => cell === null));
});

test('top-out prevents subsequent moves and drops from changing the board', () => {
  const game = new Tetris();
  game.board[0].fill('Z');
  game.spawn();
  assert.equal(game.over, true);
  assert.deepEqual(enumeratePlacements(game.board, game.active), []);
  const before = structuredClone(game.snapshot());
  assert.equal(game.move('left'), false);
  game.hardDrop();
  game.softDrop();
  assert.deepEqual(game.snapshot(), before);
});

test('a constrained board never offers colliding or unreachable placements', () => {
  const game = new Tetris();
  game.active = { type: 'O', rotation: 0, x: 4, y: 0 };
  for (let y = 0; y < HEIGHT; y++) {
    game.board[y] = Array.from({ length: WIDTH }, (_, x) => x === 4 || x === 5 ? null : 'L');
  }
  const candidates = enumeratePlacements(game.board, game.active);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].target, { type: 'O', rotation: 0, x: 4, y: 18 });
});
