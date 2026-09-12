'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRoom, createPlayer, startGame, objectiveAchieved } = require('../src/engine');
const { OBJECTIVES } = require('../src/rules');

function setupObjective(key) {
  const room = createRoom();
  for (let i = 0; i < 5; i++) room.players.push(createPlayer());
  startGame(room, () => 0.4242);
  const p = room.players[0];
  p.objective = OBJECTIVES.find(o => o.key === key);
  return { room, p, others: room.players.slice(1) };
}

test('秘密目標は新仕様の10種類だけ', () => {
  assert.equal(OBJECTIVES.length, 10);
  assert.equal(new Set(OBJECTIVES.map(o => o.key)).size, 10);
  assert.deepEqual(OBJECTIVES.map(o => o.key), [
    'observer','tracker','gambler','killer','reaper','ironWall','endurer','nearDeath','unguarded','hermit'
  ]);
});

test('観察者は3ターン連続偵察で達成', () => {
  const {room,p}=setupObjective('observer');
  p.stats.consecutiveScoutTurns=2;
  assert.equal(objectiveAchieved(room,p),false);
  p.stats.consecutiveScoutTurns=3;
  assert.equal(objectiveAchieved(room,p),true);
});

test('追跡者は同じ1人を5回偵察で達成', () => {
  const {room,p,others}=setupObjective('tracker');
  p.stats.scoutCounts[others[0].playerId]=4;
  assert.equal(objectiveAchieved(room,p),false);
  p.stats.scoutCounts[others[0].playerId]=5;
  assert.equal(objectiveAchieved(room,p),true);
});

test('賭け師は未偵察の告発相手への告発成功で達成', () => {
  const {room,p}=setupObjective('gambler');
  p.stats.unscoutedAccusationSuccesses=0;
  assert.equal(objectiveAchieved(room,p),false);
  p.stats.unscoutedAccusationSuccesses=1;
  assert.equal(objectiveAchieved(room,p),true);
});

test('殺人鬼は3ターン連続攻撃で達成', () => {
  const {room,p}=setupObjective('killer');
  p.stats.consecutiveAttackTurns=2;
  assert.equal(objectiveAchieved(room,p),false);
  p.stats.consecutiveAttackTurns=3;
  assert.equal(objectiveAchieved(room,p),true);
});

test('死神は同じ1人を5回攻撃で達成し他人への攻撃を禁止しない', () => {
  const {room,p,others}=setupObjective('reaper');
  p.stats.attackTargets=[others[0].playerId, others[1].playerId, others[0].playerId, others[0].playerId, others[0].playerId];
  assert.equal(objectiveAchieved(room,p),false);
  p.stats.attackTargets.push(others[0].playerId);
  assert.equal(objectiveAchieved(room,p),true);
});

test('鉄壁は防御成功3回で達成', () => {
  const {room,p}=setupObjective('ironWall');
  p.stats.defenseSuccessTurns=2;
  assert.equal(objectiveAchieved(room,p),false);
  p.stats.defenseSuccessTurns=3;
  assert.equal(objectiveAchieved(room,p),true);
});

test('瀕死は累計5ダメージ以上を受けて生存で達成', () => {
  const {room,p}=setupObjective('nearDeath');
  p.stats.damageTaken=5; p.alive=true;
  assert.equal(objectiveAchieved(room,p),true);
  p.alive=false;
  assert.equal(objectiveAchieved(room,p),false);
});

for (const [key, stat] of [['endurer','healsUsed'], ['unguarded','defensesUsed'], ['hermit','specialsUsed']]) {
  test(`${key}系の未使用目標は第15ターン生存または何ターン目でも未使用のまま脱落で達成`, () => {
    const {room,p}=setupObjective(key);
    p.stats[stat]=0;
    room.turn=14; p.alive=true;
    assert.equal(objectiveAchieved(room,p),false);
    room.turn=15;
    assert.equal(objectiveAchieved(room,p),true);
    p.alive=false; p.stats.eliminatedTurn=1;
    assert.equal(objectiveAchieved(room,p),true);
    p.stats[stat]=1;
    assert.equal(objectiveAchieved(room,p),false);
  });
}
