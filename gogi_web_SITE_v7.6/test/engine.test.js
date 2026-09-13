'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createRoom, createPlayer, startGame, resolveTurn, awardTurnStartBonus, awardSurvivalBonus,
  buildRanking, currentPointsStanding, canPlaceWinnerBet, placeWinnerBet, settleWinnerBets, settleChipWager, randomRoomCode, ensureSecretObjectives, validateDraft, draftForResolution, canTransferNormalCard
} = require('../src/engine');
const { NORMAL_CARDS, SPECIAL_CARDS, OBJECTIVES, ROOM_CODE_LENGTH, ROOM_CODE_ALPHABET, GOGI_CHIPS } = require('../src/rules');

function setup() {
  const room = createRoom();
  for (let i = 0; i < 5; i++) room.players.push(createPlayer());
  startGame(room, () => 0.314159);
  room.phase = 'chat';
  return room;
}
function clearDrafts(room) {
  for (const p of room.players) {
    p.draft = {
      normal:null, special:null, normalTargetId:null, secondNormalTargetId:null,
      specialTargetId:null, accusationGuess:null, secondAccusationGuess:null,
      stealTargets:{}, cancelKind:null, specifiedType:null, specifiedTargetId:null
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


test('秘密目標は各プレイヤー独立抽選で重複を許可する', () => {
  const room = createRoom();
  for (let i = 0; i < 5; i++) room.players.push(createPlayer());
  startGame(room, () => 0);
  const keys = room.players.map(p => p.objective?.key);
  assert.equal(keys.length, 5);
  assert.equal(new Set(keys).size, 1, '同じ秘密目標が複数人へ配られることを許可する');
  assert.equal(keys[0], OBJECTIVES[0].key);
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

test('2倍攻撃は通常防御1枚を突破した1回分だけ成功し、その成功得点は2倍', () => {
  const room = setup(); clearDrafts(room);
  const [a,b] = room.players;
  a.specials.double = 1;
  a.draft = { ...a.draft, normal:'attack', normalTargetId:b.playerId, special:'double' };
  b.draft = { ...b.draft, normal:'defense', normalTargetId:b.playerId };
  resolveTurn(room);
  assert.equal(b.hp, 4);
  assert.equal(a.points, 20, '通った1回分の攻撃成功10Pを2倍して20P');
});

test('2倍攻撃は2回目を別対象へ指定できる', () => {
  const room = setup(); clearDrafts(room);
  const [a,b,c] = room.players;
  a.specials.double = 1;
  a.draft = { ...a.draft, normal:'attack', normalTargetId:b.playerId, secondNormalTargetId:c.playerId, special:'double' };
  resolveTurn(room);
  assert.equal(b.hp, 4);
  assert.equal(c.hp, 4);
  assert.equal(a.points, 30, '1回目10P＋2回目20P');
});

test('2倍攻撃を同じ相手へ2回当てた場合は2回目の成功得点だけ2倍', () => {
  const room = setup(); clearDrafts(room);
  const [a,b] = room.players;
  a.specials.double = 1;
  a.draft = { ...a.draft, normal:'attack', normalTargetId:b.playerId, secondNormalTargetId:b.playerId, special:'double' };
  resolveTurn(room);
  assert.equal(b.hp, 3);
  assert.equal(a.points, 30, '同一対象でも1回目10P＋2回目20P');
});

test('通常防御で1以上防ぐと防御成功+10P', () => {
  const room = setup(); clearDrafts(room);
  const [attacker, defender] = room.players;
  attacker.draft = { ...attacker.draft, normal:'attack', normalTargetId:defender.playerId };
  defender.draft = { ...defender.draft, normal:'defense', normalTargetId:defender.playerId };
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
  defender.draft = { ...defender.draft, normal:'defense', normalTargetId:defender.playerId };
  resolveTurn(room);
  assert.equal(defender.points, 20);
});

test('第15ターンと2倍カードが重なっても成功得点倍率は最大2倍', () => {
  const room = setup(); clearDrafts(room);
  room.turn = 15;
  for (const p of room.players) p.secretState.invalid = true;
  const [a,b] = room.players;
  a.specials.double = 1;
  a.draft = { ...a.draft, normal:'attack', normalTargetId:b.playerId, special:'double' };
  resolveTurn(room);
  assert.equal(b.hp, 3);
  assert.equal(a.points, 40, '攻撃成功10P × 最大2倍 × 2回成功');
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

test('完全防御は全攻撃を防ぎ成功時は固定20P', () => {
  const room = setup(); clearDrafts(room);
  const [a,b,c] = room.players;
  b.specials.fullDefense = 1;
  a.draft = { ...a.draft, normal:'attack', normalTargetId:b.playerId };
  c.draft = { ...c.draft, normal:'attack', normalTargetId:b.playerId };
  b.draft = { ...b.draft, special:'fullDefense' };
  const result = resolveTurn(room);
  assert.equal(b.hp, 5);
  assert.equal(b.points, 20);
  assert.equal(a.points, 0);
  assert.equal(c.points, 0);
  assert.ok(result.privateEvents.some(e => e.to === b.playerId && e.type === 'specialResult' && e.special === 'fullDefense' && e.success));
});

test('ポイント泥棒は合計40P・1人20Pまで自由配分し指定額を満額で奪う', () => {
  const room = setup(); clearDrafts(room);
  const [a,b,c,d] = room.players;
  a.specials.steal = 1;
  b.points = 20; c.points = 20; d.points = 10;
  a.draft = { ...a.draft, special:'steal', stealTargets:{ [b.playerId]:20, [c.playerId]:20 } };
  const result = resolveTurn(room);
  assert.equal(a.points, 40);
  assert.equal(b.points, 0); assert.equal(c.points, 0); assert.equal(d.points, 10);
  assert.ok(result.privateEvents.some(e => e.to === a.playerId && e.type === 'specialResult' && e.special === 'steal' && e.success));
});

test('ポイント泥棒は対象が指定額未満ならその対象から0P', () => {
  const room = setup(); clearDrafts(room);
  const [a,b,c] = room.players;
  a.specials.steal = 1; b.points = 19; c.points = 20;
  a.draft = { ...a.draft, special:'steal', stealTargets:{ [b.playerId]:20, [c.playerId]:20 } };
  resolveTurn(room);
  assert.equal(a.points, 20);
  assert.equal(b.points, 19, '19Pしかない相手から20P指定なら0P');
  assert.equal(c.points, 0);
});


test('ポイント泥棒は1人21P以上の指定を拒否する', () => {
  const room = setup(); clearDrafts(room);
  const [a,b] = room.players;
  a.specials.steal = 1;
  const checked = validateDraft(room, a, { ...a.draft, special:'steal', stealTargets:{ [b.playerId]:21 } }, { strict:true });
  assert.equal(checked.ok, false);
});

test('ポイント泥棒は合計51P以上の指定を拒否する', () => {
  const room = setup(); clearDrafts(room);
  const [a,b,c,d] = room.players;
  a.specials.steal = 1;
  const checked = validateDraft(room, a, { ...a.draft, special:'steal', stealTargets:{ [b.playerId]:20, [c.playerId]:20, [d.playerId]:1 } }, { strict:true });
  assert.equal(checked.ok, false);
});

test('完全防御は攻撃が来なければ失敗表示になる', () => {
  const room = setup(); clearDrafts(room);
  const [a] = room.players;
  a.specials.fullDefense = 1;
  a.draft = { ...a.draft, special:'fullDefense' };
  const result = resolveTurn(room);
  assert.ok(result.privateEvents.some(e => e.to === a.playerId && e.type === 'specialResult' && e.special === 'fullDefense' && !e.success));
});

test('ポイント泥棒は他4人全員が0Pなら失敗表示になる', () => {
  const room = setup(); clearDrafts(room);
  const [a] = room.players;
  a.specials.steal = 1;
  for (const p of room.players) p.points = 0;
  a.draft = { ...a.draft, special:'steal', stealTargets:{ [room.players[1].playerId]:20 } };
  const result = resolveTurn(room);
  assert.ok(result.privateEvents.some(e => e.to === a.playerId && e.type === 'specialResult' && e.special === 'steal' && !e.success));
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

test('告発成功は30P、秘密目標を無効化し既得25Pを没収', () => {
  const room = setup(); clearDrafts(room);
  const [a,b] = room.players;
  b.objective = OBJECTIVES.find(o => o.key === 'observer');
  b.secretState.achieved = true;
  b.secretState.awardedPoints = 25;
  b.points = 25;
  a.draft = { ...a.draft, normal:'accusation', normalTargetId:b.playerId, accusationGuess:'observer' };
  resolveTurn(room);
  assert.equal(a.points, 30);
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

test('カード指定は指定した通常カード＋対象をこのターンの行動へ即時適用する', () => {
  const room = setup(); clearDrafts(room);
  const [specifier, forced, target, originalTarget] = room.players;
  specifier.specials.specify = 1;
  forced.draft = { ...forced.draft, normal:'defense', normalTargetId:forced.playerId };
  const defenseBefore = forced.hand.defense;
  const attackBefore = forced.hand.attack;
  specifier.draft = { ...specifier.draft, special:'specify', specialTargetId:forced.playerId, specifiedType:'attack', specifiedTargetId:target.playerId };
  const result = resolveTurn(room);
  assert.equal(target.hp, 4, '指定された攻撃が同じターンに発動する');
  assert.equal(originalTarget.hp, 5);
  assert.equal(forced.hand.defense, defenseBefore, '元々選んでいた通常カードは消費しない');
  assert.equal(forced.hand.attack, attackBefore - 1, '指定された通常カードを消費する');
  assert.equal(forced.forcedNormalType, null, '次ターンへ強制状態を持ち越さない');
  assert.ok(result.privateEvents.some(e => e.to === specifier.playerId && e.type === 'specialResult' && e.special === 'specify' && e.success));
  assert.equal(specifier.points, 20, '指定成立の固定+20P');
  assert.equal(forced.points, 10, '指定された攻撃の成功+10Pは実行者本人');
  assert.ok(result.scoreEvents.some(e => e.playerId === specifier.playerId && e.reason === 'カード指定成功' && e.actual === 20));
  assert.ok(result.scoreEvents.some(e => e.playerId === forced.playerId && e.reason === '攻撃成功' && e.actual === 10));
});

test('カード指定先が指定カードを持っていなければ失敗し、カード指定は消滅する', () => {
  const room = setup(); clearDrafts(room);
  const [a,b] = room.players;
  a.specials.specify = 1;
  b.hand.heal = 0;
  a.draft = { ...a.draft, special:'specify', specialTargetId:b.playerId, specifiedType:'heal', specifiedTargetId:b.playerId };
  const result = resolveTurn(room);
  assert.equal(b.forcedNormalType, null);
  assert.equal(a.specials.specify, 0);
  assert.equal(a.points, 0, '指定カード未所持で失敗した場合は固定+20Pも発生しない');
  assert.ok(result.privateEvents.some(e => e.to === a.playerId && e.type === 'specialResult' && e.special === 'specify' && !e.success));
});

test('カード指定された攻撃の成功+10Pは同じターンに実行者本人へ入る', () => {
  const room = setup(); clearDrafts(room);
  const [specifier, forced, target] = room.players;
  specifier.specials.specify = 1;
  forced.draft = { ...forced.draft, normal:'defense', normalTargetId:forced.playerId };
  specifier.draft = { ...specifier.draft, special:'specify', specialTargetId:forced.playerId, specifiedType:'attack', specifiedTargetId:target.playerId };
  const result = resolveTurn(room);
  assert.equal(target.hp, 4);
  assert.equal(specifier.points, 20, 'カード指定成功の固定+20P');
  assert.equal(forced.points, 10, '指定された攻撃の成功+10Pは実行者本人');
  assert.ok(result.scoreEvents.some(e => e.playerId === forced.playerId && e.reason === '攻撃成功' && e.actual === 10));
});

test('カード指定された告発は成功+30Pも失敗-15Pも実行者本人へ入る', () => {
  const room = setup(); clearDrafts(room);
  const [specifier, forced, target] = room.players;
  target.objective = OBJECTIVES.find(o => o.key === 'observer');
  specifier.specials.specify = 1;
  forced.draft = { ...forced.draft, normal:'accusation', normalTargetId:target.playerId, accusationGuess:'observer' };
  specifier.draft = { ...specifier.draft, special:'specify', specialTargetId:forced.playerId, specifiedType:'accusation', specifiedTargetId:target.playerId };
  let result = resolveTurn(room);
  assert.equal(specifier.points, 20, 'カード指定成功の固定+20P');
  assert.equal(forced.points, 30, '告発成功+30Pは実行者本人');
  assert.ok(result.scoreEvents.some(e => e.playerId === forced.playerId && e.reason === '告発成功' && e.actual === 30));

  const room2 = setup(); clearDrafts(room2);
  const [specifier2, forced2, target2] = room2.players;
  target2.objective = OBJECTIVES.find(o => o.key === 'observer');
  specifier2.specials.specify = 1;
  forced2.draft = { ...forced2.draft, normal:'accusation', normalTargetId:target2.playerId, accusationGuess:'tracker' };
  specifier2.draft = { ...specifier2.draft, special:'specify', specialTargetId:forced2.playerId, specifiedType:'accusation', specifiedTargetId:target2.playerId };
  result = resolveTurn(room2);
  assert.equal(specifier2.points, 20, '指定行動が失敗してもカード指定成立の固定+20Pは残る');
  assert.equal(forced2.points, -15, '告発した本人が-15P');
  assert.ok(result.scoreEvents.some(e => e.playerId === forced2.playerId && e.reason === '告発失敗' && e.actual === -15));
});

test('カード指定された他人防御の成功+10Pは同じターンに実行者本人へ入る', () => {
  const room = setup(); clearDrafts(room);
  const [specifier, forcedDefender, protectedPlayer, attacker] = room.players;
  specifier.specials.specify = 1;
  forcedDefender.draft = { ...forcedDefender.draft, normal:'attack', normalTargetId:attacker.playerId };
  specifier.draft = { ...specifier.draft, special:'specify', specialTargetId:forcedDefender.playerId, specifiedType:'defense', specifiedTargetId:protectedPlayer.playerId };
  attacker.draft = { ...attacker.draft, normal:'attack', normalTargetId:protectedPlayer.playerId };
  const result = resolveTurn(room);
  assert.equal(protectedPlayer.hp, 5);
  assert.equal(specifier.points, 20, 'カード指定成功の固定+20P');
  assert.equal(forcedDefender.points, 10, '他人防御成功+10Pは実行者本人');
  assert.ok(result.scoreEvents.some(e => e.playerId === forcedDefender.playerId && e.reason === '防御成功' && e.actual === 10));
});

test('カード指定された他人回復の成功+20Pは同じターンに実行者本人へ入り、ターン開始時満タンなら加点しない', () => {
  const room = setup(); clearDrafts(room);
  const [specifier, forcedHealer, target] = room.players;
  target.hp = 2;
  specifier.specials.specify = 1;
  forcedHealer.draft = { ...forcedHealer.draft, normal:'attack', normalTargetId:specifier.playerId };
  specifier.draft = { ...specifier.draft, special:'specify', specialTargetId:forcedHealer.playerId, specifiedType:'heal', specifiedTargetId:target.playerId };
  let result = resolveTurn(room);
  assert.equal(target.hp, 4);
  assert.equal(specifier.points, 20, 'カード指定成功の固定+20P');
  assert.equal(forcedHealer.points, 20, '他人回復成功+20Pは実行者本人');
  assert.ok(result.scoreEvents.some(e => e.playerId === forcedHealer.playerId && e.reason === '他人回復成功' && e.actual === 20));

  const room2 = setup(); clearDrafts(room2);
  const [healer, fullTarget] = room2.players;
  fullTarget.hp = fullTarget.maxHp;
  healer.draft = { ...healer.draft, normal:'heal', normalTargetId:fullTarget.playerId };
  result = resolveTurn(room2);
  assert.equal(healer.points, 0);
  assert.ok(!result.scoreEvents.some(e => e.playerId === healer.playerId && e.reason === '他人回復成功'));
});

test('カード指定は第15ターンでもこのターンに発動して無駄にならない', () => {
  const room = setup(); clearDrafts(room);
  room.turn = 15;
  const [specifier, forced, target] = room.players;
  specifier.specials.specify = 1;
  forced.draft = { ...forced.draft, normal:'defense', normalTargetId:forced.playerId };
  specifier.draft = { ...specifier.draft, special:'specify', specialTargetId:forced.playerId, specifiedType:'attack', specifiedTargetId:target.playerId };
  const result = resolveTurn(room);
  assert.equal(target.hp, 4);
  assert.equal(specifier.points, 20, 'カード指定そのものは第15ターンでも固定+20P');
  assert.equal(forced.points, 20, '指定された攻撃成功10Pは通常カードなので第15ターン2倍');
  assert.ok(result.scoreEvents.some(e => e.playerId === specifier.playerId && e.reason === 'カード指定成功' && e.actual === 20));
  assert.ok(result.scoreEvents.some(e => e.playerId === forced.playerId && e.reason === '攻撃成功' && e.actual === 20));
  assert.deepEqual(room.lastEffectiveActions.specifiedActionsByPlayer[forced.playerId], {
    type:'attack', targetId:target.playerId, rewardPlayerIds:[specifier.playerId]
  }, '指定された行動内容と指定者情報を履歴用に保持する');
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
  assert.equal(a.points, 45, '1回失敗-15P + 成功30P×2 = +45P');
  assert.equal(b.secretState.invalid, true);
});


test('回復カードはターン開始時に負傷した他の生存プレイヤーを回復すると使用者に+20P', () => {
  const room = setup(); clearDrafts(room);
  const [a,b] = room.players;
  b.hp = 2;
  a.draft = { ...a.draft, normal:'heal', normalTargetId:b.playerId };
  resolveTurn(room);
  assert.equal(b.hp, 4);
  assert.equal(a.hp, 5);
  assert.equal(a.points, 20);
});

test('同じ負傷者への回復が重なってもターン開始時HP基準で全回復者が成功得点を得る', () => {
  const room = setup(); clearDrafts(room);
  const [a,b,c] = room.players;
  c.hp = 3;
  a.draft = { ...a.draft, normal:'heal', normalTargetId:c.playerId };
  b.draft = { ...b.draft, normal:'heal', normalTargetId:c.playerId };
  const result = resolveTurn(room);
  assert.equal(c.hp, 5, '最終HPは最大5で打ち止め');
  assert.equal(a.points, 20, '先に処理された他人回復者も+20P');
  assert.equal(b.points, 20, '後に処理され実回復0でも開始時に負傷していれば+20P');
  const healScores = result.scoreEvents.filter(e => e.reason === '他人回復成功' && [a.playerId,b.playerId].includes(e.playerId));
  assert.equal(healScores.length, 2);
});

test('ターン開始時から最大HPの対象へ回復が重なっても成功得点は発生しない', () => {
  const room = setup(); clearDrafts(room);
  const [a,b,c] = room.players;
  c.hp = c.maxHp;
  a.draft = { ...a.draft, normal:'heal', normalTargetId:c.playerId };
  b.draft = { ...b.draft, normal:'heal', normalTargetId:c.playerId };
  const result = resolveTurn(room);
  assert.equal(c.hp, c.maxHp);
  assert.equal(a.points, 0);
  assert.equal(b.points, 0);
  assert.equal(result.scoreEvents.filter(e => e.reason === '他人回復成功').length, 0);
});

test('2倍回復は選択した他プレイヤーを最大4回復する', () => {
  const room = setup(); clearDrafts(room);
  const [a,b] = room.players;
  b.hp = 1;
  a.specials.double = 1;
  a.draft = { ...a.draft, normal:'heal', normalTargetId:b.playerId, special:'double' };
  resolveTurn(room);
  assert.equal(b.hp, 5);
  assert.equal(a.points, 60, '1回目20P＋2回目40P');
});


test('2倍回復は2回目を別対象へ指定でき、各対象を2回復する', () => {
  const room = setup(); clearDrafts(room);
  const [a,b,c] = room.players;
  b.hp = 2;
  c.hp = 1;
  a.specials.double = 1;
  a.draft = { ...a.draft, normal:'heal', normalTargetId:b.playerId, secondNormalTargetId:c.playerId, special:'double' };
  resolveTurn(room);
  assert.equal(b.hp, 4);
  assert.equal(c.hp, 3);
  assert.equal(a.points, 60, '別々の対象でも1回目20P＋2回目40P');
});

test('回復と攻撃が同じターンなら回復を先に処理してから攻撃する', () => {
  const room = setup(); clearDrafts(room);
  const [a,b] = room.players;
  b.hp = 1;
  a.draft = { ...a.draft, normal:'attack', normalTargetId:b.playerId };
  b.draft = { ...b.draft, normal:'heal', normalTargetId:b.playerId };
  resolveTurn(room);
  assert.equal(b.hp, 2, 'HP1→回復+2で3→攻撃1で2');
  assert.equal(b.alive, true);
});


test('告発失敗は第15ターンでも固定-15P', () => {
  const room = setup(); clearDrafts(room);
  room.turn = 15;
  for (const p of room.players) p.secretState.invalid = true;
  const [a,b] = room.players;
  // 対象の秘密目標だけ告発判定用に有効化
  b.secretState.invalid = false;
  b.objective = OBJECTIVES.find(o => o.key === 'observer');
  a.draft = { ...a.draft, normal:'accusation', normalTargetId:b.playerId, accusationGuess:'tracker' };
  const result = resolveTurn(room);
  assert.equal(a.points, -15);
  assert.ok(result.scoreEvents.some(e => e.playerId === a.playerId && e.reason === '告発失敗' && e.actual === -15));
});

test('2倍カードでも告発失敗ペナルティは1回につき-15P固定', () => {
  const room = setup(); clearDrafts(room);
  const [a,b,c] = room.players;
  a.specials.double = 1;
  b.secretState.invalid = false;
  c.secretState.invalid = false;
  b.objective = OBJECTIVES.find(o => o.key === 'observer');
  c.objective = OBJECTIVES.find(o => o.key === 'tracker');
  a.draft = { ...a.draft, normal:'accusation', normalTargetId:b.playerId, accusationGuess:'tracker', special:'double', secondNormalTargetId:c.playerId, secondAccusationGuess:'observer' };
  resolveTurn(room);
  assert.equal(a.points, -30, '2回とも失敗なら-15P×2回。2倍カードで-60Pにはならない');
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
  room.players[0].objective = OBJECTIVES[0];
  room.players[2].objective = null;
  room.players[2].secretState = null;
  ensureSecretObjectives(room, () => 0);
  assert.ok(room.players[2].objective?.key);
  assert.equal(room.players[2].objective.key, room.players[0].objective.key, '欠損修復でも既存目標との重複を許可する');
  assert.ok(room.players[2].objective?.label);
  assert.equal(typeof room.players[2].objective?.description, 'string');
  assert.ok(room.players[2].secretState);
  assert.equal(room.players.every(p => !!p.objective?.key), true);
});


test('防御カードで他の生存者を守ると、防御成功+10Pが使用者に入る', () => {
  const room = setup(); clearDrafts(room);
  const [attacker, defender, protectedPlayer] = room.players;
  attacker.draft = { ...attacker.draft, normal:'attack', normalTargetId:protectedPlayer.playerId };
  defender.draft = { ...defender.draft, normal:'defense', normalTargetId:protectedPlayer.playerId };
  resolveTurn(room);
  assert.equal(protectedPlayer.hp, 5);
  assert.equal(defender.points, 10);
  assert.equal(protectedPlayer.points, 0);
  assert.deepEqual(room.lastEffectiveActions.defensesByPlayer[defender.playerId], [protectedPlayer.playerId]);
});

test('1回の攻撃を複数人で防御した場合は防御参加者全員が成功する', () => {
  const room = setup(); clearDrafts(room);
  const [attacker, defenderA, defenderB, protectedPlayer] = room.players;
  attacker.draft = { ...attacker.draft, normal:'attack', normalTargetId:protectedPlayer.playerId };
  defenderA.draft = { ...defenderA.draft, normal:'defense', normalTargetId:protectedPlayer.playerId };
  defenderB.draft = { ...defenderB.draft, normal:'defense', normalTargetId:protectedPlayer.playerId };
  resolveTurn(room);
  assert.equal(protectedPlayer.hp, 5);
  assert.equal(defenderA.points, 10);
  assert.equal(defenderB.points, 10);
  assert.equal(defenderA.stats.defenseSuccessTurns, 1);
  assert.equal(defenderB.stats.defenseSuccessTurns, 1);
});

test('完全防御は他人も対象にでき、その対象への全攻撃を防ぐ', () => {
  const room = setup(); clearDrafts(room);
  const [fullDefender, attacker, other] = room.players;
  fullDefender.specials.fullDefense = 1;
  fullDefender.draft = { ...fullDefender.draft, special:'fullDefense', specialTargetId:other.playerId };
  attacker.draft = { ...attacker.draft, normal:'attack', normalTargetId:other.playerId };
  resolveTurn(room);
  assert.equal(other.hp, 5);
  assert.equal(fullDefender.hp, 5);
  assert.equal(fullDefender.points, 20);
});


test('完全防御と通常防御が同じ対象に重なった場合は完全防御を優先し通常防御は成功得点なし', () => {
  const room = setup(); clearDrafts(room);
  const [fullDefender, normalDefender, attacker] = room.players;
  fullDefender.specials.fullDefense = 1;
  fullDefender.draft = { ...fullDefender.draft, special:'fullDefense' };
  normalDefender.draft = { ...normalDefender.draft, normal:'defense', normalTargetId:fullDefender.playerId };
  attacker.draft = { ...attacker.draft, normal:'attack', normalTargetId:fullDefender.playerId };
  resolveTurn(room);
  assert.equal(fullDefender.hp, 5);
  assert.equal(fullDefender.points, 20, '完全防御成功は固定20P');
  assert.equal(normalDefender.points, 0, '通常防御側には成功得点を付けない');
  assert.equal(normalDefender.stats.defenseSuccessTurns, 0);
});


test('五戯チップは100刻みの同額賭けを開始時に全員から差し引く', () => {
  const room = createRoom({ chipStake:1000 });
  for (let i = 0; i < 5; i++) {
    const p = createPlayer();
    p.chips = 100000;
    room.players.push(p);
  }
  startGame(room, () => 0.25);
  assert.equal(GOGI_CHIPS.initialBalance, 100000);
  assert.equal(GOGI_CHIPS.rechargeAmount, 100000);
  assert.equal(GOGI_CHIPS.stakeStep, 100);
  assert.equal(room.chipPot, 5000);
  assert.equal(room.players.every(p => p.chips === 99000 && p.chipStake === 1000), true);
});

test('五戯チップは第1順位1位2.5倍＋第2順位1位2.5倍で同一人物なら合計5倍', () => {
  const room = createRoom({ chipStake:1000 });
  for (let i = 0; i < 5; i++) {
    const p = createPlayer();
    p.chips = 100000;
    room.players.push(p);
  }
  startGame(room, () => 0.25);
  const winner = room.players[0];
  room.preBetRanking = room.players.map((p,i) => ({ rank:i === 0 ? 1 : i + 1, playerId:p.playerId }));
  room.finishedRanking = room.players.map((p,i) => ({ rank:i === 0 ? 1 : i + 1, playerId:p.playerId }));
  const result = settleChipWager(room);
  const row = result.results.find(x => x.playerId === winner.playerId);
  assert.equal(result.firstRankingPool, 2500);
  assert.equal(result.secondRankingPool, 2500);
  assert.equal(row.firstRankingAward, 2500);
  assert.equal(row.secondRankingAward, 2500);
  assert.equal(row.totalAward, 5000);
  assert.equal(winner.chips, 104000);
  assert.equal(result.totalAwarded, 5000);
  assert.equal(result.unawarded, 0);
});

test('第1順位と第2順位の1位が違う場合は2.5倍ずつ別々に配分する', () => {
  const room = createRoom({ chipStake:1000 });
  for (let i = 0; i < 5; i++) {
    const p = createPlayer();
    p.chips = 100000;
    room.players.push(p);
  }
  startGame(room, () => 0.25);
  const firstWinner = room.players[0];
  const secondWinner = room.players[4];
  room.preBetRanking = room.players.map((p,i) => ({
    rank: p.playerId === firstWinner.playerId ? 1 : i + 2,
    playerId:p.playerId
  }));
  room.finishedRanking = room.players.map((p,i) => ({
    rank: p.playerId === secondWinner.playerId ? 1 : (i < 4 ? i + 2 : 5),
    playerId:p.playerId
  }));
  const result = settleChipWager(room);
  const a = result.results.find(x => x.playerId === firstWinner.playerId);
  const b = result.results.find(x => x.playerId === secondWinner.playerId);
  assert.equal(a.firstRankingAward, 2500);
  assert.equal(a.secondRankingAward, 0);
  assert.equal(a.totalAward, 2500);
  assert.equal(b.firstRankingAward, 0);
  assert.equal(b.secondRankingAward, 2500);
  assert.equal(b.totalAward, 2500);
  assert.deepEqual(result.firstRankingWinnerIds, [firstWinner.playerId]);
  assert.deepEqual(result.secondRankingWinnerIds, [secondWinner.playerId]);
});

test('各順位の同率1位はそれぞれの2.5倍賞金枠を均等分配する', () => {
  const room = createRoom({ chipStake:1000 });
  for (let i = 0; i < 5; i++) {
    const p = createPlayer();
    p.chips = 100000;
    room.players.push(p);
  }
  startGame(room, () => 0.25);
  room.preBetRanking = room.players.map((p,i) => ({ rank:i < 2 ? 1 : i + 1, playerId:p.playerId }));
  room.finishedRanking = room.players.map((p,i) => ({ rank:(i === 2 || i === 3) ? 1 : (i === 0 ? 3 : i === 1 ? 4 : 5), playerId:p.playerId }));
  const result = settleChipWager(room);
  const p0 = result.results.find(x => x.playerId === room.players[0].playerId);
  const p1 = result.results.find(x => x.playerId === room.players[1].playerId);
  const p2 = result.results.find(x => x.playerId === room.players[2].playerId);
  const p3 = result.results.find(x => x.playerId === room.players[3].playerId);
  assert.equal(p0.firstRankingAward, 1250);
  assert.equal(p1.firstRankingAward, 1250);
  assert.equal(p2.secondRankingAward, 1250);
  assert.equal(p3.secondRankingAward, 1250);
  assert.equal(result.totalAwarded, 5000);
});

test('五戯チップ0賭けは差引も賞金も発生しない', () => {
  const room = createRoom({ chipStake:0 });
  for (let i = 0; i < 5; i++) {
    const p = createPlayer();
    p.chips = 100000;
    room.players.push(p);
  }
  startGame(room, () => 0.25);
  room.finishedRanking = room.players.map((p,i) => ({ rank:i === 0 ? 1 : i + 1, playerId:p.playerId }));
  room.winnerBetResults = [{ playerId:room.players[0].playerId, hit:true, payout:100 }];
  const result = settleChipWager(room);
  assert.equal(room.players.every(p => p.chips === 100000), true);
  assert.equal(result.pot, 0);
  assert.equal(result.totalAwarded, 0);
});

test('脱落済みプレイヤーも告発でき、秘密目標が一致すれば成功扱いになる', () => {
  const room = setup(); clearDrafts(room);
  const [accuser, target] = room.players;
  target.alive = false;
  target.hp = 0;
  target.objective = OBJECTIVES[0];
  target.secretState.invalid = false;
  target.secretState.achieved = false;
  target.secretState.awardedPoints = 0;
  accuser.draft = { ...accuser.draft, normal:'accusation', normalTargetId:target.playerId, accusationGuess:OBJECTIVES[0].key };
  const result = resolveTurn(room);
  assert.equal(accuser.points, 30);
  assert.equal(accuser.stats.successfulAccusations, 1);
  assert.equal(target.secretState.invalid, true);
  assert.ok(result.publicEvents.some(e => e.type === 'accusation' && /告発成功/.test(e.text)));
});


test('カード指定の固定対象が次ターンまでに無効化された場合は別対象へ振り替えず行動なし', () => {
  const room = setup();
  room.turn = 2;
  const actor = room.players[1];
  const specifiedTarget = room.players[2];
  actor.forcedNormalType = {
    turn: 2,
    type: 'attack',
    targetId: specifiedTarget.playerId,
    conflict: false,
    rewardPlayerIds: [room.players[0].playerId]
  };
  specifiedTarget.alive = false;
  specifiedTarget.hp = 0;
  specifiedTarget.stats.eliminatedTurn = 1;
  actor.draft = { ...actor.draft, normal: 'attack', normalTargetId: specifiedTarget.playerId };
  const strict = validateDraft(room, actor, actor.draft, { strict: true });
  assert.equal(strict.ok, true);
  assert.equal(strict.forcedNoAction, true);
  assert.equal(strict.forcedTargetInvalid, true);
  assert.equal(strict.draft.normal, null);
  const resolved = draftForResolution(room, actor);
  assert.equal(resolved.normal, null);
  assert.equal(actor.hand.attack, NORMAL_CARDS.attack.initial, '不可能になった指定行動でカードを消費しない');
  actor.hand.attack = 1;
  assert.equal(canTransferNormalCard(room, actor, 'attack'), true, '対象無効なら指定カードの最後の1枚も交換可能');
});

test('秘密目標が有効でもsecretStateだけ欠損した場合は状態だけ自動修復する', () => {
  const room = setup();
  const p = room.players[0];
  const objectiveKey = p.objective.key;
  p.secretState = null;
  ensureSecretObjectives(room, () => 0.75);
  assert.equal(p.objective.key, objectiveKey, '有効な秘密目標は引き直さない');
  assert.deepEqual(p.secretState, { achieved:false, invalid:false, achievedTurn:null, awardedPoints:0 });
});

test('五戯チップ賭け額が100刻みでなければ開始を拒否する', () => {
  const room = createRoom({ chipStake:50 });
  for (let i = 0; i < 5; i++) { const p = createPlayer(); p.chips = 100000; room.players.push(p); }
  assert.throws(() => startGame(room, () => 0.25), /賭け額が不正/);
  assert.equal(room.status, 'lobby');
});

test('五戯チップ残高不足者が1人でもいれば開始を拒否する', () => {
  const room = createRoom({ chipStake:100 });
  for (let i = 0; i < 5; i++) { const p = createPlayer(); p.chips = i === 4 ? 99 : 100000; room.players.push(p); }
  assert.throws(() => startGame(room, () => 0.25), /不足しているプレイヤー/);
  assert.equal(room.status, 'lobby');
  assert.equal(room.players[0].chips, 100000, '失敗前に他プレイヤーから差し引かない');
});

test('厳格検証では偵察の自分自身・未指定対象を拒否する', () => {
  const room = setup(); clearDrafts(room);
  const p = room.players[0];
  let result = validateDraft(room, p, { ...p.draft, normal:'scout', normalTargetId:p.playerId }, { strict:true });
  assert.equal(result.ok, false);
  assert.match(result.message, /対象/);
  result = validateDraft(room, p, { ...p.draft, normal:'scout', normalTargetId:null }, { strict:true });
  assert.equal(result.ok, false);
});

test('厳格検証では対象必須の特殊カードに自分自身を指定できない', () => {
  const room = setup(); clearDrafts(room);
  const p = room.players[0];
  p.specials.cancel = 1;
  const result = validateDraft(room, p, { ...p.draft, special:'cancel', specialTargetId:p.playerId }, { strict:true });
  assert.equal(result.ok, false);
  assert.match(result.message, /特殊カードの対象/);
});

test('カード指定の固定対象が無効かつ入力自体も壊れていても別対象へ振り替えない', () => {
  const room = setup(); clearDrafts(room);
  room.turn = 2;
  const actor = room.players[0];
  const target = room.players[1];
  actor.forcedNormalType = { turn:2, type:'attack', targetId:target.playerId, conflict:false, rewardPlayerIds:[] };
  target.alive = false; target.hp = 0;
  actor.draft = { ...actor.draft, normal:'__invalid__', normalTargetId:target.playerId };
  const resolved = draftForResolution(room, actor);
  assert.equal(resolved.normal, null);
  assert.equal(resolved.normalTargetId, null);
});

test('カード指定の防御で対象未指定のままタイムアウトすると本人防御へ安全に補完する', () => {
  const room = setup(); clearDrafts(room);
  room.turn = 2;
  const actor = room.players[0];
  actor.forcedNormalType = { turn:2, type:'defense', targetId:null, conflict:false, rewardPlayerIds:[] };
  actor.draft = { ...actor.draft, normal:'defense', normalTargetId:null };
  const resolved = draftForResolution(room, actor);
  assert.equal(resolved.normal, 'defense');
  assert.equal(resolved.normalTargetId, actor.playerId);
});

test('カード指定の告発で未選択タイムアウト時は有効対象と秘密目標をサーバー補完する', () => {
  const room = setup(); clearDrafts(room);
  room.turn = 2;
  const actor = room.players[0];
  actor.forcedNormalType = { turn:2, type:'accusation', targetId:null, conflict:false, rewardPlayerIds:[] };
  actor.draft = { ...actor.draft, normal:'accusation', normalTargetId:null, accusationGuess:null };
  const resolved = draftForResolution(room, actor);
  assert.equal(resolved.normal, 'accusation');
  assert.notEqual(resolved.normalTargetId, actor.playerId);
  const target = room.players.find(p => p.playerId === resolved.normalTargetId);
  assert.ok(target && !target.secretState.invalid);
  assert.ok(OBJECTIVES.some(o => o.key === resolved.accusationGuess));
});

test('カード指定の偵察で未選択タイムアウト時は自分以外から対象をサーバー補完する', () => {
  const room = setup(); clearDrafts(room);
  room.turn = 2;
  const actor = room.players[0];
  actor.forcedNormalType = { turn:2, type:'scout', targetId:null, conflict:false, rewardPlayerIds:[] };
  actor.draft = { ...actor.draft, normal:'scout', normalTargetId:null };
  const resolved = draftForResolution(room, actor);
  assert.equal(resolved.normal, 'scout');
  assert.ok(room.players.some(p => p.playerId === resolved.normalTargetId));
  assert.notEqual(resolved.normalTargetId, actor.playerId);
});
