'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createRoom, createPlayer, startGame, resolveTurn, awardTurnStartBonus, awardSurvivalBonus,
  buildRanking, currentPointsStanding, canPlaceWinnerBet, placeWinnerBet, settleWinnerBets, randomRoomCode, ensureSecretObjectives
} = require('../src/engine');
const { NORMAL_CARDS, SPECIAL_CARDS, OBJECTIVES, ROOM_CODE_LENGTH, ROOM_CODE_ALPHABET } = require('../src/rules');

function setup() {
  const room = createRoom();
  for (let i = 0; i < 5; i++) room.players.push(createPlayer());
  startGame(room, () => 0.314159);
  room.phase = 'action';
  return room;
}
function clearDrafts(room) {
  for (const p of room.players) {
    p.draft = {
      normal:null, special:null, normalTargetId:null, secondNormalTargetId:null,
      specialTargetId:null, accusationGuess:null, secondAccusationGuess:null,
      stealAmount:5, specifiedType:null
    };
  }
}



test('プライベートルームコードは8文字・曖昧文字なし・暗号学的乱数で生成される', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const code = randomRoomCode();
    assert.equal(code.length, ROOM_CODE_LENGTH);
    for (const ch of code) assert.ok(ROOM_CODE_ALPHABET.includes(ch), `不正文字: ${ch}`);
    seen.add(code);
  }
  assert.ok(seen.size > 190, '異常に重複が多い');
});

test('初期状態は5人・HP5・0P・正式手札・特殊1枚', () => {
  const room = setup();
  assert.equal(room.players.length, 5);
  for (const p of room.players) {
    assert.equal(p.hp, 5);
    assert.equal(p.points, 0);
    for (const [key, def] of Object.entries(NORMAL_CARDS)) assert.equal(p.hand[key], def.initial);
    assert.equal(Object.values(p.specials).reduce((a,b) => a+b, 0), 1);
    assert.ok(p.objective);
  }
  assert.equal(new Set(room.players.flatMap(p => Object.entries(p.specials).filter(([,n]) => n).map(([k]) => k))).size, 5);
});

test('通常カードと無効カードは別々の対象を指定できる', () => {
  const room = setup(); clearDrafts(room);
  const [a,b,c] = room.players;
  a.specials.cancel = 1;
  a.draft = { ...a.draft, normal:'attack', normalTargetId:b.playerId, special:'cancel', specialTargetId:c.playerId };
  c.draft = { ...c.draft, normal:'attack', normalTargetId:a.playerId };
  resolveTurn(room);
  assert.equal(b.hp, 4, 'Aの通常攻撃はBへ通る');
  assert.equal(a.hp, 5, 'Cの攻撃はAの無効で止まる');
});

test('2倍攻撃は通常防御1枚を突破して1ダメージ', () => {
  const room = setup(); clearDrafts(room);
  const [a,b] = room.players;
  a.specials.double = 1;
  a.draft = { ...a.draft, normal:'attack', normalTargetId:b.playerId, special:'double' };
  b.draft = { ...b.draft, normal:'defense' };
  resolveTurn(room);
  assert.equal(b.hp, 4);
  assert.equal(a.points, 10);
});

test('2倍攻撃は2回目を別対象へ指定できる', () => {
  const room = setup(); clearDrafts(room);
  const [a,b,c] = room.players;
  a.specials.double = 1;
  a.draft = { ...a.draft, normal:'attack', normalTargetId:b.playerId, secondNormalTargetId:c.playerId, special:'double' };
  resolveTurn(room);
  assert.equal(b.hp, 4);
  assert.equal(c.hp, 4);
  assert.equal(a.points, 20);
});

test('2倍攻撃を同じ相手へ2回当てても攻撃成功得点は1回分', () => {
  const room = setup(); clearDrafts(room);
  const [a,b] = room.players;
  a.specials.double = 1;
  a.draft = { ...a.draft, normal:'attack', normalTargetId:b.playerId, secondNormalTargetId:b.playerId, special:'double' };
  resolveTurn(room);
  assert.equal(b.hp, 3);
  assert.equal(a.points, 10);
});

test('通常防御で1以上防ぐと防御成功+10P', () => {
  const room = setup(); clearDrafts(room);
  const [attacker, defender] = room.players;
  attacker.draft = { ...attacker.draft, normal:'attack', normalTargetId:defender.playerId };
  defender.draft = { ...defender.draft, normal:'defense' };
  resolveTurn(room);
  assert.equal(defender.hp, 5);
  assert.equal(defender.points, 10);
  assert.equal(defender.stats.defenseSuccessTurns, 1);
});

test('第15ターンの防御成功は2倍で+20P', () => {
  const room = setup(); clearDrafts(room);
  room.turn = 15;
  for (const p of room.players) p.secretState.invalid = true;
  const [attacker, defender] = room.players;
  attacker.draft = { ...attacker.draft, normal:'attack', normalTargetId:defender.playerId };
  defender.draft = { ...defender.draft, normal:'defense' };
  resolveTurn(room);
  assert.equal(defender.points, 20);
});

test('キルは記録するが単独・共同キルの追加得点はない', () => {
  const room = setup(); clearDrafts(room);
  const [attacker, target] = room.players;
  target.hp = 1;
  attacker.draft = { ...attacker.draft, normal:'attack', normalTargetId:target.playerId };
  resolveTurn(room);
  assert.equal(target.alive, false);
  assert.equal(attacker.points, 10, '攻撃成功+10Pのみ');
  assert.equal(attacker.stats.soloKills, 1);
});

test('完全防御は全攻撃を防ぎ攻撃者人数×5P', () => {
  const room = setup(); clearDrafts(room);
  const [a,b,c] = room.players;
  b.specials.fullDefense = 1;
  a.draft = { ...a.draft, normal:'attack', normalTargetId:b.playerId };
  c.draft = { ...c.draft, normal:'attack', normalTargetId:b.playerId };
  b.draft = { ...b.draft, special:'fullDefense' };
  resolveTurn(room);
  assert.equal(b.hp, 5);
  assert.equal(b.points, 10);
  assert.equal(a.points, 0);
  assert.equal(c.points, 0);
});

test('ポイント泥棒は相手の所持Pを超えて奪わない', () => {
  const room = setup(); clearDrafts(room);
  const [a,b] = room.players;
  a.specials.steal = 1;
  b.points = 10;
  a.draft = { ...a.draft, special:'steal', specialTargetId:b.playerId, stealAmount:25 };
  resolveTurn(room);
  assert.equal(a.points, 10);
  assert.equal(b.points, 0);
});

test('偵察はHP・キル・通常カードだけを返し、特殊・ポイント・秘密目標は返さない', () => {
  const room = setup(); clearDrafts(room);
  const [a,b] = room.players;
  b.points = 777;
  b.specials.steal = 1;
  a.draft = { ...a.draft, normal:'scout', normalTargetId:b.playerId };
  const result = resolveTurn(room);
  const report = result.privateEvents.find(e => e.type === 'scout')?.report;
  assert.ok(report);
  assert.equal(report.hp, 5);
  assert.ok(report.hand);
  assert.equal(report.specials, undefined);
  assert.equal(report.points, undefined);
  assert.equal(report.objective, undefined);
});

test('告発成功は25P、秘密目標を無効化し既得25Pを没収', () => {
  const room = setup(); clearDrafts(room);
  const [a,b] = room.players;
  b.objective = OBJECTIVES.find(o => o.key === 'observer');
  b.secretState.achieved = true;
  b.secretState.awardedPoints = 25;
  b.points = 25;
  a.draft = { ...a.draft, normal:'accusation', normalTargetId:b.playerId, accusationGuess:'observer' };
  resolveTurn(room);
  assert.equal(a.points, 25);
  assert.equal(b.points, 0);
  assert.equal(b.secretState.invalid, true);
});

test('第15ターン中の獲得得点は2倍', () => {
  const room = setup(); clearDrafts(room);
  room.turn = 15;
  const [a,b] = room.players;
  for (const p of room.players) p.secretState.invalid = true;
  b.hp = 1;
  a.draft = { ...a.draft, normal:'attack', normalTargetId:b.playerId };
  resolveTurn(room);
  assert.equal(a.points, 20, '第15ターンの攻撃成功10Pが2倍で20P。キル追加点なし');
});

test('15ターン生存ボーナスは最終ターンでも50P固定', () => {
  const room = setup();
  room.turn = 15;
  awardSurvivalBonus(room);
  for (const p of room.players) assert.equal(p.points, 50);
});

test('無効化された秘密目標はタイブレークの達成数に数えない', () => {
  const room = setup();
  const [a,b] = room.players;
  for (const p of room.players) p.points = 0;
  a.secretState.achieved = true;
  a.secretState.invalid = true;
  b.secretState.achieved = false;
  a.stats.survivedTurns = b.stats.survivedTurns = 1;
  a.hp = b.hp = 5;
  const rows = buildRanking(room);
  const ar = rows.find(r => r.playerId === a.playerId);
  const br = rows.find(r => r.playerId === b.playerId);
  assert.equal(ar.rank, br.rank);
});



test('第5・10・15ターン開始時は生存者だけに固定ボーナスを一度だけ付与する', () => {
  const room = setup();
  const [alive, dead] = room.players;
  dead.alive = false;
  for (const [turn, expected] of [[5,5],[10,10],[15,15]]) {
    for (const p of room.players) p.points = 0;
    room.turn = turn;
    room.turnStartBonusesAwarded = [];
    const events = awardTurnStartBonus(room);
    assert.equal(alive.points, expected);
    assert.equal(dead.points, 0);
    assert.equal(events.length, 4);
    assert.ok(events.every(e => e.actual === expected));
    awardTurnStartBonus(room);
    assert.equal(alive.points, expected, '同じターンで二重付与しない');
  }
});

test('カード指定は次ターンの通常カードを強制し、未所持なら全行動なし', () => {
  const { validateDraft } = require('../src/engine');
  const room = setup(); clearDrafts(room);
  const [a,b] = room.players;
  a.specials.specify = 1;
  a.draft = { ...a.draft, special:'specify', specialTargetId:b.playerId, specifiedType:'heal' };
  resolveTurn(room);
  room.turn = 2;
  room.phase = 'action';
  b.hand.heal = 0;
  b.specials.fullDefense = 1;
  const result = validateDraft(room, b, { ...b.draft, normal:'attack', special:'fullDefense', normalTargetId:a.playerId }, { strict:true });
  assert.equal(result.ok, true);
  assert.equal(result.forcedNoAction, true);
  assert.equal(result.draft.normal, null);
  assert.equal(result.draft.special, null);
});

test('2倍告発は同じ相手に2回推理でき、2回目だけ正解でも成功', () => {
  const room = setup(); clearDrafts(room);
  const [a,b] = room.players;
  a.specials.double = 1;
  b.objective = OBJECTIVES.find(o => o.key === 'observer');
  a.draft = {
    ...a.draft,
    normal:'accusation', special:'double', normalTargetId:b.playerId,
    accusationGuess:'tracker', secondNormalTargetId:b.playerId, secondAccusationGuess:'observer'
  };
  resolveTurn(room);
  assert.equal(a.stats.successfulAccusations, 1);
  assert.equal(a.points, 15, '1回失敗-10P + 1回成功+25P');
  assert.equal(b.secretState.invalid, true);
});


test('回復カードは他の生存プレイヤーを回復できる', () => {
  const room = setup(); clearDrafts(room);
  const [a,b] = room.players;
  b.hp = 2;
  a.draft = { ...a.draft, normal:'heal', normalTargetId:b.playerId };
  resolveTurn(room);
  assert.equal(b.hp, 4);
  assert.equal(a.hp, 5);
});

test('2倍回復は選択した他プレイヤーを最大4回復する', () => {
  const room = setup(); clearDrafts(room);
  const [a,b] = room.players;
  b.hp = 1;
  a.specials.double = 1;
  a.draft = { ...a.draft, normal:'heal', normalTargetId:b.playerId, special:'double' };
  resolveTurn(room);
  assert.equal(b.hp, 5);
});

test('同時攻撃でHP0になった回復プレイヤーは復活しない', () => {
  const room = setup(); clearDrafts(room);
  const [a,b] = room.players;
  b.hp = 1;
  a.draft = { ...a.draft, normal:'attack', normalTargetId:b.playerId };
  b.draft = { ...b.draft, normal:'heal', normalTargetId:b.playerId };
  resolveTurn(room);
  assert.equal(b.hp, 0);
  assert.equal(b.alive, false);
});


test('告発失敗は第15ターンに2倍で-20P', () => {
  const room = setup(); clearDrafts(room);
  room.turn = 15;
  for (const p of room.players) p.secretState.invalid = true;
  const [a,b] = room.players;
  // 対象の秘密目標だけ告発判定用に有効化
  b.secretState.invalid = false;
  b.objective = OBJECTIVES.find(o => o.key === 'observer');
  a.draft = { ...a.draft, normal:'accusation', normalTargetId:b.playerId, accusationGuess:'tracker' };
  const result = resolveTurn(room);
  assert.equal(a.points, -20);
  assert.ok(result.scoreEvents.some(e => e.playerId === a.playerId && e.reason === '告発失敗' && e.actual === -20));
});

test('現在順位はポイントだけで5人全員を比較し同点を同率にする', () => {
  const room = setup();
  const [a,b,c,d,e] = room.players;
  a.points = 100; b.points = 100; c.points = 80; d.points = 60; e.points = 60;
  b.alive = false;
  e.alive = false;
  assert.deepEqual(currentPointsStanding(room, a.playerId), { rank:1, tied:true, tiedCount:2, total:5 });
  assert.deepEqual(currentPointsStanding(room, c.playerId), { rank:3, tied:false, tiedCount:1, total:5 });
  assert.deepEqual(currentPointsStanding(room, d.playerId), { rank:4, tied:true, tiedCount:2, total:5 });
});


test('5人未満では開始できず5人揃うと開始できる', () => {
  const room = createRoom();
  for (let i = 0; i < 4; i++) room.players.push(createPlayer());
  assert.throws(() => startGame(room), /5人揃っていません/);
  room.players.push(createPlayer());
  assert.doesNotThrow(() => startGame(room, () => 0.25));
  assert.equal(room.players.length, 5);
});


test('1位予想は第3・6・9ターンだけ1回、5P刻みで賭けられる', () => {
  for (const turn of [1,2,4,5,7,8,10]) {
    const room = setup(); room.phase='chat'; room.turn=turn;
    const [p] = room.players; p.points=25;
    assert.equal(canPlaceWinnerBet(room,p), false, `turn=${turn}`);
  }
  for (const [turn,multiplier] of [[3,10],[6,5],[9,2.5]]) {
    const room = setup(); room.phase='chat'; room.turn=turn;
    const [p,target] = room.players; p.points=25;
    assert.equal(canPlaceWinnerBet(room,p), true, `turn=${turn}`);
    const r = placeWinnerBet(room,p,target.playerId,20);
    assert.equal(r.ok,true); assert.equal(p.points,5); assert.equal(p.winnerBet.multiplier,multiplier);
    assert.equal(canPlaceWinnerBet(room,p), false);
  }
});

test('第9ターンの1位予想は2.5倍で払戻す', () => {
  const room = setup(); room.phase='chat'; room.turn=9;
  const [p,target] = room.players; p.points=20;
  assert.equal(placeWinnerBet(room,p,target.playerId,5).ok,true);
  for (const x of room.players) x.points=0;
  target.points=100;
  const pre = buildRanking(room);
  const results = settleWinnerBets(room,pre);
  const res = results.find(x=>x.playerId===p.playerId);
  assert.equal(res.hit,true); assert.equal(res.payout,12.5); assert.equal(p.points,12.5);
});

test('1位予想は払戻し前順位で判定し、払戻し後に順位が変わり得る', () => {
  const room = setup(); room.phase='chat'; room.turn=3;
  const [bettor,target] = room.players;
  bettor.points=50; target.points=80;
  assert.equal(placeWinnerBet(room,bettor,target.playerId,50).ok,true);
  const pre=buildRanking(room); assert.equal(pre[0].playerId,target.playerId);
  settleWinnerBets(room,pre);
  const final=buildRanking(room); assert.equal(bettor.points,500); assert.equal(final[0].playerId,bettor.playerId);
});


test('秘密目標欠損は状態同期前に自動修復される', () => {
  const room = setup();
  const originalKeys = room.players.map(p => p.objective?.key);
  assert.equal(originalKeys.filter(Boolean).length, 5);
  room.players[2].objective = null;
  room.players[2].secretState = null;
  ensureSecretObjectives(room, () => 0);
  assert.ok(room.players[2].objective?.key);
  assert.ok(room.players[2].objective?.label);
  assert.equal(typeof room.players[2].objective?.description, 'string');
  assert.ok(room.players[2].secretState);
  assert.equal(room.players.every(p => !!p.objective?.key), true);
});
