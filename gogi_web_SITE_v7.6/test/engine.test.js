'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createRoom, createPlayer, startGame, resolveTurn, awardSurvivalBonus,
  buildRanking, currentPointsStanding, recordStructuredStatement, canTransferPoints, randomRoomCode
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
  assert.equal(a.points, 5);
});

test('2倍攻撃は2回目を別対象へ指定できる', () => {
  const room = setup(); clearDrafts(room);
  const [a,b,c] = room.players;
  a.specials.double = 1;
  a.draft = { ...a.draft, normal:'attack', normalTargetId:b.playerId, secondNormalTargetId:c.playerId, special:'double' };
  resolveTurn(room);
  assert.equal(b.hp, 4);
  assert.equal(c.hp, 4);
  assert.equal(a.points, 10);
});

test('2倍攻撃を同じ相手へ2回当てても攻撃成功得点は1回分', () => {
  const room = setup(); clearDrafts(room);
  const [a,b] = room.players;
  a.specials.double = 1;
  a.draft = { ...a.draft, normal:'attack', normalTargetId:b.playerId, secondNormalTargetId:b.playerId, special:'double' };
  resolveTurn(room);
  assert.equal(b.hp, 3);
  assert.equal(a.points, 5);
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

test('告発成功は30P、秘密目標を無効化し既得35Pを没収', () => {
  const room = setup(); clearDrafts(room);
  const [a,b] = room.players;
  b.objective = OBJECTIVES.find(o => o.key === 'observer');
  b.secretState.achieved = true;
  b.secretState.awardedPoints = 35;
  b.points = 35;
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
  b.hp = 1;
  a.draft = { ...a.draft, normal:'attack', normalTargetId:b.playerId };
  resolveTurn(room);
  assert.equal(a.points, 50, '攻撃成功10P + 単独キル40P');
});

test('15ターン生存ボーナスは50Pで、最終ターン2倍の対象外', () => {
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

test('正直者/詐欺師用の構造化発言はサーバーで真偽記録される', () => {
  const room = setup();
  room.phase = 'chat';
  const p = room.players[0];
  p.objective = OBJECTIVES.find(o => o.key === 'honest');
  for (let t = 1; t <= 5; t++) {
    room.turn = t;
    const r = recordStructuredStatement(room, p, { subjectId:p.playerId, kind:'hp', value:5 });
    assert.equal(r.ok, true);
    assert.equal(r.truth, true);
  }
  assert.deepEqual(Object.keys(p.secretState.infoByTurn).map(Number), [1,2,3,4,5]);
});

test('ポイント譲渡可能ターンは5・10・15の会話中だけ', () => {
  const room = setup();
  room.phase = 'chat';
  for (const t of [5,10,15]) { room.turn=t; assert.equal(canTransferPoints(room), true); }
  room.turn=9; assert.equal(canTransferPoints(room), false);
  room.turn=10; room.phase='action'; assert.equal(canTransferPoints(room), false);
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
  assert.equal(a.points, 30);
  assert.equal(b.secretState.invalid, true);
});

test('同時攻撃でHP0になった回復プレイヤーは復活しない', () => {
  const room = setup(); clearDrafts(room);
  const [a,b] = room.players;
  b.hp = 1;
  a.draft = { ...a.draft, normal:'attack', normalTargetId:b.playerId };
  b.draft = { ...b.draft, normal:'heal' };
  resolveTurn(room);
  assert.equal(b.hp, 0);
  assert.equal(b.alive, false);
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
