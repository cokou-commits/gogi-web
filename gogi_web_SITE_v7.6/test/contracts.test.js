'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validContractStake, contractRewardPerPlayer, contractSettlement } = require('../src/contracts');

test('公開契約ポイントは25P刻みで所持P以内だけ有効', () => {
  assert.equal(validContractStake(25, 25), true);
  assert.equal(validContractStake(50, 75), true);
  assert.equal(validContractStake(5, 100), false);
  assert.equal(validContractStake(30, 100), false);
  assert.equal(validContractStake(50, 25), false);
});

test('25P契約は達成者1人5P、50P契約は1人10P', () => {
  assert.equal(contractRewardPerPlayer(25), 5);
  assert.equal(contractRewardPerPlayer(50), 10);
  assert.equal(contractRewardPerPlayer(75), 15);
});

test('公開契約は達成者分だけ配布し余りを契約主へ返す', () => {
  assert.deepEqual(contractSettlement(25, 2), { perPlayer:5, successCount:2, payoutTotal:10, refund:15 });
  assert.deepEqual(contractSettlement(50, 3), { perPlayer:10, successCount:3, payoutTotal:30, refund:20 });
  assert.deepEqual(contractSettlement(25, 0), { perPlayer:5, successCount:0, payoutTotal:0, refund:25 });
});
