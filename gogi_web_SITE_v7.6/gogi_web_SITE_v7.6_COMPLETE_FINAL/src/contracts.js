'use strict';

function validContractStake(stake, availablePoints = Infinity) {
  const n = Number(stake);
  const max = Number(availablePoints);
  const unlimited = availablePoints === Infinity || max === Infinity;
  const availableOk = unlimited || (Number.isFinite(max) && max >= 0 && n <= max);
  return Number.isInteger(n) && n >= 20 && n % 20 === 0 && availableOk;
}
function contractRewardPerPlayer(stake, multiplier = 1) {
  const m = Number(multiplier);
  return validContractStake(stake) && Number.isFinite(m) && m > 0 ? (Number(stake) / 4) * m : 0;
}
function contractSettlement(stake, successCount, multiplier = 1) {
  const total = Number(stake);
  const stakeIsValid = validContractStake(total);
  const safeTotal = stakeIsValid ? total : 0;
  const basePerPlayer = stakeIsValid ? safeTotal / 4 : 0;
  const perPlayer = contractRewardPerPlayer(safeTotal, multiplier);
  const count = Math.max(0, Math.min(4, Number.isInteger(Number(successCount)) ? Number(successCount) : 0));
  const payoutTotal = perPlayer * count;
  // 未参加・未達成分の返却は元の契約ポイント枠で計算する。最終ターン2倍分は追加得点。
  // 不正入力は払い戻し額をNaN/負値へ伝播させず、呼出側で拒否できる安全な0値へ正規化する。
  const refund = stakeIsValid ? Math.max(0, safeTotal - basePerPlayer * count) : 0;
  return { perPlayer, successCount:count, payoutTotal, refund };
}

module.exports = { validContractStake, contractRewardPerPlayer, contractSettlement };
