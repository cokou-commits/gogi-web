'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRoom, createPlayer, startGame, resolveTurn, validateDraft, emptyDraft } = require('../src/engine');
const { NORMAL_CARDS, SPECIAL_CARDS, OBJECTIVES } = require('../src/rules');

function rngFactory(seed) {
  let x = seed >>> 0;
  return () => { x = (1664525 * x + 1013904223) >>> 0; return x / 0x100000000; };
}
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

function checkInvariants(room) {
  for (const p of room.players) {
    assert.ok(Number.isInteger(p.hp) && p.hp >= 0 && p.hp <= 5, 'HP範囲');
    assert.ok(Number.isInteger(p.points) && Number.isFinite(p.points), 'ポイント整数');
    assert.equal(p.alive, p.hp > 0, 'aliveとHPの整合');
    for (const n of Object.values(p.hand)) assert.ok(Number.isInteger(n) && n >= 0, '通常カード非負整数');
    for (const n of Object.values(p.specials)) assert.ok(Number.isInteger(n) && n >= 0, '特殊カード非負整数');
  }
}

function randomValidDraft(room, p, rng) {
  let d = emptyDraft();
  const normalCandidates = [null, ...Object.keys(NORMAL_CARDS).filter(k => p.hand[k] > 0)];
  const specialCandidates = [null, ...Object.keys(SPECIAL_CARDS).filter(k => p.specials[k] > 0)];
  d.normal = pick(rng, normalCandidates);
  d.special = pick(rng, specialCandidates);
  if (d.special === 'double' && !d.normal) d.special = null;
  const targets = room.players.filter(x => x.alive && x.playerId !== p.playerId);
  if (['attack','scout','accusation'].includes(d.normal) && targets.length) {
    d.normalTargetId = pick(rng, targets).playerId;
  }
  if (d.normal === 'accusation') d.accusationGuess = pick(rng, OBJECTIVES).key;
  if (['cancel','specify','steal'].includes(d.special) && targets.length) d.specialTargetId = pick(rng, targets).playerId;
  if (d.special === 'specify') d.specifiedType = pick(rng, Object.keys(NORMAL_CARDS));
  if (d.special === 'steal') d.stealAmount = pick(rng, [5,10,15,20,25]);
  if (d.special === 'double' && d.normal === 'scout' && targets.length > 1 && rng() < 0.7) {
    const second = pick(rng, targets.filter(t => t.playerId !== d.normalTargetId));
    d.secondNormalTargetId = second.playerId;
  }
  if (d.special === 'double' && d.normal === 'accusation' && targets.length && rng() < 0.7) {
    const second = pick(rng, targets);
    d.secondNormalTargetId = second.playerId;
    d.secondAccusationGuess = pick(rng, OBJECTIVES).key;
  }
  const v = validateDraft(room, p, d, { strict:true });
  return v.ok ? v.draft : emptyDraft();
}

test('決定的ランダム100試合で15ターン処理して状態不変条件を壊さない', () => {
  for (let game = 1; game <= 100; game++) {
    const rng = rngFactory(0xC0FFEE + game);
    const room = createRoom();
    for (let i = 0; i < 5; i++) room.players.push(createPlayer());
    startGame(room, rng);
    checkInvariants(room);
    for (let turn = 1; turn <= 15; turn++) {
      room.turn = turn;
      room.phase = 'action';
      for (const p of room.players) {
        if (!p.alive) continue;
        p.draft = randomValidDraft(room, p, rng);
      }
      assert.doesNotThrow(() => resolveTurn(room), `game=${game}, turn=${turn}`);
      checkInvariants(room);
    }
  }
});
