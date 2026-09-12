'use strict';

const assert = require('node:assert/strict');
const {
  createRoom, createPlayer, startGame, resolveTurn, validateDraft, emptyDraft,
  awardTurnStartBonus, awardSurvivalBonus, canPlaceWinnerBet, placeWinnerBet,
  settleWinnerBets, buildRanking
} = require('../src/engine');
const { NORMAL_CARDS, SPECIAL_CARDS, OBJECTIVES, MAX_TURNS, MAX_PLAYERS, WINNER_BET } = require('../src/rules');

const games = Number.parseInt(process.env.GOGI_STRESS_GAMES || '100000', 10);
if (!Number.isInteger(games) || games < 1 || games > 100000) {
  throw new Error('GOGI_STRESS_GAMES は1〜100000の整数にしてください。');
}

function rngFactory(seed) {
  let x = seed >>> 0;
  return () => { x = (1664525 * x + 1013904223) >>> 0; return x / 0x100000000; };
}
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
function check(room) {
  assert.equal(room.players.length, MAX_PLAYERS);
  const objectiveKeys = room.players.map(p => p.objective?.key).filter(Boolean);
  assert.equal(objectiveKeys.length, MAX_PLAYERS);
  const validObjectiveKeys = new Set(OBJECTIVES.map(objective => objective.key));
  for (const key of objectiveKeys) assert.ok(validObjectiveKeys.has(key));
  for (const p of room.players) {
    assert.ok(Number.isInteger(p.hp) && p.hp >= 0 && p.hp <= 5);
    assert.ok(Number.isFinite(p.points) && Number.isInteger(p.points * 2), `points must be on 0.5P grid: ${p.points}`);
    assert.equal(p.alive, p.hp > 0);
    for (const n of Object.values(p.hand)) assert.ok(Number.isInteger(n) && n >= 0);
    for (const n of Object.values(p.specials)) assert.ok(Number.isInteger(n) && n >= 0);
    if (p.winnerBet) {
      assert.ok(WINNER_BET.allowedTurns.includes(p.winnerBet.placedTurn));
      assert.ok(Number.isInteger(p.winnerBet.amount) && p.winnerBet.amount >= WINNER_BET.step && p.winnerBet.amount % WINNER_BET.step === 0);
      assert.equal(p.winnerBet.multiplier, WINNER_BET.multipliers[p.winnerBet.placedTurn]);
    }
  }
}
function randomDraft(room, p, rng) {
  const d = emptyDraft();
  d.normal = pick(rng, [null, ...Object.keys(NORMAL_CARDS).filter(k => p.hand[k] > 0)]);
  d.special = pick(rng, [null, ...Object.keys(SPECIAL_CARDS).filter(k => p.specials[k] > 0)]);
  if (d.special === 'double' && !d.normal) d.special = null;
  const others = room.players.filter(x => x.alive && x.playerId !== p.playerId);
  const allOthers = room.players.filter(x => x.playerId !== p.playerId);
  const alive = room.players.filter(x => x.alive);
  if (d.normal === 'attack' && others.length) d.normalTargetId = pick(rng, others).playerId;
  if (['scout','accusation'].includes(d.normal) && allOthers.length) d.normalTargetId = pick(rng, allOthers).playerId;
  if (['defense','heal'].includes(d.normal) && alive.length) d.normalTargetId = pick(rng, alive).playerId;
  if (d.normal === 'accusation') d.accusationGuess = pick(rng, OBJECTIVES).key;
  if (['cancel','specify','steal'].includes(d.special) && others.length) d.specialTargetId = pick(rng, others).playerId;
  if (d.special === 'specify') d.specifiedType = pick(rng, Object.keys(NORMAL_CARDS));
  if (d.special === 'steal') d.stealAmount = pick(rng, [5,10,15,20,25]);
  if (d.special === 'double' && d.normal === 'attack' && others.length && rng() < 0.7) {
    d.secondNormalTargetId = pick(rng, others).playerId;
  }
  if (d.special === 'double' && d.normal === 'scout' && allOthers.length > 1 && rng() < 0.7) {
    d.secondNormalTargetId = pick(rng, allOthers.filter(t => t.playerId !== d.normalTargetId)).playerId;
  }
  if (d.special === 'double' && d.normal === 'accusation' && allOthers.length && rng() < 0.7) {
    d.secondNormalTargetId = pick(rng, allOthers).playerId;
    d.secondAccusationGuess = pick(rng, OBJECTIVES).key;
  }
  const validated = validateDraft(room, p, d, { strict: true });
  return validated.ok ? validated.draft : emptyDraft();
}
function maybePlaceWinnerBets(room, rng) {
  if (!WINNER_BET.allowedTurns.includes(room.turn)) return;
  for (const p of room.players) {
    if (!canPlaceWinnerBet(room, p) || p.points < WINNER_BET.step || rng() >= 0.35) continue;
    const target = pick(rng, room.players);
    const maxUnits = Math.floor(p.points / WINNER_BET.step);
    if (maxUnits < 1) continue;
    const units = 1 + Math.floor(rng() * maxUnits);
    const amount = units * WINNER_BET.step;
    const placed = placeWinnerBet(room, p, target.playerId, amount);
    assert.equal(placed.ok, true);
  }
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
    room.phase = 'chat';
    awardTurnStartBonus(room);
    maybePlaceWinnerBets(room, rng);
    for (const p of room.players) if (p.alive) p.draft = randomDraft(room, p, rng);
    resolveTurn(room);
    check(room);
  }
  awardSurvivalBonus(room);
  const preBetRanking = buildRanking(room);
  assert.equal(preBetRanking.length, MAX_PLAYERS);
  settleWinnerBets(room, preBetRanking);
  const finalRanking = buildRanking(room);
  assert.equal(finalRanking.length, MAX_PLAYERS);
  for (const row of finalRanking) {
    assert.ok(Number.isInteger(row.rank) && row.rank >= 1 && row.rank <= MAX_PLAYERS);
    assert.ok(Number.isFinite(row.points) && Number.isInteger(row.points * 2));
  }
  check(room);
}
console.log(`${games} games x ${MAX_TURNS} turns + bonuses/bets/final ranking: OK (${Date.now() - started} ms)`);
