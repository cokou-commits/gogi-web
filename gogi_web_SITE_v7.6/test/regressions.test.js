'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createRoom, createPlayer, startGame, resolveTurn, validateDraft,
  awardSurvivalBonus, recordStructuredStatement, objectiveAchieved, invalidatePendingStructuredStatements,
  canTransferNormalCard
} = require('../src/engine');
const { OBJECTIVES } = require('../src/rules');

function setup() {
  const room = createRoom();
  for (let i = 0; i < 5; i++) room.players.push(createPlayer());
  startGame(room, () => 0.314159);
  room.phase = 'action';
  return room;
}

function draft(overrides = {}) {
  return {
    normal:null, special:null, normalTargetId:null, secondNormalTargetId:null,
    specialTargetId:null, accusationGuess:null, secondAccusationGuess:null,
    stealAmount:5, specifiedType:null, ...overrides
  };
}

function clear(room) { for (const p of room.players) p.draft = draft(); }

function objective(key) { return OBJECTIVES.find(o => o.key === key); }

test('異なるカード指定が同じ対象に重なると次ターン全行動なし', () => {
  const room = setup(); clear(room);
  const [a,b,target] = room.players;
  a.specials.specify = 1;
  b.specials.specify = 1;
  a.draft = draft({ special:'specify', specialTargetId:target.playerId, specifiedType:'attack' });
  b.draft = draft({ special:'specify', specialTargetId:target.playerId, specifiedType:'defense' });
  resolveTurn(room);
  assert.deepEqual(target.forcedNormalType, { turn:2, type:null, conflict:true });
  room.turn = 2;
  const r = validateDraft(room, target, draft({ normal:'attack', normalTargetId:a.playerId }), { strict:true });
  assert.equal(r.ok, true);
  assert.equal(r.forcedConflict, true);
  assert.equal(r.draft.normal, null);
  assert.equal(r.draft.special, null);
});

test('同じカード指定が重なっても競合せず同一指定になる', () => {
  const room = setup(); clear(room);
  const [a,b,target] = room.players;
  a.specials.specify = 1;
  b.specials.specify = 1;
  a.draft = draft({ special:'specify', specialTargetId:target.playerId, specifiedType:'defense' });
  b.draft = draft({ special:'specify', specialTargetId:target.playerId, specifiedType:'defense' });
  resolveTurn(room);
  assert.deepEqual(target.forcedNormalType, { turn:2, type:'defense', conflict:false });
});

test('同時ポイント泥棒は対象10Pを5Pずつ公平配分する', () => {
  const room = setup(); clear(room);
  const [a,b,target] = room.players;
  target.points = 10;
  a.specials.steal = 1;
  b.specials.steal = 1;
  a.draft = draft({ special:'steal', specialTargetId:target.playerId, stealAmount:25 });
  b.draft = draft({ special:'steal', specialTargetId:target.playerId, stealAmount:25 });
  resolveTurn(room);
  assert.equal(a.points, 5);
  assert.equal(b.points, 5);
  assert.equal(target.points, 0);
});

test('同じ対象への同時正解告発は全員成功する', () => {
  const room = setup(); clear(room);
  const [a,b,target] = room.players;
  target.objective = objective('observer');
  a.draft = draft({ normal:'accusation', normalTargetId:target.playerId, accusationGuess:'observer' });
  b.draft = draft({ normal:'accusation', normalTargetId:target.playerId, accusationGuess:'observer' });
  resolveTurn(room);
  assert.equal(a.points, 30);
  assert.equal(b.points, 30);
  assert.equal(a.stats.successfulAccusations, 1);
  assert.equal(b.stats.successfulAccusations, 1);
  assert.equal(target.secretState.invalid, true);
});

test('秘密目標得点を使った後でも告発時に全額35P没収される', () => {
  const room = setup(); clear(room);
  const [a,target] = room.players;
  target.objective = objective('observer');
  target.secretState.achieved = true;
  target.secretState.awardedPoints = 35;
  target.points = 10; // 25Pを既に使った想定
  a.draft = draft({ normal:'accusation', normalTargetId:target.playerId, accusationGuess:'observer' });
  resolveTurn(room);
  assert.equal(target.points, -25);
  assert.equal(target.secretState.awardedPoints, 0);
});

test('オーバーキルは耐久者用の被ダメージを水増ししない', () => {
  const room = setup(); clear(room);
  const [a,target] = room.players;
  target.hp = 1;
  a.specials.double = 1;
  a.draft = draft({ normal:'attack', normalTargetId:target.playerId, special:'double' });
  resolveTurn(room);
  assert.equal(target.hp, 0);
  assert.equal(target.stats.damageTaken, 1);
});

test('「次の行動」発言は自分の仮選択ではなく最終確定カードで判定する', () => {
  const room = setup(); clear(room);
  room.phase = 'chat';
  const [speaker, target] = room.players;
  speaker.draft = draft({ normal:'attack', normalTargetId:target.playerId });
  const claim = recordStructuredStatement(room, speaker, {
    subjectId:speaker.playerId, kind:'nextAction', normalType:'attack'
  });
  assert.equal(claim.ok, true);
  assert.equal(claim.deferred, true);
  assert.equal(speaker.secretState.infoByTurn[1], undefined);
  // 会話後に本人が行動を変更
  speaker.draft = draft({ normal:'defense' });
  room.phase = 'action';
  resolveTurn(room);
  assert.deepEqual(speaker.secretState.infoByTurn[1], [false]);
});

test('2倍告発で完全に同じ告発を2回指定しても二重得点しない', () => {
  const room = setup(); clear(room);
  const [a,target] = room.players;
  a.specials.double = 1;
  target.objective = objective('observer');
  a.draft = draft({
    normal:'accusation', special:'double',
    normalTargetId:target.playerId, accusationGuess:'observer',
    secondNormalTargetId:target.playerId, secondAccusationGuess:'observer'
  });
  resolveTurn(room);
  assert.equal(a.points, 30);
  assert.equal(a.stats.successfulAccusations, 1);
});

test('生存ボーナスは何度呼ばれても一度しか付かない', () => {
  const room = setup();
  room.turn = 15;
  awardSurvivalBonus(room);
  awardSurvivalBonus(room);
  for (const p of room.players) assert.equal(p.points, 50);
});

test('死神は最終ターンまで確定せず、別対象を1回でも攻撃すると失敗', () => {
  const room = setup();
  const [p,a,b] = room.players;
  p.objective = objective('reaper');
  p.stats.attackTargets = [a.playerId, a.playerId];
  room.turn = 14;
  assert.equal(objectiveAchieved(room,p), false);
  room.turn = 15;
  assert.equal(objectiveAchieved(room,p), true);
  p.stats.attackTargets.push(b.playerId);
  assert.equal(objectiveAchieved(room,p), false);
});

test('特殊カードは所持中非公開だが使用時はカード名が公開結果に出る', () => {
  const room = setup(); clear(room);
  const [a,b] = room.players;
  a.specials.cancel = 1;
  a.draft = draft({ special:'cancel', specialTargetId:b.playerId });
  const result = resolveTurn(room);
  assert.ok(result.publicEvents.some(e => e.type === 'special' && e.text.includes('無効')));
});

test('2人攻撃対通常防御1は1ダメージで、両攻撃者が攻撃成功扱い', () => {
  const room = setup(); clear(room);
  const [a,b,target] = room.players;
  a.draft = draft({ normal:'attack', normalTargetId:target.playerId });
  b.draft = draft({ normal:'attack', normalTargetId:target.playerId });
  target.draft = draft({ normal:'defense' });
  resolveTurn(room);
  assert.equal(target.hp, 4);
  assert.equal(a.points, 5);
  assert.equal(b.points, 5);
  assert.equal(a.stats.attacksHit, 1);
  assert.equal(b.stats.attacksHit, 1);
});

test('2倍防御は通常攻撃2件を完全に防ぐ', () => {
  const room = setup(); clear(room);
  const [a,b,target] = room.players;
  target.specials.double = 1;
  a.draft = draft({ normal:'attack', normalTargetId:target.playerId });
  b.draft = draft({ normal:'attack', normalTargetId:target.playerId });
  target.draft = draft({ normal:'defense', special:'double' });
  resolveTurn(room);
  assert.equal(target.hp, 5);
  assert.equal(a.points, 0);
  assert.equal(b.points, 0);
  assert.equal(target.stats.defenseSuccessTurns, 1);
});

test('無効化された行動は効果だけ止まり、確定済みカードは消費される', () => {
  const room = setup(); clear(room);
  const [canceler,actor,target] = room.players;
  canceler.specials.cancel = 1;
  canceler.draft = draft({ special:'cancel', specialTargetId:actor.playerId });
  const beforeAttack = actor.hand.attack;
  actor.draft = draft({ normal:'attack', normalTargetId:target.playerId });
  resolveTurn(room);
  assert.equal(target.hp, 5);
  assert.equal(actor.hand.attack, beforeAttack - 1);
  assert.equal(actor.points, 0);
});

test('完全防御の得点は攻撃力ではなく攻撃者人数で数える', () => {
  const room = setup(); clear(room);
  const [attacker,target] = room.players;
  attacker.specials.double = 1;
  target.specials.fullDefense = 1;
  attacker.draft = draft({ normal:'attack', normalTargetId:target.playerId, special:'double' });
  target.draft = draft({ special:'fullDefense' });
  resolveTurn(room);
  assert.equal(target.hp, 5);
  assert.equal(target.points, 5);
});

test('第15ターンの秘密目標35Pは70Pとして加算され、告発時は実得点70Pを没収', () => {
  const room = setup(); clear(room);
  room.turn = 15;
  const [target,accuser] = room.players;
  target.objective = objective('nearDeath');
  target.hp = 1;
  // まず対象だけで最終ターンを解決して秘密目標を達成させるため、告発者は行動なし。
  resolveTurn(room);
  assert.equal(target.secretState.achieved, true);
  assert.equal(target.secretState.awardedPoints, 70);
  assert.equal(target.points, 70);

  // 告発ロジックの実得点没収を同じ最終ターン倍率下で確認する別ルーム。
  const room2 = setup(); clear(room2); room2.turn = 15;
  const [a,b] = room2.players;
  b.objective = objective('observer');
  b.secretState.achieved = true;
  b.secretState.awardedPoints = 70;
  b.points = 70;
  a.draft = draft({ normal:'accusation', normalTargetId:b.playerId, accusationGuess:'observer' });
  resolveTurn(room2);
  assert.equal(a.points, 60, '告発30Pも最終ターン2倍');
  assert.equal(b.points, 0, '実際に加算された70Pを全額没収');
});

test('第15ターンのポイント泥棒は既存ポイント移動なので2倍にならない', () => {
  const room = setup(); clear(room); room.turn = 15;
  const [a,b] = room.players;
  a.specials.steal = 1;
  b.points = 25;
  a.draft = draft({ special:'steal', specialTargetId:b.playerId, stealAmount:10 });
  resolveTurn(room);
  assert.equal(a.points, 10);
  assert.equal(b.points, 15);
});

test('同ターンに攻撃で脱落しても、ターン開始時に確定した偵察は解決される', () => {
  const room = setup(); clear(room);
  const [scouter,attacker,target] = room.players;
  scouter.hp = 1;
  scouter.draft = draft({ normal:'scout', normalTargetId:target.playerId });
  attacker.draft = draft({ normal:'attack', normalTargetId:scouter.playerId });
  const result = resolveTurn(room);
  assert.equal(scouter.alive, false);
  assert.ok(result.privateEvents.some(e => e.to === scouter.playerId && e.type === 'scout'));
});

test('相互ポイント泥棒は開始時ポイント基準で同時解決され、処理順で増えたポイントを再奪取しない', () => {
  const room = setup(); clear(room);
  const [a,b] = room.players;
  a.points = 5;
  b.points = 20;
  a.specials.steal = 1;
  b.specials.steal = 1;
  a.draft = draft({ special:'steal', specialTargetId:b.playerId, stealAmount:20 });
  b.draft = draft({ special:'steal', specialTargetId:a.playerId, stealAmount:20 });
  resolveTurn(room);
  assert.equal(a.points, 20, 'AはBから20奪い、開始時に持っていた5だけ奪われる');
  assert.equal(b.points, 5, 'BはAの開始時5だけ奪える');
});

test('カード指定を受けた対象が必須対象を選ばずタイムアウトしても指定カードを温存できない', () => {
  const room = setup(); clear(room);
  const [target] = room.players;
  room.turn = 2;
  target.forcedNormalType = { turn:2, type:'attack', conflict:false };
  const before = target.hand.attack;
  const hpBefore = room.players.filter(p => p.playerId !== target.playerId).reduce((sum, p) => sum + p.hp, 0);
  target.draft = draft({ normal:'attack' }); // 対象なしの未完成選択
  resolveTurn(room);
  const hpAfter = room.players.filter(p => p.playerId !== target.playerId).reduce((sum, p) => sum + p.hp, 0);
  assert.equal(target.hand.attack, before - 1);
  assert.equal(hpAfter, hpBefore - 1, '対象未選択でも有効な相手からランダム補完して攻撃する');
});

test('仮選択ペイロードの未知フィールドはサーバー状態へ混入しない', () => {
  const room = setup();
  const [p] = room.players;
  const result = validateDraft(room, p, { ...draft({ normal:'defense' }), injected:'nope', nested:{x:1} }, { strict:false });
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result.draft, 'injected'), false);
  assert.equal(Object.hasOwn(result.draft, 'nested'), false);
});

test('告発による秘密目標得点没収は本人の結果にも負の得点イベントとして残る', () => {
  const room = setup(); clear(room);
  const [accuser,target] = room.players;
  target.objective = objective('observer');
  target.secretState.achieved = true;
  target.secretState.awardedPoints = 35;
  target.points = 35;
  accuser.draft = draft({ normal:'accusation', normalTargetId:target.playerId, accusationGuess:'observer' });
  const result = resolveTurn(room);
  assert.ok(result.scoreEvents.some(e => e.playerId === target.playerId && e.reason === '秘密目標得点没収' && e.actual === -35));
});


test('15ターン未満の早期終了では生存+50Pを誤付与しない', () => {
  const room = setup();
  room.turn = 7;
  const before = room.players.map(p => p.points);
  const events = awardSurvivalBonus(room);
  assert.deepEqual(events, []);
  assert.deepEqual(room.players.map(p => p.points), before);
  assert.equal(room.survivalBonusAwarded, false);
});

test('カード指定の強制通常カードは放置しても自動実行し、未完成の特殊カードは誤消費しない', () => {
  const room = setup(); clear(room);
  const [p] = room.players;
  room.turn = 2;
  p.forcedNormalType = { turn:2, type:'attack', conflict:false };
  p.specials.cancel = 1;
  const attackBefore = p.hand.attack;
  const cancelBefore = p.specials.cancel;
  const others = room.players.filter(x => x !== p);
  const hpBefore = others.reduce((sum, x) => sum + x.hp, 0);
  // 攻撃対象も無効対象も未選択。指定攻撃は有効対象を自動選択して実行し、未完成の無効カードは残す。
  p.draft = draft({ normal:'attack', special:'cancel' });
  resolveTurn(room);
  assert.equal(p.hand.attack, attackBefore - 1);
  assert.equal(p.specials.cancel, cancelBefore);
  assert.equal(others.reduce((sum, x) => sum + x.hp, 0), hpBefore - 1);
  assert.equal(others.filter(x => x.hp === 4).length, 1);
});


test('カード種別を切り替えた時に不要なdraft値をサーバー側でも除去する', () => {
  const room = setup();
  const [p,target,other] = room.players;
  p.specials.double = 1;
  const result = validateDraft(room, p, draft({
    normal:'scout', special:'double', normalTargetId:target.playerId,
    secondNormalTargetId:other.playerId, accusationGuess:'observer', secondAccusationGuess:'tracker',
    specialTargetId:other.playerId, specifiedType:'attack'
  }), { strict:false });
  assert.equal(result.ok, true);
  assert.equal(result.draft.accusationGuess, null);
  assert.equal(result.draft.secondAccusationGuess, null);
  assert.equal(result.draft.specialTargetId, null);
  assert.equal(result.draft.specifiedType, null);
  assert.equal(result.draft.secondNormalTargetId, other.playerId);
});

test('ターン解決エラー時の保留nextActionは残留せず正直者/詐欺師のどちらにも加点材料にならない', () => {
  const room = setup();
  const [speaker] = room.players;
  room.phase = 'chat';
  const r = recordStructuredStatement(room, speaker, { kind:'nextAction', subjectId:speaker.playerId, normalType:'attack' });
  assert.equal(r.ok, true);
  assert.equal(r.deferred, true);
  assert.equal(speaker.secretState.pendingInfoByTurn[room.turn].length, 1);
  invalidatePendingStructuredStatements(room);
  assert.equal(speaker.secretState.pendingInfoByTurn[room.turn], undefined);
  assert.deepEqual(speaker.secretState.infoByTurn[room.turn], [null]);
});


test('カード指定中は最後の指定カードを譲渡して強制行動を回避できない', () => {
  const room = setup();
  room.turn = 2;
  const [p] = room.players;
  p.forcedNormalType = { turn: 2, type: 'attack', conflict: false };
  p.hand.attack = 1;
  assert.equal(canTransferNormalCard(room, p, 'attack'), false);
  p.hand.attack = 2;
  assert.equal(canTransferNormalCard(room, p, 'attack'), true);
  assert.equal(canTransferNormalCard(room, p, 'defense'), true);
});

test('第1ターンの「前ターン行動」を構造化発言に使えない', () => {
  const room = setup();
  room.phase = 'chat';
  room.turn = 1;
  const [speaker] = room.players;
  const result = recordStructuredStatement(room, speaker, {
    subjectId: speaker.playerId, kind: 'lastAction', normalType: 'none'
  });
  assert.equal(result.ok, false);
});

test('脱落済みプレイヤーの「次の行動」を確定的な真偽材料にできない', () => {
  const room = setup();
  room.phase = 'chat';
  const [speaker, subject] = room.players;
  subject.alive = false;
  const result = recordStructuredStatement(room, speaker, {
    subjectId: subject.playerId, kind: 'nextAction', normalType: 'none'
  });
  assert.equal(result.ok, false);
  assert.equal(speaker.secretState.pendingInfoByTurn[room.turn], undefined);
});


test('自分申告系の情報発言は他人を対象にできない', () => {
  const room = setup();
  room.phase = 'chat';
  const [speaker, other] = room.players;
  const result = recordStructuredStatement(room, speaker, {
    subjectId: other.playerId,
    kind: 'points',
    value: 0
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /自分についてのみ/);
});

test('偵察系の情報発言は他人を対象にできる', () => {
  const room = setup();
  room.phase = 'chat';
  const [speaker, other] = room.players;
  other.hp = 4;
  const result = recordStructuredStatement(room, speaker, {
    subjectId: other.playerId,
    kind: 'hp',
    value: 4
  });
  assert.equal(result.ok, true);
  assert.equal(result.truth, true);
});
