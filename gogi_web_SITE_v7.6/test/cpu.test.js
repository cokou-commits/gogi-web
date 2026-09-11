'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRoom, createPlayer, startGame, validateDraft, recordStructuredStatement } = require('../src/engine');
const { chooseCpuDraft, cpuStructuredStatementPayload, chooseCpuPointTransfer, cpuReplyToChat, adaptCpuDraftFromChat, ensureCpuBrain } = require('../src/cpu');

function startedRoom() {
  const room = createRoom({ isPublic: false, code: 'ABCDEFGH' });
  for (let i = 0; i < 5; i++) room.players.push(createPlayer());
  startGame(room, () => 0.314159);
  return room;
}

test('CPの自動行動は厳格バリデーションを通る', () => {
  const room = startedRoom();
  const p = room.players[0];
  p.isCpu = true;
  for (let i = 0; i < 100; i++) {
    const draft = chooseCpuDraft(room, p);
    const result = validateDraft(room, p, draft, { strict: true });
    assert.equal(result.ok, true, result.message || 'invalid cpu draft');
  }
});

test('カード指定を受けたCPは指定カードを選ぶ', () => {
  const room = startedRoom();
  const p = room.players[0];
  p.isCpu = true;
  p.forcedNormalType = { turn: room.turn, type: 'attack', conflict: false };
  p.hand.attack = 1;
  const draft = chooseCpuDraft(room, p);
  assert.equal(draft.normal, 'attack');
  assert.ok(draft.normalTargetId);
  assert.equal(validateDraft(room, p, draft, { strict: true }).ok, true);
});

test('詐欺師CPは嘘、正直者CPは真実の構造化発言を作る', () => {
  const room = startedRoom();
  const p = room.players[0];
  p.isCpu = true;
  p.objective = { key: 'liar', label: '詐欺師' };
  const liarPayload = cpuStructuredStatementPayload(room, p);
  const liar = recordStructuredStatement(room, p, liarPayload);
  assert.equal(liar.ok, true);
  assert.equal(liar.truth, false);

  p.objective = { key: 'honest', label: '正直者' };
  const honestPayload = cpuStructuredStatementPayload(room, p);
  const honest = recordStructuredStatement(room, p, honestPayload);
  assert.equal(honest.ok, true);
  assert.equal(honest.truth, true);
});

test('贈与者CPはポイント譲渡可能ターンに5P譲渡を計画する', () => {
  const room = startedRoom();
  const p = room.players[0];
  p.isCpu = true;
  p.objective = { key: 'giver', label: '贈与者' };
  p.points = 10;
  room.turn = 5;
  const plan = chooseCpuPointTransfer(room, p);
  assert.ok(plan);
  assert.equal(plan.amount, 5);
  assert.notEqual(plan.targetId, p.playerId);
});


test('CPは自分以外が全員脱落したら対象必須カードを選ばない', () => {
  const room = startedRoom();
  const p = room.players[0];
  p.isCpu = true;
  for (const other of room.players.slice(1)) other.alive = false;
  p.hp = 5;
  p.hand = { attack: 5, defense: 2, scout: 5, accusation: 3, heal: 0 };
  for (let i = 0; i < 30; i++) {
    const draft = chooseCpuDraft(room, p);
    assert.ok(!['attack', 'scout', 'accusation'].includes(draft.normal));
    assert.equal(validateDraft(room, p, draft, { strict: true }).ok, true);
  }
});

test('公開上すでに秘密目標が無効な相手しかいなければCPは告発を選ばない', () => {
  const room = startedRoom();
  const p = room.players[0];
  p.isCpu = true;
  p.hand = { attack: 0, defense: 4, scout: 0, accusation: 4, heal: 0 };
  const brain = ensureCpuBrain(p);
  for (const other of room.players.slice(1)) brain.invalidObjectiveColors[other.color.label] = true;
  for (let i = 0; i < 40; i++) {
    const draft = chooseCpuDraft(room, p);
    assert.notEqual(draft.normal, 'accusation');
    assert.equal(validateDraft(room, p, draft, { strict: true }).ok, true);
  }
});

test('CPは人間からの個別チャットに自然文で応答できる', () => {
  const room = startedRoom();
  const cpu = room.players[0];
  const human = room.players[1];
  cpu.isCpu = true;
  const reply = cpuReplyToChat(room, cpu, human, '同盟組まない？', { direct: true });
  assert.ok(reply);
  assert.equal(reply.toId, human.playerId);
  assert.ok(typeof reply.text === 'string' && reply.text.length > 0 && reply.text.length <= 120);
  assert.ok(reply.delayMs >= 900 && reply.delayMs < 4000);
});


test('CPは会話提案で行動案を調整しても厳格バリデーションを壊さない', () => {
  const room = startedRoom();
  room.phase = 'chat';
  const cpu = room.players[0];
  const human = room.players[1];
  cpu.isCpu = true;
  for (let i = 0; i < 100; i++) {
    cpu.draft = chooseCpuDraft(room, cpu);
    const targetColor = room.players[2].color.label;
    adaptCpuDraftFromChat(room, cpu, human, `${targetColor}狙うのありじゃない？`);
    const result = validateDraft(room, cpu, cpu.draft, { strict:true });
    assert.equal(result.ok, true, result.message || 'chat adaptation made invalid draft');
  }
});

test('超強化CPは秘密目標達成に必要なカードが尽きた時だけ戦略購入を検討する', () => {
  const room = startedRoom();
  const p = room.players[0];
  p.isCpu = true;
  p.objective = { key:'ironWall', label:'鉄壁' };
  p.points = 60;
  p.hand.defense = 0;
  const { chooseCpuPurchasePlan } = require('../src/cpu');
  const plan = chooseCpuPurchasePlan(room, p);
  assert.ok(plan);
  assert.equal(plan.type, 'defense');
  assert.equal(plan.cost, 20);
});

test('隠者CPはどれだけポイントがあっても特殊カード購入を計画しない', () => {
  const room = startedRoom();
  const p = room.players[0];
  p.isCpu = true;
  p.objective = { key:'hermit', label:'隠者' };
  p.points = 200;
  p.hp = 2;
  const { chooseCpuPurchasePlan } = require('../src/cpu');
  const plan = chooseCpuPurchasePlan(room, p);
  assert.notEqual(plan?.type, 'special');
});

test('死神CPは一度攻撃した相手を生存中は攻撃対象として維持する', () => {
  const room = startedRoom();
  const p = room.players[0];
  p.isCpu = true;
  p.objective = { key:'reaper', label:'死神' };
  const fixed = room.players[2];
  p.stats.attackTargets = [fixed.playerId];
  p.hand = { attack:5, defense:0, scout:0, accusation:0, heal:0 };
  for (let i = 0; i < 30; i++) {
    const draft = chooseCpuDraft(room, p);
    assert.equal(draft.normal, 'attack');
    assert.equal(draft.normalTargetId, fixed.playerId);
  }
});

test('CPの目標推理は相手の非公開objectiveや未使用specialsを透視しない', () => {
  const room = startedRoom();
  const p = room.players[0];
  const target = room.players[1];
  p.isCpu = true;
  const { objectiveBeliefs } = require('../src/cpu');
  const before = objectiveBeliefs(room, p, target);
  target.objective = { key:'killer', label:'殺人鬼' };
  target.specials = { fullDefense:99, cancel:99, specify:99, steal:99, double:99 };
  const after = objectiveBeliefs(room, p, target);
  assert.deepEqual(after, before);
});
