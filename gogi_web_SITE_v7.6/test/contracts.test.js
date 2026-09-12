'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validContractStake, contractRewardPerPlayer, contractSettlement } = require('../src/contracts');

test('公開契約ポイントは20P刻みで所持P以内だけ有効', () => {
  assert.equal(validContractStake(20, 20), true);
  assert.equal(validContractStake(40, 75), true);
  assert.equal(validContractStake(5, 100), false);
  assert.equal(validContractStake(30, 100), false);
  assert.equal(validContractStake(40, 20), false);
});

test('20P契約は達成者1人5P、40P契約は1人10P', () => {
  assert.equal(contractRewardPerPlayer(20), 5);
  assert.equal(contractRewardPerPlayer(40), 10);
  assert.equal(contractRewardPerPlayer(60), 15);
});

test('公開契約は達成者分だけ配布し余りを提示者へ返す', () => {
  assert.deepEqual(contractSettlement(20, 2), { perPlayer:5, successCount:2, payoutTotal:10, refund:10 });
  assert.deepEqual(contractSettlement(40, 3), { perPlayer:10, successCount:3, payoutTotal:30, refund:10 });
  assert.deepEqual(contractSettlement(20, 0), { perPlayer:5, successCount:0, payoutTotal:0, refund:20 });
  assert.deepEqual(contractSettlement(20, 4), { perPlayer:5, successCount:4, payoutTotal:20, refund:0 });
  assert.deepEqual(contractSettlement(20, 5), { perPlayer:5, successCount:4, payoutTotal:20, refund:0 }, '提示者本人を除く最大4人で打ち止め');
});
