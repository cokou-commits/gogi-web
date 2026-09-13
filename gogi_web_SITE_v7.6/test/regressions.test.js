'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createRoom, createPlayer, startGame, resolveTurn, validateDraft,
  awardSurvivalBonus, objectiveAchieved,
  canTransferNormalCard
} = require('../src/engine');
const { OBJECTIVES } = require('../src/rules');

function setup() {
  const room = createRoom();
  for (let i = 0; i < 5; i++) room.players.push(createPlayer());
  startGame(room, () => 0.314159);
  room.phase = 'chat';
  return room;
}

function draft(overrides = {}) {
  return {
    normal:null, special:null, normalTargetId:null, secondNormalTargetId:null,
    specialTargetId:null, accusationGuess:null, secondAccusationGuess:null,
    stealAmount:5, specifiedType:null, specifiedTargetId:null, ...overrides
  };
}

function clear(room) { for (const p of room.players) p.draft = draft(); }

function objective(key) { return OBJECTIVES.find(o => o.key === key); }


test('告発の初期所持枚数は全員5枚', () => {
  const room = setup();
  assert.ok(room.players.every(p => p.hand.accusation === 5));
});

test('防御を選んでも対象は自動で自分にならず明示選択が必要', () => {
  const room = setup();
  const [p] = room.players;
  const loose = validateDraft(room, p, draft({ normal:'defense' }), { strict:false });
  assert.equal(loose.ok, true);
  assert.equal(loose.draft.normalTargetId, null);
  const strict = validateDraft(room, p, draft({ normal:'defense' }), { strict:true });
  assert.equal(strict.ok, false);
  assert.match(strict.message, /防御する対象/);
});

test('告発は脱落済みプレイヤーも対象にできる', () => {
  const room = setup(); clear(room);
  const [accuser, target] = room.players;
  target.alive = false;
  target.hp = 0;
  target.stats.eliminatedTurn = 1;
  target.objective = objective('observer');
  target.secretState.invalid = false;
  target.secretState.achieved = false;
  target.secretState.awardedPoints = 0;
  const action = draft({ normal:'accusation', normalTargetId:target.playerId, accusationGuess:'observer' });
  const checked = validateDraft(room, accuser, action, { strict:true });
  assert.equal(checked.ok, true);
  accuser.draft = action;
  const before = accuser.points;
  resolveTurn(room);
  assert.equal(accuser.points, before + 25);
  assert.equal(accuser.hand.accusation, 4);
});



test('告発成功済みプレイヤーは以後の告発対象にできない', () => {
  const room = setup(); clear(room);
  const [accuser, target] = room.players;
  target.secretState.invalid = true;
  const action = draft({ normal:'accusation', normalTargetId:target.playerId, accusationGuess:'observer' });
  const checked = validateDraft(room, accuser, action, { strict:true });
  assert.equal(checked.ok, false);
  assert.match(checked.message, /告発済み/);
});

test('2倍告発の2回目にも告発成功済みプレイヤーは選べない', () => {
  const room = setup(); clear(room);
  const [accuser, first, resolved] = room.players;
  accuser.specials.double = 1;
  resolved.secretState.invalid = true;
  const action = draft({
    normal:'accusation', special:'double',
    normalTargetId:first.playerId, accusationGuess:'observer',
    secondNormalTargetId:resolved.playerId, secondAccusationGuess:'tracker'
  });
  const checked = validateDraft(room, accuser, action, { strict:true });
  assert.equal(checked.ok, false);
  assert.match(checked.message, /未告発成功/);
});

test('偵察は脱落済みプレイヤーも対象にできる', () => {
  const room = setup(); clear(room);
  const [scouter, target] = room.players;
  target.alive = false;
  target.hp = 0;
  target.stats.eliminatedTurn = 1;
  target.hand.attack = 3;
  const action = draft({ normal:'scout', normalTargetId:target.playerId });
  const checked = validateDraft(room, scouter, action, { strict:true });
  assert.equal(checked.ok, true);
  scouter.draft = action;
  const result = resolveTurn(room);
  const report = result.privateEvents.find(e => e.to === scouter.playerId && e.type === 'scout')?.report;
  assert.ok(report);
  assert.equal(report.targetId, target.playerId);
  assert.equal(report.hp, 0);
  assert.equal(report.hand.attack, 3);
});

test('2倍偵察の2人目にも脱落済みプレイヤーを指定できる', () => {
  const room = setup(); clear(room);
  const [scouter, aliveTarget, deadTarget] = room.players;
  deadTarget.alive = false;
  deadTarget.hp = 0;
  deadTarget.stats.eliminatedTurn = 1;
  scouter.specials.double = 1;
  const action = draft({ normal:'scout', special:'double', normalTargetId:aliveTarget.playerId, secondNormalTargetId:deadTarget.playerId });
  const checked = validateDraft(room, scouter, action, { strict:true });
  assert.equal(checked.ok, true);
  scouter.draft = action;
  const result = resolveTurn(room);
  const reports = result.privateEvents.filter(e => e.to === scouter.playerId && e.type === 'scout').map(e => e.report.targetId);
  assert.deepEqual(new Set(reports), new Set([aliveTarget.playerId, deadTarget.playerId]));
});

test('異なるカード指定が同じ対象に重なると次ターン全行動なし', () => {
  const room = setup(); clear(room);
  const [a,b,target] = room.players;
  a.specials.specify = 1;
  b.specials.specify = 1;
  a.draft = draft({ special:'specify', specialTargetId:target.playerId, specifiedType:'attack', specifiedTargetId:a.playerId });
  b.draft = draft({ special:'specify', specialTargetId:target.playerId, specifiedType:'defense', specifiedTargetId:target.playerId });
  resolveTurn(room);
  assert.deepEqual(target.forcedNormalType, { turn:2, type:null, targetId:null, conflict:true });
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
  a.draft = draft({ special:'specify', specialTargetId:target.playerId, specifiedType:'defense', specifiedTargetId:target.playerId });
  b.draft = draft({ special:'specify', specialTargetId:target.playerId, specifiedType:'defense', specifiedTargetId:target.playerId });
  resolveTurn(room);
  assert.deepEqual(target.forcedNormalType, { turn:2, type:'defense', targetId:target.playerId, conflict:false, rewardPlayerIds:[a.playerId,b.playerId] });
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
  assert.equal(a.points, 25);
  assert.equal(b.points, 25);
  assert.equal(a.stats.successfulAccusations, 1);
  assert.equal(b.stats.successfulAccusations, 1);
  assert.equal(target.secretState.invalid, true);
});

test('秘密目標得点を使った後でも告発時に全額25P没収される', () => {
  const room = setup(); clear(room);
  const [a,target] = room.players;
  target.objective = objective('observer');
  target.secretState.achieved = true;
  target.secretState.awardedPoints = 25;
  target.points = 10; // 15Pを既に使った想定
  a.draft = draft({ normal:'accusation', normalTargetId:target.playerId, accusationGuess:'observer' });
  resolveTurn(room);
  assert.equal(target.points, -15);
  assert.equal(target.secretState.awardedPoints, 0);
});

test('オーバーキルは瀕死判定用の被ダメージを水増ししない', () => {
  const room = setup(); clear(room);
  const [a,target] = room.players;
  target.hp = 1;
  a.specials.double = 1;
  a.draft = draft({ normal:'attack', normalTargetId:target.playerId, special:'double' });
  resolveTurn(room);
  assert.equal(target.hp, 0);
  assert.equal(target.stats.damageTaken, 1);
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
  assert.equal(a.points, 25);
  assert.equal(a.stats.successfulAccusations, 1);
});

test('生存ボーナスは何度呼ばれても一度しか付かない', () => {
  const room = setup();
  room.turn = 15;
  awardSurvivalBonus(room);
  awardSurvivalBonus(room);
  for (const p of room.players) assert.equal(p.points, 50);
});

test('死神は同じ1人への攻撃が5回に達した時点で達成', () => {
  const room = setup();
  const [p,a,b] = room.players;
  p.objective = objective('reaper');
  p.stats.attackTargets = [a.playerId, a.playerId, b.playerId, a.playerId, a.playerId];
  assert.equal(objectiveAchieved(room,p), false);
  p.stats.attackTargets.push(a.playerId);
  assert.equal(objectiveAchieved(room,p), true);
});

test('特殊カードは所持中非公開で、使用カード名はサーバー内部イベントだけに残る', () => {
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
  target.draft = draft({ normal:'defense', normalTargetId:target.playerId });
  resolveTurn(room);
  assert.equal(target.hp, 4);
  assert.equal(a.points, 10);
  assert.equal(b.points, 10);
  assert.equal(a.stats.attacksHit, 1);
  assert.equal(b.stats.attacksHit, 1);
  assert.equal(target.points, 10, '通常防御で1以上防いだため防御成功+10P');
});

test('2倍防御は通常攻撃2件を完全に防ぐ', () => {
  const room = setup(); clear(room);
  const [a,b,target] = room.players;
  target.specials.double = 1;
  a.draft = draft({ normal:'attack', normalTargetId:target.playerId });
  b.draft = draft({ normal:'attack', normalTargetId:target.playerId });
  target.draft = draft({ normal:'defense', normalTargetId:target.playerId, special:'double' });
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
  assert.equal(target.points, 10);
});

test('第15ターンの秘密目標25Pは倍化せず、告発時は実得点25Pを没収', () => {
  const room = setup(); clear(room);
  room.turn = 15;
  const [target,accuser] = room.players;
  target.objective = objective('nearDeath');
  target.stats.damageTaken = 5;
  target.hp = 1;
  for (const p of room.players) if (p !== target) p.secretState.invalid = true;
  // まず対象だけで最終ターンを解決して秘密目標を達成させるため、告発者は行動なし。
  resolveTurn(room);
  assert.equal(target.secretState.achieved, true);
  assert.equal(target.secretState.awardedPoints, 25);
  assert.equal(target.points, 25);

  // 告発ロジックの実得点没収を同じ最終ターン倍率下で確認する別ルーム。
  const room2 = setup(); clear(room2); room2.turn = 15;
  const [a,b] = room2.players;
  for (const p of room2.players) p.secretState.invalid = true;
  b.secretState.invalid = false;
  b.objective = objective('observer');
  b.secretState.achieved = true;
  b.secretState.awardedPoints = 25;
  b.points = 25;
  a.draft = draft({ normal:'accusation', normalTargetId:b.playerId, accusationGuess:'observer' });
  resolveTurn(room2);
  assert.equal(a.points, 50, '告発成功25Pは最終ターン2倍で50P');
  assert.equal(b.points, 0, '実際に加算された秘密目標25Pを全額没収');
});

test('第15ターンのポイント泥棒は既存ポイント移動なので2倍にならない', () => {
  const room = setup(); clear(room); room.turn = 15;
  const [a,b] = room.players;
  for (const p of room.players) p.secretState.invalid = true;
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
  target.secretState.awardedPoints = 25;
  target.points = 25;
  accuser.draft = draft({ normal:'accusation', normalTargetId:target.playerId, accusationGuess:'observer' });
  const result = resolveTurn(room);
  assert.ok(result.scoreEvents.some(e => e.playerId === target.playerId && e.reason === '秘密目標得点没収' && e.actual === -25));
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



test('カード指定中は最後の指定カードを交換に出して強制行動を回避できない', () => {
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







test('統合済み会話・行動フェーズchatから直接ターン解決できる', () => {
  const room = setup(); clear(room);
  room.phase = 'chat';
  const [a, target] = room.players;
  a.draft = draft({ normal:'attack', normalTargetId:target.playerId });
  assert.doesNotThrow(() => resolveTurn(room));
  assert.equal(target.hp, 4);
});

test('結果フェーズからの二重ターン解決は拒否する', () => {
  const room = setup(); clear(room);
  room.phase = 'result';
  assert.throws(() => resolveTurn(room), /ターン解決可能/);
});

test('観察者は実際に3ターン連続で偵察すると達成する', () => {
  const room = setup(); clear(room);
  const [p, target] = room.players;
  p.objective = objective('observer');
  for (let turn = 1; turn <= 3; turn++) {
    room.turn = turn;
    room.phase = 'chat';
    clear(room);
    p.draft = draft({ normal:'scout', normalTargetId:target.playerId });
    resolveTurn(room);
  }
  assert.equal(p.stats.consecutiveScoutTurns, 3);
  assert.equal(p.secretState.achieved, true);
  assert.equal(p.secretState.awardedPoints, 25);
});

test('賭け師は偵察済み相手への告発成功では達成しない', () => {
  const room = setup(); clear(room);
  const [p, target] = room.players;
  p.objective = objective('gambler');
  target.objective = objective('observer');
  p.draft = draft({ normal:'scout', normalTargetId:target.playerId });
  resolveTurn(room);
  room.turn = 2; room.phase = 'chat'; clear(room);
  p.draft = draft({ normal:'accusation', normalTargetId:target.playerId, accusationGuess:'observer' });
  resolveTurn(room);
  assert.equal(p.stats.successfulAccusations, 1);
  assert.equal(p.stats.unscoutedAccusationSuccesses, 0);
  assert.equal(p.secretState.achieved, false);
});

test('賭け師は一度も偵察していない相手への告発成功で達成する', () => {
  const room = setup(); clear(room);
  const [p, target] = room.players;
  p.objective = objective('gambler');
  target.objective = objective('observer');
  p.draft = draft({ normal:'accusation', normalTargetId:target.playerId, accusationGuess:'observer' });
  resolveTurn(room);
  assert.equal(p.stats.unscoutedAccusationSuccesses, 1);
  assert.equal(p.secretState.achieved, true);
  assert.equal(p.points, 50, '告発成功25P + 秘密目標25P');
});

test('未使用系は第1ターンでも未使用のまま脱落した時点で達成する', () => {
  const room = setup(); clear(room);
  room.turn = 1;
  const [attacker, target] = room.players;
  target.objective = objective('endurer');
  target.hp = 1;
  attacker.draft = draft({ normal:'attack', normalTargetId:target.playerId });
  resolveTurn(room);
  assert.equal(target.alive, false);
  assert.equal(target.stats.eliminatedTurn, 1);
  assert.equal(target.secretState.achieved, true);
  assert.equal(target.secretState.awardedPoints, 25);
});


test('最終ターンは秘密目標と生存を除く得点・減点だけ2倍', () => {
  const room = setup(); clear(room); room.turn = 15;
  for (const p of room.players) p.secretState.invalid = true;
  const [a,b] = room.players;
  b.secretState.invalid = false;
  b.objective = objective('observer');
  a.draft = draft({ normal:'accusation', normalTargetId:b.playerId, accusationGuess:'tracker' });
  const result = resolveTurn(room);
  assert.equal(a.points, -20);
  assert.ok(result.scoreEvents.some(e => e.reason === '告発失敗' && e.actual === -20));
  const survival = awardSurvivalBonus(room);
  assert.equal(a.points, 30);
  assert.ok(survival.some(e => e.playerId === a.playerId && e.reason === '15ターン生存' && e.actual === 50));
});


test('購入価格は10・10・10・20・30・特殊40P', () => {
  const { NORMAL_CARDS, SPECIAL_PURCHASE_PRICE, TURN_START_BONUSES } = require('../src/rules');
  assert.deepEqual(Object.fromEntries(Object.entries(NORMAL_CARDS).map(([k,v]) => [k,v.price])), {
    attack:10, defense:10, scout:10, accusation:20, heal:30
  });
  assert.equal(SPECIAL_PURCHASE_PRICE, 40);
  assert.deepEqual(TURN_START_BONUSES, { 5:5, 10:10, 15:15 });
});

test('公開契約判定用の履歴には有効な攻撃対象だけが残る', () => {
  const room = setup(); clear(room);
  const [attacker, target] = room.players;
  attacker.draft = draft({ normal:'attack', normalTargetId:target.playerId });
  resolveTurn(room);
  assert.equal(room.lastEffectiveActions.turn, 1);
  assert.deepEqual(room.lastEffectiveActions.attacksByPlayer[attacker.playerId], [target.playerId]);
});

test('無効カードで消された攻撃は公開契約判定用の履歴に残らない', () => {
  const room = setup(); clear(room);
  const [attacker, canceller, target] = room.players;
  canceller.specials.cancel = 1;
  attacker.draft = draft({ normal:'attack', normalTargetId:target.playerId });
  canceller.draft = draft({ special:'cancel', specialTargetId:attacker.playerId });
  resolveTurn(room);
  assert.equal(room.lastEffectiveActions.turn, 1);
  assert.equal(room.lastEffectiveActions.attacksByPlayer[attacker.playerId], undefined);
});


test('公開契約判定用の履歴には有効な回復対象が残る', () => {
  const room = setup(); clear(room);
  const [healer, target] = room.players;
  target.hp = Math.max(1, target.maxHp - 1);
  healer.draft = draft({ normal:'heal', normalTargetId:target.playerId });
  resolveTurn(room);
  assert.equal(room.lastEffectiveActions.turn, 1);
  assert.deepEqual(room.lastEffectiveActions.healsByPlayer[healer.playerId], [target.playerId]);
});

test('HP満タンでも有効な回復カード使用は公開契約判定履歴に残る', () => {
  const room = setup(); clear(room);
  const [healer, target] = room.players;
  target.hp = target.maxHp;
  healer.draft = draft({ normal:'heal', normalTargetId:target.playerId });
  resolveTurn(room);
  assert.deepEqual(room.lastEffectiveActions.healsByPlayer[healer.playerId], [target.playerId]);
});
