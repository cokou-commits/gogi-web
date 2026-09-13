'use strict';

const MAX_PLAYERS = 5;
const MAX_TURNS = 15;
const CHAT_SECONDS = 600;
const RESULT_SECONDS = 60;
const RECONNECT_GRACE_SECONDS = 15;
const LOBBY_RECONNECT_GRACE_SECONDS = 30;
const FINISHED_ROOM_TTL_MS = 30 * 60 * 1000;
const ROOM_CODE_LENGTH = 8;
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const COLORS = [
  { key: 'red', label: '赤' },
  { key: 'blue', label: '青' },
  { key: 'yellow', label: '黄' },
  { key: 'green', label: '緑' },
  { key: 'purple', label: '紫' }
];

const NORMAL_CARDS = {
  attack: { label: '攻撃', initial: 5, price: 15 },
  defense: { label: '防御', initial: 5, price: 15 },
  scout: { label: '偵察', initial: 5, price: 15 },
  accusation: { label: '告発', initial: 5, price: 25 },
  heal: { label: '回復', initial: 1, price: 35 }
};

const SPECIAL_CARDS = {
  fullDefense: { label: '完全防御' },
  cancel: { label: '無効' },
  specify: { label: 'カード指定' },
  steal: { label: 'ポイント泥棒' },
  double: { label: '2倍カード' }
};

// 秘密目標は既存の五疑戦ルールを一箇所に集約。
// 達成報酬は25P。第15ターンでも2倍にせず、告発で無効化された場合は実際に加算された額を全額没収する。
const OBJECTIVES = [
  { key: 'observer', label: '観察者', description: '3ターン連続で偵察を使用する' },
  { key: 'tracker', label: '追跡者', description: '同じ1人を5回偵察する' },
  { key: 'gambler', label: '賭け師', description: '告発相手を一度も偵察せず、その相手への告発に成功する' },
  { key: 'killer', label: '殺人鬼', description: '3ターン連続で攻撃を使用する' },
  { key: 'reaper', label: '死神', description: '同じ1人を5回攻撃する' },
  { key: 'ironWall', label: '鉄壁', description: '防御を3回成功させる' },
  { key: 'endurer', label: '耐久者', description: '回復を一度も使用しない。第15ターン生存、または何ターン目でも未使用のまま脱落した時点で達成' },
  { key: 'nearDeath', label: '瀕死', description: '累計5ダメージ以上を受けて生存する' },
  { key: 'unguarded', label: '無防備', description: '防御を一度も使用しない。第15ターン生存、または何ターン目でも未使用のまま脱落した時点で達成' },
  { key: 'hermit', label: '隠者', description: '特殊カードを一度も使用しない。第15ターン生存、または何ターン目でも未使用のまま脱落した時点で達成' }
];

const SECRET_REWARD = 25;
const SCORING = {
  attackHit: 10,
  defenseSuccess: 10,
  defenseOtherSuccess: 15,
  healOtherSuccess: 10,
  accusationSuccess: 25,
  accusationFailure: -10,
  survival: 50,
  fullDefensePerAttacker: 10
};

const STEAL_AMOUNTS = [5, 10, 15, 20, 25];
const SPECIAL_PURCHASE_PRICE = 45;
// 各ターン開始時、その時点の生存者へ固定付与。第15ターンでも2倍にしない。
const TURN_START_BONUSES = Object.freeze({ 5: 5, 10: 10, 15: 15 });
const WINNER_BET = Object.freeze({ allowedTurns: Object.freeze([3, 6, 9]), multipliers: Object.freeze({ 3: 10, 6: 5, 9: 2.5 }), step: 5 });
const GOGI_CHIPS = Object.freeze({ initialBalance: 100000, rechargeAmount: 100000, stakeStep: 100, payoutMultiplier: 2.5 });

function baseHand() {
  return Object.fromEntries(Object.entries(NORMAL_CARDS).map(([key, def]) => [key, def.initial]));
}

function emptySpecials() {
  return Object.fromEntries(Object.keys(SPECIAL_CARDS).map(key => [key, 0]));
}

module.exports = {
  MAX_PLAYERS, MAX_TURNS, CHAT_SECONDS, RESULT_SECONDS,
  RECONNECT_GRACE_SECONDS, LOBBY_RECONNECT_GRACE_SECONDS, FINISHED_ROOM_TTL_MS, ROOM_CODE_LENGTH, ROOM_CODE_ALPHABET,
  COLORS, NORMAL_CARDS, SPECIAL_CARDS, OBJECTIVES, SECRET_REWARD,
  SCORING, STEAL_AMOUNTS, SPECIAL_PURCHASE_PRICE, TURN_START_BONUSES, WINNER_BET, GOGI_CHIPS, baseHand, emptySpecials
};
