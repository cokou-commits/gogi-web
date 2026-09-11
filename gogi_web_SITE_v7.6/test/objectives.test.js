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

test('15種類の秘密目標に達成判定がある', () => {
  assert.equal(OBJECTIVES.length, 15);
  assert.equal(new Set(OBJECTIVES.map(o => o.key)).size, 15);

  {
    const {room,p,others}=setupObjective('observer');
    p.stats.scoutedTargets=others.map(x=>x.playerId);
    assert.equal(objectiveAchieved(room,p),true);
  }
  {
    const {room,p,others}=setupObjective('tracker');
    p.stats.scoutCounts[others[0].playerId]=2;
    assert.equal(objectiveAchieved(room,p),true);
  }
  {
    const {room,p}=setupObjective('gambler');
    p.stats.successfulAccusations=1; p.stats.scoutedTargets=[];
    assert.equal(objectiveAchieved(room,p),true);
  }
  {
    const {room,p}=setupObjective('giver');
    p.stats.pointTransfers=1;
    assert.equal(objectiveAchieved(room,p),true);
  }
  {
    const {room,p}=setupObjective('killer');
    p.stats.consecutiveAttackTurns=3;
    assert.equal(objectiveAchieved(room,p),true);
  }
  {
    const {room,p,others}=setupObjective('reaper');
    p.stats.attackTargets=[others[0].playerId,others[0].playerId];
    assert.equal(objectiveAchieved(room,p),false, '死神は最終ターンまで確定しない');
    room.turn=15;
    assert.equal(objectiveAchieved(room,p),true);
  }
  {
    const {room,p}=setupObjective('executioner');
    p.stats.soloKills=1;
    assert.equal(objectiveAchieved(room,p),true);
  }
  {
    const {room,p}=setupObjective('accomplice');
    p.stats.jointKills=2;
    assert.equal(objectiveAchieved(room,p),true);
  }
  {
    const {room,p,others}=setupObjective('avenger');
    p.stats.attackedBy=[others[0].playerId]; p.stats.killTargets=[others[0].playerId];
    assert.equal(objectiveAchieved(room,p),true);
  }
  {
    const {room,p}=setupObjective('ironWall');
    p.stats.defenseSuccessTurns=3;
    assert.equal(objectiveAchieved(room,p),true);
  }
  {
    const {room,p}=setupObjective('nearDeath');
    room.turn=15; p.alive=true; p.hp=1;
    assert.equal(objectiveAchieved(room,p),true);
  }
  {
    const {room,p}=setupObjective('endurer');
    p.stats.damageTaken=4;
    assert.equal(objectiveAchieved(room,p),true);
  }
  {
    const {room,p}=setupObjective('hermit');
    room.turn=15; p.alive=true; p.stats.specialsUsed=0;
    assert.equal(objectiveAchieved(room,p),true);
  }
  {
    const {room,p}=setupObjective('liar');
    for(let t=1;t<=5;t++) p.secretState.infoByTurn[t]=[false,false];
    assert.equal(objectiveAchieved(room,p),true);
  }
  {
    const {room,p}=setupObjective('honest');
    for(let t=1;t<=5;t++) p.secretState.infoByTurn[t]=[true,true];
    assert.equal(objectiveAchieved(room,p),true);
  }
});
