'use strict';

const MAX_PLAYERS = 5;
const MAX_TURNS = 15;
const CHAT_SECONDS = 100;
const ACTION_SECONDS = 10;
const RESULT_SECONDS = 6;
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
  attack: { label: '攻撃', initial: 5, price: 20 },
  defense: { label: '防御', initial: 5, price: 20 },
  scout: { label: '偵察', initial: 5, price: 20 },
  accusation: { label: '告発', initial: 3, price: 30 },
  heal: { label: '回復', initial: 1, price: 40 }
};

const SPECIAL_CARDS = {
  fullDefense: { label: '完全防御' },
  cancel: { label: '無効' },
  specify: { label: 'カード指定' },
  steal: { label: 'ポイント泥棒' },
  double: { label: '2倍カード' }
};

// 秘密目標は既存の五疑戦ルールを一箇所に集約。
// 達成報酬35Pは既存実装から継承し、告発で無効化された場合は実際に加算された額を全額没収する。
const OBJECTIVES = [
  { key: 'observer', label: '観察者', description: '4人全員を1回以上偵察する' },
  { key: 'tracker', label: '追跡者', description: '同じ相手を2回以上偵察する' },
  { key: 'gambler', label: '賭け師', description: '一度も偵察せずに告発を成功させる' },
  { key: 'giver', label: '贈与者', description: 'ポイント譲渡を1回以上成功させる' },
  { key: 'killer', label: '殺人鬼', description: '3ターン連続で有効な攻撃行動を行う' },
  { key: 'reaper', label: '死神', description: '試合を通して攻撃対象を1人だけに絞り、その相手へ2回以上有効な攻撃行動を行う' },
  { key: 'executioner', label: '処刑者', description: '単独キルを1回以上達成する' },
  { key: 'accomplice', label: '共犯者', description: '共同キルを2回以上達成する' },
  { key: 'avenger', label: '復讐者', description: '自分を攻撃したことがある相手をキルする' },
  { key: 'ironWall', label: '鉄壁', description: '攻撃を防いだターンを3回以上作る' },
  { key: 'nearDeath', label: '瀕死', description: '第15ターン終了時に生存しHP1である' },
  { key: 'endurer', label: '耐久者', description: '累計4ダメージ以上受ける' },
  { key: 'hermit', label: '隠者', description: '特殊カードを1度も使用せず第15ターンまで生存する' },
  { key: 'liar', label: '詐欺師', description: '5ターン連続で、そのターンの構造化情報発言をすべて嘘にする' },
  { key: 'honest', label: '正直者', description: '5ターン連続で、そのターンの構造化情報発言をすべて真実にする' }
];

const SECRET_REWARD = 35;
const SCORING = {
  attackHit: 5,
  soloKill: 20,
  jointKill: 10,
  accusationSuccess: 30,
  survival: 50,
  fullDefensePerAttacker: 5
};

const STEAL_AMOUNTS = [5, 10, 15, 20, 25];
const POINT_TRANSFER_TURNS = [5, 10, 15];

function baseHand() {
  return Object.fromEntries(Object.entries(NORMAL_CARDS).map(([key, def]) => [key, def.initial]));
}

function emptySpecials() {
  return Object.fromEntries(Object.keys(SPECIAL_CARDS).map(key => [key, 0]));
}

module.exports = {
  MAX_PLAYERS, MAX_TURNS, CHAT_SECONDS, ACTION_SECONDS, RESULT_SECONDS,
  RECONNECT_GRACE_SECONDS, LOBBY_RECONNECT_GRACE_SECONDS, FINISHED_ROOM_TTL_MS, ROOM_CODE_LENGTH, ROOM_CODE_ALPHABET,
  COLORS, NORMAL_CARDS, SPECIAL_CARDS, OBJECTIVES, SECRET_REWARD,
  SCORING, STEAL_AMOUNTS, POINT_TRANSFER_TURNS, baseHand, emptySpecials
};
