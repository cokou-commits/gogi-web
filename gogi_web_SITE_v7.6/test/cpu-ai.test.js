'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRoom, createPlayer, startGame } = require('../src/engine');
const { ensureCpuBrain, ownVisibleRank } = require('../src/cpu');
const { generateCpuChatText, buildPrompt, cleanGeneratedText, extractGeminiText } = require('../src/cpu-ai');

function startedRoom() {
  const room = createRoom({ isPublic:false, code:'ABCDEFGH' });
  for (let i = 0; i < 5; i++) room.players.push(createPlayer());
  startGame(room, () => 0.271828);
  return room;
}

test('10ターン目以降のCP戦略は本人に見える順位だけを取得する', () => {
  const room = startedRoom();
  const cpu = room.players[0];
  cpu.isCpu = true;
  room.players.forEach((p, i) => { p.points = [30, 80, 30, 20, 10][i]; });
  room.turn = 9;
  assert.equal(ownVisibleRank(room, cpu), null);
  room.turn = 10;
  assert.deepEqual(ownVisibleRank(room, cpu), { rank:2, tied:true, total:5 });
});

test('AIプロンプトは戦略意図と分類済み会話要約だけを使う', () => {
  const room = startedRoom();
  const cpu = room.players[0];
  cpu.isCpu = true;
  ensureCpuBrain(cpu).style = 'analyst';
  const prompt = buildPrompt(room, cpu, {
    text:'赤は警戒した方がいい',
    triggerSummary:'青が赤への攻撃・警戒を話題にした'
  });
  assert.match(prompt, /戦略上の発言意図: 赤は警戒した方がいい/);
  assert.match(prompt, /会話の状況: 青が赤への攻撃・警戒を話題にした/);
  assert.doesNotMatch(prompt, /同盟組もうぜ今すぐ/);
});

test('Gemini未設定時は外部通信なしでローカル心理戦文へフォールバックする', async () => {
  const before = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const room = startedRoom();
  const cpu = room.players[0];
  cpu.isCpu = true;
  const text = await generateCpuChatText(room, cpu, { text:'今はまだ様子見かな' });
  assert.equal(text, '今はまだ様子見かな');
  if (before == null) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = before;
});

test('AI出力は実装暴露を拒否し通常テキストだけ抽出する', () => {
  assert.equal(cleanGeneratedText('「赤はちょっと怪しいな」'), '赤はちょっと怪しいな');
  assert.equal(cleanGeneratedText('AIとして考えると赤です'), '');
  const json = { candidates:[{ content:{ parts:[{ thought:true, text:'internal' }, { text:'青は一回見たい' }] } }] };
  assert.equal(extractGeminiText(json), '青は一回見たい');
});
