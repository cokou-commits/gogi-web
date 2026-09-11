'use strict';

const assert = require('node:assert/strict');
const { createRoom, createPlayer, startGame, resolveTurn, validateDraft, emptyDraft } = require('../src/engine');
const { NORMAL_CARDS, SPECIAL_CARDS, OBJECTIVES, MAX_TURNS, MAX_PLAYERS } = require('../src/rules');

const games = Number.parseInt(process.env.GOGI_STRESS_GAMES || '10000', 10);
if (!Number.isInteger(games) || games < 1 || games > 100000) {
  throw new Error('GOGI_STRESS_GAMES は1〜100000の整数にしてください。');
}

function rngFactory(seed) {
  let x = seed >>> 0;
  return () => { x = (1664525 * x + 1013904223) >>> 0; return x / 0x100000000; };
}
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
function check(room) {
  for (const p of room.players) {
    assert.ok(Number.isInteger(p.hp) && p.hp >= 0 && p.hp <= 5);
    assert.ok(Number.isInteger(p.points) && Number.isFinite(p.points));
    assert.equal(p.alive, p.hp > 0);
    for (const n of Object.values(p.hand)) assert.ok(Number.isInteger(n) && n >= 0);
    for (const n of Object.values(p.specials)) assert.ok(Number.isInteger(n) && n >= 0);
  }
}
function randomDraft(room, p, rng) {
  const d = emptyDraft();
  d.normal = pick(rng, [null, ...Object.keys(NORMAL_CARDS).filter(k => p.hand[k] > 0)]);
  d.special = pick(rng, [null, ...Object.keys(SPECIAL_CARDS).filter(k => p.specials[k] > 0)]);
  if (d.special === 'double' && !d.normal) d.special = null;
  const targets = room.players.filter(x => x.alive && x.playerId !== p.playerId);
  if (['attack','scout','accusation'].includes(d.normal) && targets.length) d.normalTargetId = pick(rng, targets).playerId;
  if (d.normal === 'accusation') d.accusationGuess = pick(rng, OBJECTIVES).key;
  if (['cancel','specify','steal'].includes(d.special) && targets.length) d.specialTargetId = pick(rng, targets).playerId;
  if (d.special === 'specify') d.specifiedType = pick(rng, Object.keys(NORMAL_CARDS));
  if (d.special === 'steal') d.stealAmount = pick(rng, [5,10,15,20,25]);
  if (d.special === 'double' && d.normal === 'scout' && targets.length > 1 && rng() < 0.7) {
    d.secondNormalTargetId = pick(rng, targets.filter(t => t.playerId !== d.normalTargetId)).playerId;
  }
  if (d.special === 'double' && d.normal === 'accusation' && targets.length && rng() < 0.7) {
    d.secondNormalTargetId = pick(rng, targets).playerId;
    d.secondAccusationGuess = pick(rng, OBJECTIVES).key;
  }
  const validated = validateDraft(room, p, d, { strict: true });
  return validated.ok ? validated.draft : emptyDraft();
}

const started = Date.now();
for (let game = 1; game <= games; game++) {
  const rng = rngFactory((0x9E3779B9 + game) >>> 0);
  const room = createRoom();
  for (let i = 0; i < MAX_PLAYERS; i++) room.players.push(createPlayer());
  startGame(room, rng);
  check(room);
  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    room.turn = turn;
    room.phase = 'action';
    for (const p of room.players) if (p.alive) p.draft = randomDraft(room, p, rng);
    resolveTurn(room);
    check(room);
  }
}
console.log(`${games} games x ${MAX_TURNS} turns: OK (${Date.now() - started} ms)`);
