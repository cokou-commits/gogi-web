'use strict';

function validContractStake(stake, availablePoints = Infinity) {
  const n = Number(stake);
  const max = Number(availablePoints);
  return Number.isInteger(n) && n >= 20 && n % 20 === 0 && (!Number.isFinite(max) || n <= max);
}
function contractRewardPerPlayer(stake, multiplier = 1) {
  const m = Number(multiplier);
  return validContractStake(stake) && Number.isFinite(m) && m > 0 ? (Number(stake) / 4) * m : 0;
}
function contractSettlement(stake, successCount, multiplier = 1) {
  const total = Number(stake);
  const basePerPlayer = validContractStake(total) ? total / 4 : 0;
  const perPlayer = contractRewardPerPlayer(total, multiplier);
  const count = Math.max(0, Math.min(4, Number.isInteger(Number(successCount)) ? Number(successCount) : 0));
  const payoutTotal = perPlayer * count;
  // 未参加・未達成分の返却は元の契約ポイント枠で計算する。最終ターン2倍分は追加得点。
  const refund = Math.max(0, total - basePerPlayer * count);
  return { perPlayer, successCount:count, payoutTotal, refund };
}

module.exports = { validContractStake, contractRewardPerPlayer, contractSettlement };
