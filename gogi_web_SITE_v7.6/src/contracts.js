'use strict';

function validContractStake(stake, availablePoints = Infinity) {
  const n = Number(stake);
  const max = Number(availablePoints);
  return Number.isInteger(n) && n >= 25 && n % 25 === 0 && (!Number.isFinite(max) || n <= max);
}
function contractRewardPerPlayer(stake) {
  return validContractStake(stake) ? Number(stake) / 5 : 0;
}
function contractSettlement(stake, successCount) {
  const total = Number(stake);
  const perPlayer = contractRewardPerPlayer(total);
  const count = Math.max(0, Math.min(4, Number.isInteger(Number(successCount)) ? Number(successCount) : 0));
  const payoutTotal = perPlayer * count;
  return { perPlayer, successCount:count, payoutTotal, refund:Math.max(0, total - payoutTotal) };
}

module.exports = { validContractStake, contractRewardPerPlayer, contractSettlement };
