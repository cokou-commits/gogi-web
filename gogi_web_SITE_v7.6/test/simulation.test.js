'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRoom, createPlayer, startGame, resolveTurn, awardSurvivalBonus, buildRanking } = require('../src/engine');

test('5人×15ターンを最後まで処理できる', () => {
  const room = createRoom();
  for (let i = 0; i < 5; i++) room.players.push(createPlayer());
  startGame(room, () => 0.271828);

  for (let turn = 1; turn <= 15; turn++) {
    room.turn = turn;
    room.phase = 'action';
    for (const p of room.players) {
      if (!p.alive) continue;
      p.draft = {
        normal: p.hand.defense > 0 ? 'defense' : null,
        special: null,
        normalTargetId: null,
        secondNormalTargetId: null,
        specialTargetId: null,
        accusationGuess: null,
        secondAccusationGuess: null,
        stealAmount: 5,
        specifiedType: null
      };
    }
    assert.doesNotThrow(() => resolveTurn(room));
  }

  awardSurvivalBonus(room);
  const ranking = buildRanking(room);
  assert.equal(ranking.length, 5);
  assert.ok(ranking.every(r => Number.isInteger(r.rank) && Number.isFinite(r.points)));
});
