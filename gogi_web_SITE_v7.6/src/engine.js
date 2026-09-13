'use strict';

const crypto = require('crypto');
const {
  MAX_PLAYERS, MAX_TURNS, COLORS, NORMAL_CARDS, SPECIAL_CARDS, OBJECTIVES,
  SECRET_REWARD, SCORING, STEAL_MAX_TOTAL, STEAL_MAX_PER_TARGET, SPECIAL_SPECIFIED_PURCHASE_PRICE, TURN_START_BONUSES, WINNER_BET, GOGI_CHIPS, ROOM_CODE_LENGTH, ROOM_CODE_ALPHABET,
  baseHand, emptySpecials
} = require('./rules');

function randomId(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(9).toString('hex')}`;
}
function randomToken() { return crypto.randomBytes(24).toString('base64url'); }
function randomRoomCode() {
  let out = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) out += ROOM_CODE_ALPHABET[crypto.randomInt(ROOM_CODE_ALPHABET.length)];
  return out;
}
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function shuffle(arr, rng = null) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    // 本番はcrypto.randomIntで偏りのない整数乱数。テスト時だけ決定的rngを注入できる。
    const j = rng ? Math.floor(rng() * (i + 1)) : crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
function hasOwn(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
function addUnique(arr, value) { if (!arr.includes(value)) arr.push(value); }

function emptyDraft() {
  return {
    normal: null,
    special: null,
    normalTargetId: null,
    secondNormalTargetId: null,
    specialTargetId: null,
    accusationGuess: null,
    secondAccusationGuess: null,
    stealTargets: {},
    cancelKind: null,
    specifiedType: null,
    specifiedTargetId: null
  };
}

function freshStats() {
  return {
    attacksUsed: 0,
    attacksHit: 0,
    soloKills: 0,
    jointKills: 0,
    killTargets: [],
    successfulAccusations: 0,
    unscoutedAccusationSuccesses: 0,
    damageTaken: 0,
    survivedTurns: 0,
    scoutedTargets: [],
    scoutCounts: {},
    consecutiveScoutTurns: 0,
    lastScoutTurn: null,
    attackTargets: [],
    attackedBy: [],
    defenseSuccessTurns: 0,
    defensesUsed: 0,
    healsUsed: 0,
    consecutiveAttackTurns: 0,
    lastAttackTurn: null,
    specialsUsed: 0,
    normalPurchases: 0,
    specialPurchases: 0,
    lastNormalPurchaseType: null,
    lastNormalPurchaseTurn: null,
    lastSpecialPurchaseTurn: null,
    lastNormalUsed: null,
    lastSpecialUsed: null,
    eliminatedTurn: null
  };
}

function createPlayer({ socketId = null } = {}) {
  return {
    playerId: randomId('p'),
    sessionToken: randomToken(),
    socketId,
    connected: !!socketId,
    clientInstanceId: null,
    pageInstanceId: null,
    browserId: null,
    disconnectTimer: null,
    autoAdvance: false,
    autoReadySeq: null,
    cpuFillReady: false,
    afkStreak: 0,
    turnHadManualInput: false,
    color: null,
    hp: 5,
    maxHp: 5,
    points: 0,
    chips: 0,
    chipStake: 0,
    chipPayout: null,
    alive: true,
    hand: baseHand(),
    specials: emptySpecials(),
    objective: null,
    secretState: {
      achieved: false,
      invalid: false,
      achievedTurn: null,
      awardedPoints: 0
    },
    draft: emptyDraft(),
    ready: false,
    forcedNormalType: null,
    scoutReports: [],
    winnerBet: null,
    stats: freshStats()
  };
}

function createRoom({ isPublic = false, code = null, chipStake = 0 } = {}) {
  return {
    id: randomId('room'),
    code: code || randomRoomCode(),
    isPublic,
    status: 'lobby',
    players: [],
    turn: 0,
    phase: 'lobby',
    phaseEndsAt: null,
    phaseSeq: 0,
    timer: null,
    logs: [],
    chat: [],
    createdAt: Date.now(),
    finishedAt: null,
    finishedRanking: null,
    preBetRanking: null,
    winnerBetResults: null,
    chipStake: Number(chipStake) || 0,
    chipPot: 0,
    chipSettlement: null,
    exchangeRequests: [],
    publicContracts: [],
    lastEffectiveActions: null,
    survivalBonusAwarded: false,
    turnStartBonusesAwarded: [],
    turnHistory: []
  };
}

function getPlayer(room, playerId) {
  return room.players.find(p => p.playerId === playerId) || null;
}


function randomObjective(rng = null) {
  if (!OBJECTIVES.length) throw new Error('秘密目標定義がありません。');
  const index = rng ? Math.floor(rng() * OBJECTIVES.length) : crypto.randomInt(OBJECTIVES.length);
  return OBJECTIVES[Math.max(0, Math.min(OBJECTIVES.length - 1, index))];
}

function ensureSecretObjectives(room, rng = null) {
  if (!room || !Array.isArray(room.players) || !room.players.length) return room;
  if (!['playing', 'finished'].includes(room.status)) return room;
  const validByKey = new Map(OBJECTIVES.map(objective => [objective.key, objective]));
  for (const p of room.players) {
    const key = p?.objective?.key;
    if (key && validByKey.has(key)) {
      if (!p.secretState || typeof p.secretState !== 'object') {
        p.secretState = { achieved:false, invalid:false, achievedTurn:null, awardedPoints:0 };
      }
      continue;
    }
    // 各プレイヤーが10種類から独立抽選する。ほかのプレイヤーとの重複を許可する。
    p.objective = randomObjective(rng);
    p.secretState = { achieved:false, invalid:false, achievedTurn:null, awardedPoints:0 };
  }
  return room;
}

function startGame(room, rng = null) {
  if (room.players.length !== MAX_PLAYERS) throw new Error('5人揃っていません。');
  const chipStake = Number(room.chipStake || 0);
  if (!Number.isFinite(chipStake) || chipStake < 0 || !Number.isInteger(chipStake) || chipStake % GOGI_CHIPS.stakeStep !== 0) {
    throw new Error('五戯チップの賭け額が不正です。');
  }
  if (chipStake > 0 && room.players.some(p => Number(p.chips || 0) < chipStake)) {
    throw new Error('五戯チップが不足しているプレイヤーがいます。');
  }
  const colors = shuffle(COLORS, rng);
  const specials = shuffle(Object.keys(SPECIAL_CARDS), rng);

  room.status = 'playing';
  room.turn = 1;
  room.phase = 'chat';
  room.finishedAt = null;
  room.finishedRanking = null;
  room.preBetRanking = null;
  room.winnerBetResults = null;
  room.chipSettlement = null;
  room.chipPot = 0;
  room.exchangeRequests = [];
  room.publicContracts = [];
  room.lastEffectiveActions = null;
  room.survivalBonusAwarded = false;
  room.turnStartBonusesAwarded = [];
  room.turnHistory = [];

  room.chipPot = chipStake * room.players.length;

  room.players.forEach((p, i) => {
    p.color = colors[i];
    p.hp = 5;
    p.maxHp = 5;
    p.points = 0;
    p.chipStake = chipStake;
    p.chipPayout = null;
    if (chipStake > 0) p.chips = Number((Number(p.chips || 0) - chipStake).toFixed(2));
    p.alive = true;
    p.hand = baseHand();
    p.specials = emptySpecials();
    p.specials[specials[i]] = 1;
    p.objective = randomObjective(rng);
    p.secretState = { achieved: false, invalid: false, achievedTurn: null, awardedPoints: 0 };
    p.draft = emptyDraft();
    p.ready = false;
    p.autoReadySeq = null;
    p.cpuFillReady = false;
    p.afkStreak = 0;
    p.turnHadManualInput = false;
    p.forcedNormalType = null;
    p.scoutReports = [];
    p.winnerBet = null;
    p.stats = freshStats();
  });
  ensureSecretObjectives(room, rng);
  return room;
}

function scoreMultiplier(room) { return room.turn === MAX_TURNS ? 2 : 1; }
function awardPoints(room, player, base, reason, scoreEvents, { multiplyFinal = true, cardMultiplier = 1 } = {}) {
  const normalizedCardMultiplier = Number(cardMultiplier) > 0 ? Number(cardMultiplier) : 1;
  const finalMultiplier = multiplyFinal ? scoreMultiplier(room) : 1;
  // 2倍カードと第15ターン2倍は重複しても乗算しない。得点倍率は最大2倍まで。
  const effectiveMultiplier = Math.max(normalizedCardMultiplier, finalMultiplier);
  const actual = base * effectiveMultiplier;
  player.points += actual;
  if (scoreEvents) scoreEvents.push({ playerId: player.playerId, base, cardMultiplier: normalizedCardMultiplier, finalMultiplier, effectiveMultiplier, actual, reason });
  return actual;
}

// 通常カードの成功得点は、実際にその通常カードを使った本人へ入る。
// カード指定で行動を強制された場合も、成功Pは指定された本人の得点。
// 告発失敗などの失敗減点も同じく実行者本人が受ける。
function awardNormalSuccess(room, actor, normalType, targetId, base, reason, scoreEvents, { cardMultiplier = 1 } = {}) {
  return awardPoints(room, actor, base, reason, scoreEvents, { cardMultiplier });
}

function targetIsValid(room, p, id, { aliveOnly = true } = {}) {
  const target = getPlayer(room, id);
  if (!target || target.playerId === p.playerId) return null;
  if (aliveOnly && !target.alive) return null;
  return target;
}
function healTargetIsValid(room, id) {
  const target = getPlayer(room, id);
  if (!target || !target.alive) return null;
  return target;
}
function accusationTargetIsValid(room, p, id) {
  const target = targetIsValid(room, p, id, { aliveOnly: false });
  if (!target || target.secretState?.invalid) return null;
  return target;
}
function specifiedActionTargetIsValid(room, forcedPlayerId, type, targetId) {
  const forcedPlayer = getPlayer(room, forcedPlayerId);
  const target = getPlayer(room, targetId);
  if (!forcedPlayer || !forcedPlayer.alive || !target) return null;
  if (['attack','scout','accusation'].includes(type) && target.playerId === forcedPlayer.playerId) return null;
  if (['attack','defense','heal'].includes(type) && !target.alive) return null;
  if (type === 'accusation' && target.secretState?.invalid) return null;
  return target;
}

function sanitizeDraft(draft) {
  const src = draft && typeof draft === 'object' ? draft : {};
  const base = emptyDraft();
  for (const key of Object.keys(base)) if (hasOwn(src, key)) base[key] = src[key];
  const cleanStealTargets = {};
  if (src.stealTargets && typeof src.stealTargets === 'object' && !Array.isArray(src.stealTargets)) {
    for (const [playerId, raw] of Object.entries(src.stealTargets)) {
      const n = Number(raw);
      if (Number.isInteger(n) && n > 0) cleanStealTargets[String(playerId)] = n;
    }
  }
  base.stealTargets = cleanStealTargets;
  return base;
}

function validateDraft(room, p, draft, { strict = false } = {}) {
  if (!p || !p.alive) return { ok: false, message: '脱落中は行動できません。' };
  const d = sanitizeDraft(draft);

  if (d.normal && !hasOwn(NORMAL_CARDS, d.normal)) return { ok: false, message: '通常カードが不正です。' };
  if (d.special && !hasOwn(SPECIAL_CARDS, d.special)) return { ok: false, message: '特殊カードが不正です。' };
  if (d.specifiedType && !hasOwn(NORMAL_CARDS, d.specifiedType)) return { ok: false, message: 'カード指定の種類が不正です。' };
  if (d.cancelKind && !['normal','special'].includes(d.cancelKind)) return { ok: false, message: '無効カードの種類が不正です。' };

  // 旧セッション互換用の強制状態。現行のカード指定は解決中の「このターン」に適用する。
  if (p.forcedNormalType?.turn === room.turn) {
    if (p.forcedNormalType.conflict) {
      if (strict) return { ok: true, draft: emptyDraft(), forcedNoAction: true, forcedConflict: true };
      d.normal = null;
      d.special = null;
    } else {
      const forced = p.forcedNormalType.type;
      const forcedTargetId = p.forcedNormalType.targetId;
      const forcedTargetValid = !forcedTargetId || !!specifiedActionTargetIsValid(room, p.playerId, forced, forcedTargetId);
      if ((p.hand[forced] || 0) <= 0 || !forcedTargetValid) {
        // 指定カードが無い、または指定された使用対象が次ターンまでに無効になった場合は全行動なし。
        // 別対象へ勝手に振り替えるとカード指定の意味が変わるため、再抽選はしない。
        if (strict) return { ok: true, draft: emptyDraft(), forcedNoAction: true, forcedTargetInvalid: !forcedTargetValid };
        d.normal = null;
        d.special = null;
      } else {
        if (d.normal && d.normal !== forced) return { ok: false, message: `このターンは「${NORMAL_CARDS[forced].label}」指定です。` };
        d.normal = forced;
        if (forcedTargetId) d.normalTargetId = forcedTargetId;
      }
    }
  }

  // 仮選択段階でも、所持していないカードをサーバー状態へ保存しない。
  if (d.normal && (p.hand[d.normal] || 0) <= 0) return { ok: false, message: '選択した通常カードを所持していません。' };
  if (d.special && (p.specials[d.special] || 0) <= 0) return { ok: false, message: '選択した特殊カードを所持していません。' };

  // カード種別を切り替えた後の不要な対象・推理値をサーバー状態へ残さない。
  // 効果には使われない値でも、古い選択がUIへ再出現するノイズや将来の実装事故を防ぐ。
  if (!['attack', 'defense', 'scout', 'accusation', 'heal'].includes(d.normal)) d.normalTargetId = null;
  if (d.normal !== 'accusation') {
    d.accusationGuess = null;
    d.secondAccusationGuess = null;
  }
  if (!(d.special === 'double' && ['attack', 'defense', 'scout', 'accusation', 'heal'].includes(d.normal))) {
    d.secondNormalTargetId = null;
    d.secondAccusationGuess = null;
  }
  if (!['cancel', 'specify', 'fullDefense'].includes(d.special)) d.specialTargetId = null;
  if (d.special !== 'cancel') d.cancelKind = null;
  else if (!['normal','special'].includes(d.cancelKind)) d.cancelKind = 'normal';
  if (d.special !== 'specify') { d.specifiedType = null; d.specifiedTargetId = null; }
  if (d.special !== 'steal') d.stealTargets = {};

  let stealTotal = 0;
  if (d.special === 'steal') {
    for (const [targetId, amount] of Object.entries(d.stealTargets || {})) {
      const target = getPlayer(room, targetId);
      if (!target || target.playerId === p.playerId) return { ok:false, message:'ポイント泥棒の対象が不正です。' };
      if (!Number.isInteger(amount) || amount < 1 || amount > STEAL_MAX_PER_TARGET) return { ok:false, message:`1人から奪えるのは1〜${STEAL_MAX_PER_TARGET}Pです。` };
      stealTotal += amount;
    }
    if (stealTotal > STEAL_MAX_TOTAL) return { ok:false, message:`ポイント泥棒は合計${STEAL_MAX_TOTAL}Pまでです。` };
  }

  if (!strict) return { ok: true, draft: d };

  if (d.special === 'double' && !d.normal) return { ok: false, message: '2倍カードには通常カードが必要です。' };

  if (d.normal === 'attack' && !targetIsValid(room, p, d.normalTargetId)) {
    return { ok: false, message: '通常カードの対象を選択してください。' };
  }
  if (d.normal === 'scout' && !targetIsValid(room, p, d.normalTargetId, { aliveOnly: false })) {
    return { ok: false, message: '通常カードの対象を選択してください。' };
  }
  if (d.normal === 'accusation') {
    const accusationTarget = targetIsValid(room, p, d.normalTargetId, { aliveOnly: false });
    if (!accusationTarget) return { ok: false, message: '告発する対象を選択してください。' };
    if (accusationTarget.secretState?.invalid) return { ok: false, message: '告発済みの相手は選択できません。' };
  }
  if (d.normal === 'defense' && !healTargetIsValid(room, d.normalTargetId)) {
    return { ok: false, message: '防御する対象を選択してください。' };
  }
  if (d.normal === 'heal' && !healTargetIsValid(room, d.normalTargetId)) {
    return { ok: false, message: '回復する対象を選択してください。' };
  }
  if (d.normal === 'accusation' && !OBJECTIVES.some(x => x.key === d.accusationGuess)) {
    return { ok: false, message: '告発する秘密目標を選択してください。' };
  }

  const specialNeedsTarget = ['cancel', 'specify'].includes(d.special);
  if (specialNeedsTarget && !targetIsValid(room, p, d.specialTargetId)) {
    return { ok: false, message: '特殊カードの対象を選択してください。' };
  }
  if (d.special === 'fullDefense') {
    if (!d.specialTargetId) d.specialTargetId = p.playerId;
    if (!healTargetIsValid(room, d.specialTargetId)) return { ok: false, message: '完全防御の対象を選択してください。' };
  }
  if (d.special === 'cancel' && !['normal','special'].includes(d.cancelKind)) return { ok: false, message: '無効化する種類を選択してください。' };
  if (d.special === 'specify' && !d.specifiedType) return { ok: false, message: '指定する通常カードを選択してください。' };
  if (d.special === 'specify' && !specifiedActionTargetIsValid(room, d.specialTargetId, d.specifiedType, d.specifiedTargetId)) return { ok: false, message: '指定カードを使う対象を選択してください。' };
  if (d.special === 'steal' && stealTotal < 1) return { ok:false, message:'ポイント泥棒で奪う相手とポイントを指定してください。' };

  if (d.special === 'double' && d.normal === 'attack' && d.secondNormalTargetId) {
    const second = targetIsValid(room, p, d.secondNormalTargetId);
    if (!second) return { ok: false, message: '2回目の攻撃対象が不正です。' };
  }
  if (d.special === 'double' && d.normal === 'defense' && d.secondNormalTargetId) {
    const second = healTargetIsValid(room, d.secondNormalTargetId);
    if (!second) return { ok: false, message: '2回目の防御対象が不正です。' };
  }
  if (d.special === 'double' && d.normal === 'heal' && d.secondNormalTargetId) {
    const second = healTargetIsValid(room, d.secondNormalTargetId);
    if (!second) return { ok: false, message: '2回目の回復対象が不正です。' };
  }
  if (d.special === 'double' && d.normal === 'scout' && d.secondNormalTargetId) {
    const second = targetIsValid(room, p, d.secondNormalTargetId, { aliveOnly: false });
    if (!second || d.secondNormalTargetId === d.normalTargetId) return { ok: false, message: '2人目の偵察対象が不正です。' };
  }
  if (d.special === 'double' && d.normal === 'accusation' && d.secondNormalTargetId) {
    const second = accusationTargetIsValid(room, p, d.secondNormalTargetId);
    if (!second) return { ok: false, message: '2回目の告発対象は未告発成功の相手から選択してください。' };
    if (!OBJECTIVES.some(x => x.key === d.secondAccusationGuess)) return { ok: false, message: '2回目の告発内容を選択してください。' };
  }

  return { ok: true, draft: d };
}

// タイムアウト時の解決用。通常は未完成選択を行動なしにするが、
// 旧セッション互換用：強制状態が残っている場合のタイムアウト解決。
// 対象や告発内容が未選択でも、有効候補がある場合はサーバーが自動補完して指定カードを実行する。
function draftForResolution(room, p) {
  const strict = validateDraft(room, p, p.draft, { strict: true });
  if (strict.ok) return strict.draft;

  const forced = p.forcedNormalType?.turn === room.turn && !p.forcedNormalType.conflict
    ? p.forcedNormalType.type
    : null;
  if (!forced || (p.hand[forced] || 0) <= 0) return emptyDraft();
  if (p.forcedNormalType?.targetId && !specifiedActionTargetIsValid(room, p.playerId, forced, p.forcedNormalType.targetId)) {
    // カード指定は対象まで固定する。対象が脱落/告発済み等で無効になっても別対象へ振り替えない。
    return emptyDraft();
  }

  const action = sanitizeDraft(p.draft);
  action.normal = forced;
  // 強制通常カードの未完成入力だけを例外的に消費対象にする。
  // 特殊カード側まで未完成なら、タイムアウトで貴重な特殊カードを誤消費しない。
  if (action.special && (!hasOwn(SPECIAL_CARDS, action.special) || (p.specials[action.special] || 0) <= 0)) action.special = null;
  if (['cancel','specify'].includes(action.special) && !targetIsValid(room, p, action.specialTargetId)) action.special = null;
  if (action.special === 'cancel' && !['normal','special'].includes(action.cancelKind)) action.cancelKind = 'normal';
  if (action.special === 'fullDefense') {
    const protectedTarget = healTargetIsValid(room, action.specialTargetId || p.playerId);
    if (protectedTarget) action.specialTargetId = protectedTarget.playerId;
    else action.special = null;
  }
  if (action.special === 'specify' && (!action.specifiedType || !hasOwn(NORMAL_CARDS, action.specifiedType) || !specifiedActionTargetIsValid(room, action.specialTargetId, action.specifiedType, action.specifiedTargetId))) action.special = null;
  if (action.special === 'steal') {
    const entries = Object.entries(action.stealTargets || {});
    const total = entries.reduce((sum,[targetId,amount]) => {
      const target = getPlayer(room,targetId);
      return sum + (target && target.playerId !== p.playerId && Number.isInteger(amount) && amount >= 1 && amount <= STEAL_MAX_PER_TARGET ? amount : STEAL_MAX_TOTAL + 1);
    }, 0);
    if (!entries.length || total < 1 || total > STEAL_MAX_TOTAL) action.special = null;
  }
  if (action.special === 'double' && !action.normal) action.special = null;
  if (!action.special) {
    action.specialTargetId = null;
    action.cancelKind = null;
    action.specifiedType = null;
    action.specifiedTargetId = null;
  }

  const needsTarget = ['attack', 'defense', 'scout', 'accusation', 'heal'].includes(forced);
  const validOthers = room.players.filter(x => x.alive && x.playerId !== p.playerId);
  const validScoutTargets = room.players.filter(x => x.playerId !== p.playerId);
  const validAccusationTargets = room.players.filter(x => x.playerId !== p.playerId && !x.secretState?.invalid);
  if (forced === 'attack' && validOthers.length === 0) return emptyDraft();
  if (forced === 'scout' && validScoutTargets.length === 0) return emptyDraft();
  if (forced === 'accusation' && validAccusationTargets.length === 0) return emptyDraft();

  // カード指定は「そのカードを使う」強制なので、放置や対象未選択で効果まで回避できない。
  // 手動選択が有効なら尊重し、未選択/不正なら有効な相手から暗号学的乱数で1人を自動選択する。
  if (p.forcedNormalType?.targetId) action.normalTargetId = p.forcedNormalType.targetId;
  if (forced === 'heal' || forced === 'defense') {
    if (!healTargetIsValid(room, action.normalTargetId)) action.normalTargetId = p.playerId;
  } else if (forced === 'accusation') {
    if (!accusationTargetIsValid(room, p, action.normalTargetId)) {
      action.normalTargetId = validAccusationTargets[crypto.randomInt(validAccusationTargets.length)].playerId;
    }
  } else if (forced === 'scout') {
    if (!targetIsValid(room, p, action.normalTargetId, { aliveOnly: false })) {
      action.normalTargetId = validScoutTargets[crypto.randomInt(validScoutTargets.length)].playerId;
    }
  } else if (needsTarget && !targetIsValid(room, p, action.normalTargetId)) {
    action.normalTargetId = validOthers[crypto.randomInt(validOthers.length)].playerId;
  }
  if (forced === 'accusation' && !OBJECTIVES.some(x => x.key === action.accusationGuess)) {
    action.accusationGuess = OBJECTIVES[crypto.randomInt(OBJECTIVES.length)].key;
  }
  return action;
}

function canTransferNormalCard(room, p, type) {
  if (!room || !p || !hasOwn(NORMAL_CARDS, type) || (p.hand[type] || 0) <= 0) return false;
  const forced = p.forcedNormalType;
  // 指定されたカードを持っているのに最後の1枚を譲渡して強制行動を回避する抜け道を防ぐ。
  // 2枚以上ある場合は余剰分の譲渡を許可する。
  if (forced?.turn === room.turn && !forced.conflict && forced.type === type && (p.hand[type] || 0) <= 1) {
    // 固定対象がターン開始時点ですでに無効なら強制行動自体が『行動なし』になるため、
    // そのカードを拘束する理由はない。対象が有効なときだけ最後の1枚を保護する。
    const targetValid = !forced.targetId || !!specifiedActionTargetIsValid(room, p.playerId, forced.type, forced.targetId);
    if (targetValid) return false;
  }
  return true;
}

function consumeActionCards(p, action) {
  if (action.normal) {
    p.hand[action.normal]--;
    if (action.normal === 'defense') p.stats.defensesUsed++;
    if (action.normal === 'heal') p.stats.healsUsed++;
  }
  if (action.special) {
    p.specials[action.special]--;
    p.stats.specialsUsed++;
  }
  p.stats.lastNormalUsed = action.normal || null;
  p.stats.lastSpecialUsed = action.special || null;
}

function objectiveAchieved(room, p) {
  if (!p.objective) return false;
  const noUseCompletion = usedCount => {
    if (usedCount !== 0) return false;
    if (p.alive) return room.turn === MAX_TURNS;
    return Number(p.stats.eliminatedTurn || 0) >= 1;
  };
  switch (p.objective.key) {
    case 'observer': return p.stats.consecutiveScoutTurns >= 3;
    case 'tracker': return Object.values(p.stats.scoutCounts).some(n => n >= 5);
    case 'gambler': return p.stats.unscoutedAccusationSuccesses >= 1;
    case 'killer': return p.stats.consecutiveAttackTurns >= 3;
    case 'reaper': {
      const counts = {};
      for (const id of p.stats.attackTargets) counts[id] = (counts[id] || 0) + 1;
      return Object.values(counts).some(n => n >= 5);
    }
    case 'ironWall': return p.stats.defenseSuccessTurns >= 3;
    case 'endurer': return noUseCompletion(p.stats.healsUsed);
    case 'nearDeath': return p.alive && p.stats.damageTaken >= 5;
    case 'unguarded': return noUseCompletion(p.stats.defensesUsed);
    case 'hermit': return noUseCompletion(p.stats.specialsUsed);
    default: return false;
  }
}

function evaluateObjectives(room, scoreEvents) {
  const achieved = [];
  for (const p of room.players) {
    if (p.secretState.invalid || p.secretState.achieved) continue;
    if (!objectiveAchieved(room, p)) continue;
    p.secretState.achieved = true;
    p.secretState.achievedTurn = room.turn;
    p.secretState.awardedPoints = awardPoints(room, p, SECRET_REWARD, '秘密目標達成', scoreEvents, { multiplyFinal: false });
    achieved.push(p.playerId);
  }
  return achieved;
}

function resolveTurn(room) {
  // 会話と行動選択はchatフェーズへ統合済み。結果画面等からの二重解決は拒否する。
  if (room.status !== 'playing' || room.phase !== 'chat') throw new Error('ターン解決可能なフェーズではありません。');
  const startedAlive = room.players.filter(p => p.alive);
  // 回復成功判定は処理順に左右されないよう、ターン解決開始時点のHPを固定して使う。
  // 同じ負傷者へ複数人の回復が重なっても、開始時点でHPが減っていれば各回復者を成功扱いにする。
  const turnStartHp = new Map(room.players.map(p => [p.playerId, p.hp]));
  const actions = new Map();
  const privateEvents = [];
  const publicEvents = [];
  const scoreEvents = [];

  // タイムアウト時の未完成選択は「行動なし」。有効な選択は確定して処理する。
  for (const p of startedAlive) {
    const action = draftForResolution(room, p);
    consumeActionCards(p, action);
    actions.set(p.playerId, { ...action, p });
    p.draft = emptyDraft();
    p.ready = false;
  }

  // 特殊カード使用は内部の解決履歴へ記録する。対戦中クライアントへは送らず、終了後の全ターン履歴でのみ公開する。
  // 対象・指定内容などの秘密情報まではここでは公開しない。
  for (const a of actions.values()) {
    if (!a.special) continue;
    publicEvents.push({ type: 'special', text: `${a.p.color.label}が特殊カード「${SPECIAL_CARDS[a.special].label}」を使用` });
  }

  // 無効カード同士の循環で処理順が勝敗を左右さないよう、全ての「無効」宣言を同時成立させる。
  // 今回は通常カード無効 / 特殊カード無効を分離し、対象カテゴリだけを止める。
  const canceledNormal = new Set();
  const canceledSpecial = new Set();
  for (const a of actions.values()) {
    if (a.special !== 'cancel') continue;
    const target = getPlayer(room, a.specialTargetId);
    if (!target || target.playerId === a.p.playerId) continue;
    if ((a.cancelKind || 'normal') === 'special') canceledSpecial.add(target.playerId);
    else canceledNormal.add(target.playerId);
  }

  // カード指定は「このターン」の通常行動へ即時適用する。
  // 対象本人が先に選んでいた通常カードは指定カードへ置き換え、カード消費も置換後のカードに合わせる。
  // 同じ相手へ異なる指定が競合した場合は、その相手のこのターンの通常行動だけを不成立にする（特殊カードは維持）。
  const specifyClaims = new Map();
  const stealClaims = [];
  for (const a of actions.values()) {
    if (canceledSpecial.has(a.p.playerId)) continue;
    if (a.special === 'specify') {
      const target = getPlayer(room, a.specialTargetId);
      const useTarget = specifiedActionTargetIsValid(room, a.specialTargetId, a.specifiedType, a.specifiedTargetId);
      if (target && target.alive && a.specifiedType && hasOwn(NORMAL_CARDS, a.specifiedType) && useTarget) {
        const targetAction = actions.get(target.playerId);
        // 通常カードはすでに初期選択分を消費済みなので、同じカードを選んでいた場合は1枚を足し戻して
        // 「解決開始時点で所持していたか」を判定する。
        const availableSpecified = (target.hand[a.specifiedType] || 0) + (targetAction?.normal === a.specifiedType ? 1 : 0);
        if (availableSpecified <= 0) {
          // 指定先が指定カードを所持していない場合はカード指定不成立。使用したカード指定は消滅する。
          privateEvents.push({ to: a.p.playerId, type: 'specialResult', special: 'specify', success: false, text: `カード指定失敗：${target.color.label}は「${NORMAL_CARDS[a.specifiedType].label}」を持っていないため、カード指定は消滅しました。` });
        } else {
          if (!specifyClaims.has(target.playerId)) specifyClaims.set(target.playerId, []);
          specifyClaims.get(target.playerId).push({ actor: a.p, type: a.specifiedType, targetId: useTarget.playerId });
        }
      }
    }
    if (a.special === 'steal') {
      const allocations = {};
      let total = 0;
      for (const [targetId, raw] of Object.entries(a.stealTargets || {})) {
        const target = getPlayer(room, targetId);
        const amount = Number(raw);
        if (!target || target.playerId === a.p.playerId || !Number.isInteger(amount) || amount < 1 || amount > STEAL_MAX_PER_TARGET) continue;
        allocations[targetId] = amount;
        total += amount;
      }
      if (total > 0 && total <= STEAL_MAX_TOTAL) stealClaims.push({ actor:a.p, allocations, requested:total });
    }
  }

  const refundConsumedNormal = action => {
    if (!action?.normal) return;
    action.p.hand[action.normal] = (action.p.hand[action.normal] || 0) + 1;
    if (action.normal === 'defense') action.p.stats.defensesUsed = Math.max(0, action.p.stats.defensesUsed - 1);
    if (action.normal === 'heal') action.p.stats.healsUsed = Math.max(0, action.p.stats.healsUsed - 1);
  };
  const consumeForcedNormal = (action, type) => {
    action.p.hand[type] = (action.p.hand[type] || 0) - 1;
    if (type === 'defense') action.p.stats.defensesUsed++;
    if (type === 'heal') action.p.stats.healsUsed++;
    action.p.stats.lastNormalUsed = type;
  };
  const normalizeForcedDouble = action => {
    if (action.special !== 'double' || !action.normal) return;
    const first = action.normalTargetId;
    if (action.normal === 'attack') {
      if (!targetIsValid(room, action.p, action.secondNormalTargetId)) action.secondNormalTargetId = first;
      action.secondAccusationGuess = null;
    } else if (action.normal === 'defense' || action.normal === 'heal') {
      if (!healTargetIsValid(room, action.secondNormalTargetId)) action.secondNormalTargetId = first;
      action.secondAccusationGuess = null;
    } else if (action.normal === 'scout') {
      const valid = targetIsValid(room, action.p, action.secondNormalTargetId, { aliveOnly:false });
      if (!valid || action.secondNormalTargetId === first) {
        const alternatives = room.players.filter(x => x.playerId !== action.p.playerId && x.playerId !== first);
        action.secondNormalTargetId = alternatives.length ? alternatives[crypto.randomInt(alternatives.length)].playerId : null;
      }
      action.secondAccusationGuess = null;
    } else if (action.normal === 'accusation') {
      if (!accusationTargetIsValid(room, action.p, action.secondNormalTargetId)) {
        const alternatives = room.players.filter(x => x.playerId !== action.p.playerId && !x.secretState?.invalid && x.playerId !== first);
        action.secondNormalTargetId = alternatives.length ? alternatives[crypto.randomInt(alternatives.length)].playerId : first;
      }
      if (!OBJECTIVES.some(x => x.key === action.secondAccusationGuess)) {
        action.secondAccusationGuess = OBJECTIVES[crypto.randomInt(OBJECTIVES.length)].key;
      }
    }
  };

  for (const [targetId, claims] of specifyClaims) {
    const target = getPlayer(room, targetId);
    const targetAction = actions.get(targetId);
    if (!target || !targetAction) continue;
    const uniqueSpecs = [...new Set(claims.map(c => `${c.type}:${c.targetId}`))];
    if (uniqueSpecs.length === 1) {
      const claim = claims[0];
      const useTarget = getPlayer(room, claim.targetId);
      const originalNormal = targetAction.normal;
      if (originalNormal !== claim.type) {
        refundConsumedNormal(targetAction);
        consumeForcedNormal(targetAction, claim.type);
      } else {
        targetAction.p.stats.lastNormalUsed = claim.type;
      }
      targetAction.normal = claim.type;
      targetAction.normalTargetId = claim.targetId;
      if (claim.type === 'accusation') {
        if (!OBJECTIVES.some(x => x.key === targetAction.accusationGuess)) {
          targetAction.accusationGuess = OBJECTIVES[crypto.randomInt(OBJECTIVES.length)].key;
        }
      } else {
        targetAction.accusationGuess = null;
      }
      targetAction.secondNormalTargetId = targetAction.special === 'double' ? targetAction.secondNormalTargetId : null;
      targetAction.secondAccusationGuess = targetAction.special === 'double' ? targetAction.secondAccusationGuess : null;
      normalizeForcedDouble(targetAction);

      // 得点移譲判定に既存のforcedNormalTypeをこの解決中だけ利用し、ターン末に必ず消す。
      target.forcedNormalType = {
        turn: room.turn,
        type: claim.type,
        targetId: claim.targetId,
        conflict: false,
        rewardPlayerIds: [...new Set(claims.map(c => c.actor.playerId))]
      };
      // カード指定そのものが成立した時点で指定者へ固定+20P。
      // この固定+20Pは特殊カード由来なので、第15ターンでも倍率なし。
      // 指定して実行させた通常カードの成功得点と公開契約報酬は、実行者本人へ入り、通常得点として第15ターン倍率を受ける。
      // 指定後の通常行動が失敗しても、この固定成功点は取り消さない。
      for (const c of claims) {
        const specifyBonus = awardPoints(room, c.actor, SCORING.specifySuccess, 'カード指定成功', scoreEvents, { multiplyFinal:false });
        privateEvents.push({
          to: c.actor.playerId,
          type: 'specialResult',
          special: 'specify',
          success: true,
          text: `カード指定成功：${target.color.label}のこのターンの通常行動を「${NORMAL_CARDS[claim.type].label}」→${useTarget?.color?.label || '指定対象'}へ変更し、+${specifyBonus}P獲得しました。指定行動の成功得点は実行者本人に入ります。`
        });
      }
      privateEvents.push({ to: target.playerId, type: 'notice', text: `このターンの通常行動は「${NORMAL_CARDS[claim.type].label}」を${useTarget?.color?.label || '指定対象'}へ使用するよう変更されました。` });
    } else {
      refundConsumedNormal(targetAction);
      targetAction.normal = null;
      targetAction.normalTargetId = null;
      targetAction.accusationGuess = null;
      targetAction.secondNormalTargetId = null;
      targetAction.secondAccusationGuess = null;
      targetAction.p.stats.lastNormalUsed = null;
      target.forcedNormalType = { turn: room.turn, type:null, targetId:null, conflict:true, rewardPlayerIds:[] };
      for (const c of claims) privateEvents.push({ to: c.actor.playerId, type: 'specialResult', special: 'specify', success: false, text: 'カード指定失敗：複数の異なる指定が競合しました。' });
      privateEvents.push({ to: target.playerId, type: 'notice', text: '複数の異なるカード指定が競合したため、このターンの通常行動はなしになりました。' });
    }
  }

  // 無効成功報酬：カード指定による同ターン置換後の、実際に止めたカテゴリの「購入価格相当」を加算する。
  // 通常カード無効なら通常カード1枚分、特殊カード無効なら特殊カード1枚分（50P）。
  // 無効カード同士の宣言は同時成立するため、相手の「無効」カード自体は報酬対象外。
  for (const a of actions.values()) {
    if (a.special !== 'cancel') continue;
    const targetAction = actions.get(a.specialTargetId);
    if (!targetAction || targetAction.p.playerId === a.p.playerId) continue;

    const mode = a.cancelKind || 'normal';
    let reward = 0;
    let stoppedLabel = '';
    if (mode === 'normal') {
      if (targetAction.normal && NORMAL_CARDS[targetAction.normal] && canceledNormal.has(targetAction.p.playerId)) {
        reward = Number(NORMAL_CARDS[targetAction.normal].price || 0);
        stoppedLabel = NORMAL_CARDS[targetAction.normal].label;
      }
    } else {
      if (targetAction.special && targetAction.special !== 'cancel' && SPECIAL_CARDS[targetAction.special] && canceledSpecial.has(targetAction.p.playerId)) {
        reward = Number(SPECIAL_SPECIFIED_PURCHASE_PRICE || 0);
        stoppedLabel = SPECIAL_CARDS[targetAction.special].label;
      }
    }
    if (reward > 0) {
      const reason = `無効成功（${mode === 'normal' ? '通常' : '特殊'}:${stoppedLabel}）`;
      const actual = awardPoints(room, a.p, reward, reason, scoreEvents, { multiplyFinal:false });
      privateEvents.push({
        to: a.p.playerId,
        type: 'specialResult',
        special: 'cancel',
        success: true,
        text: `無効成功：${targetAction.p.color.label}の${mode === 'normal' ? '通常カード' : '特殊カード'}「${stoppedLabel}」を無効化し、${actual}P獲得しました。`
      });
    } else {
      privateEvents.push({
        to: a.p.playerId,
        type: 'specialResult',
        special: 'cancel',
        success: false,
        text: `無効失敗：${targetAction.p.color.label}は指定した${mode === 'normal' ? '通常カード' : '特殊カード'}を使っていませんでした。`
      });
    }
  }

  // ポイント泥棒：任意の相手へ合計最大40P、1人最大20Pを配分して指定する。
  // 各対象は解決開始時点で指定額を満たしていなければ0P。複数の泥棒が同じ対象へ同時指定し、
  // その合計を開始時ポイントで満たせない場合も、処理順で有利不利を作らないためその対象への全指定を0Pにする。
  const stealStartPoints = new Map(room.players.map(p => [p.playerId, Math.max(0, Number(p.points || 0))]));
  const stealDeltas = new Map(room.players.map(p => [p.playerId, 0]));
  const stolenByActor = new Map(stealClaims.map(c => [c.actor.playerId, 0]));
  const stolenFromTarget = new Map(room.players.map(p => [p.playerId, 0]));
  const failedTargetsByActor = new Map(stealClaims.map(c => [c.actor.playerId, []]));

  for (const target of room.players) {
    const targetClaims = [];
    for (const claim of stealClaims) {
      const amount = Number(claim.allocations?.[target.playerId] || 0);
      if (amount > 0 && claim.actor.playerId !== target.playerId) targetClaims.push({ claim, amount });
    }
    if (!targetClaims.length) continue;
    const available = stealStartPoints.get(target.playerId) || 0;
    const individuallyValid = targetClaims.filter(x => available >= x.amount);
    const invalid = targetClaims.filter(x => available < x.amount);
    for (const x of invalid) failedTargetsByActor.get(x.claim.actor.playerId)?.push(target.color?.label || '対象');
    const combined = individuallyValid.reduce((sum,x) => sum + x.amount, 0);
    if (combined > available) {
      for (const x of individuallyValid) failedTargetsByActor.get(x.claim.actor.playerId)?.push(target.color?.label || '対象');
      continue;
    }
    for (const { claim, amount } of individuallyValid) {
      stolenByActor.set(claim.actor.playerId, (stolenByActor.get(claim.actor.playerId) || 0) + amount);
      stealDeltas.set(claim.actor.playerId, (stealDeltas.get(claim.actor.playerId) || 0) + amount);
      stealDeltas.set(target.playerId, (stealDeltas.get(target.playerId) || 0) - amount);
      stolenFromTarget.set(target.playerId, (stolenFromTarget.get(target.playerId) || 0) + amount);
    }
  }
  for (const p of room.players) p.points += stealDeltas.get(p.playerId) || 0;
  for (const claim of stealClaims) {
    const actual = stolenByActor.get(claim.actor.playerId) || 0;
    const failedLabels = [...new Set(failedTargetsByActor.get(claim.actor.playerId) || [])];
    let text = actual > 0 ? `ポイント泥棒成功：合計${actual}P奪いました。` : 'ポイント泥棒失敗：指定額を満たす相手からポイントを奪えませんでした。';
    if (failedLabels.length) text += ` 指定額不足：${failedLabels.join('・')}は0P。`;
    privateEvents.push({ to:claim.actor.playerId, type:'specialResult', special:'steal', success:actual > 0, text });
  }
  for (const target of room.players) {
    const lost = stolenFromTarget.get(target.playerId) || 0;
    if (lost > 0) privateEvents.push({ to:target.playerId, type:'notice', text:`ポイント泥棒で合計${lost}P奪われました。` });
  }

  const doubled = new Set();
  const fullDefense = new Map();
  const fullDefenseSucceeded = new Set();
  const defenseClaims = new Map();
  const effectiveDefenseTargets = new Map();
  const effectiveHealTargets = new Map();
  for (const a of actions.values()) {
    if (canceledSpecial.has(a.p.playerId)) {
      // 通常カードはこの後の通常解決で別管理する。ここでは特殊効果だけ止める。
    } else {
      if (a.special === 'double' && a.normal) doubled.add(a.p.playerId);
      if (a.special === 'fullDefense') {
        const protectedTarget = healTargetIsValid(room, a.specialTargetId || a.p.playerId);
        if (protectedTarget) {
          if (!fullDefense.has(protectedTarget.playerId)) fullDefense.set(protectedTarget.playerId, []);
          fullDefense.get(protectedTarget.playerId).push(a.p);
        }
      }
    }
    if (a.normal === 'defense') {
      // 2倍防御は2回分を個別指定できる。成功得点の2倍は「2回目だけ」に適用する。
      const uses = [{ targetId:a.normalTargetId, cardMultiplier:1 }];
      if (doubled.has(a.p.playerId)) uses.push({ targetId:a.secondNormalTargetId || a.normalTargetId, cardMultiplier:2 });
      const byTarget = new Map();
      for (const use of uses) {
        const target = healTargetIsValid(room, use.targetId);
        if (!target) continue;
        if (!byTarget.has(target.playerId)) byTarget.set(target.playerId, []);
        byTarget.get(target.playerId).push(use.cardMultiplier);
      }
      for (const [targetId, multipliers] of byTarget) {
        if (!defenseClaims.has(targetId)) defenseClaims.set(targetId, []);
        defenseClaims.get(targetId).push({ defender:a.p, power:multipliers.length, multipliers });
        if (!effectiveDefenseTargets.has(a.p.playerId)) effectiveDefenseTargets.set(a.p.playerId, new Set());
        effectiveDefenseTargets.get(a.p.playerId).add(targetId);
      }
    }
  }

  // 回復は攻撃より先に解決する。2倍カードは「回復を2回」行い、2回目は同一/別対象を選べる。
  // 同じ対象を2回選んだ場合は+4相当（最大HP5）。他人回復は1回目・2回目を個別成功判定し、成功得点の2倍は2回目だけ。
  // 回復成功判定はターン開始時HPを基準にする。同じ負傷者へ複数人の回復が重なっても、
  // その対象が開始時点で最大HP未満なら、対象へ有効な回復を出した各プレイヤーを成功扱いにする。
  // 開始時点から最大HPなら、実回復量にかかわらず成功点は発生しない。
  for (const a of actions.values()) {
    if (canceledNormal.has(a.p.playerId) || a.normal !== 'heal' || !a.p.alive) continue;
    const healUses = [{ targetId:a.normalTargetId, cardMultiplier:1 }];
    if (doubled.has(a.p.playerId)) healUses.push({ targetId:a.secondNormalTargetId || a.normalTargetId, cardMultiplier:2 });
    const usesByTarget = new Map();
    for (const use of healUses) {
      const target = healTargetIsValid(room, use.targetId);
      if (!target) continue;
      if (!usesByTarget.has(target.playerId)) usesByTarget.set(target.playerId, []);
      usesByTarget.get(target.playerId).push(use);
    }
    if (!effectiveHealTargets.has(a.p.playerId)) effectiveHealTargets.set(a.p.playerId, new Set());
    for (const [targetId, uses] of usesByTarget) {
      const target = healTargetIsValid(room, targetId);
      if (!target) continue;
      const count = uses.length;
      // 公開契約の回復条件は、実際に有効な回復カードを指定対象へ使ったかで判定する。
      // HP満タンで実回復量が0でも、カード使用自体が有効なら契約上は達成対象になる。
      effectiveHealTargets.get(a.p.playerId).add(target.playerId);
      const amount = 2 * count;
      const before = target.hp;
      target.hp = clamp(target.hp + amount, 0, target.maxHp);
      const healed = target.hp - before;
      const targetText = target.playerId === a.p.playerId ? '' : `${target.color.label}を`;
      const damagedAtTurnStart = Number(turnStartHp.get(target.playerId)) < Number(target.maxHp);
      const overlapSuccess = target.playerId !== a.p.playerId && damagedAtTurnStart && healed === 0;
      privateEvents.push({
        to: a.p.playerId,
        type: 'notice',
        text: overlapSuccess
          ? `${targetText}回復は重複しました（成功判定）。実回復0。`
          : `${targetText}HPを${healed}回復しました。`
      });
      if (damagedAtTurnStart) {
        // 回復成功Pはターン開始時HPを基準に判定する。2倍カードは2回目だけ成功P2倍。
        const isSelf = target.playerId === a.p.playerId;
        const baseScore = isSelf ? SCORING.healSelfSuccess : SCORING.healOtherSuccess;
        const reason = isSelf ? '自分回復成功' : '他人回復成功';
        for (const use of uses) {
          awardNormalSuccess(room, a.p, 'heal', target.playerId, baseScore, reason, scoreEvents, { cardMultiplier: use.cardMultiplier });
        }
      }
      if (target.playerId !== a.p.playerId) {
        privateEvents.push({ to: target.playerId, type: 'notice', text: `HPを${healed}回復されました。` });
      }
    }
  }

  // 攻撃を対象ごとに同時集計。2倍カードは「攻撃を2回」行い、2回目は別対象にも同一対象にも指定できる。
  // 同一対象へ2回攻撃した場合も、通った攻撃回数ごとに成功判定する。成功得点の2倍は2回目だけ。
  const incoming = new Map();
  const effectiveAttackTargets = new Map();
  for (const a of actions.values()) {
    if (canceledNormal.has(a.p.playerId) || a.normal !== 'attack') continue;
    const attackUses = [{ targetId:a.normalTargetId, cardMultiplier:1 }];
    if (doubled.has(a.p.playerId)) attackUses.push({ targetId:a.secondNormalTargetId || a.normalTargetId, cardMultiplier:2 });
    let registered = 0;
    for (const use of attackUses) {
      const targetId = use.targetId;
      const target = getPlayer(room, targetId);
      if (!target || !target.alive || target.playerId === a.p.playerId) continue;
      if (!incoming.has(target.playerId)) incoming.set(target.playerId, []);
      incoming.get(target.playerId).push({ attacker: a.p, power: 1, cardMultiplier: use.cardMultiplier });
      if (!effectiveAttackTargets.has(a.p.playerId)) effectiveAttackTargets.set(a.p.playerId, new Set());
      effectiveAttackTargets.get(a.p.playerId).add(target.playerId);
      a.p.stats.attackTargets.push(target.playerId);
      addUnique(target.stats.attackedBy, a.p.playerId);
      registered++;
    }
    if (registered > 0) {
      a.p.stats.attacksUsed += registered;
      if (a.p.stats.lastAttackTurn === room.turn - 1) a.p.stats.consecutiveAttackTurns++;
      else a.p.stats.consecutiveAttackTurns = 1;
      a.p.stats.lastAttackTurn = room.turn;
    }
  }

  for (const [targetId, hits] of incoming.entries()) {
    const target = getPlayer(room, targetId);
    const totalPower = hits.reduce((sum, hit) => sum + hit.power, 0);
    const claims = defenseClaims.get(targetId) || [];
    const normalDefensePower = claims.reduce((sum, claim) => sum + claim.power, 0);
    const blockedPower = fullDefense.has(targetId)
      ? totalPower
      : Math.min(totalPower, normalDefensePower);
    const damage = Math.max(0, totalPower - blockedPower);

    // 通常防御は、対象に有効な攻撃が1以上あり、通常防御で1以上を防げた場合に成功。
    // 同じ対象を複数人が防御したときは、攻撃数より防御人数が多くても防御参加者全員を成功扱いにする。
    // 完全防御が成立した場合は従来どおり通常防御側には成功得点を付けない。
    if (!fullDefense.has(targetId) && blockedPower > 0 && claims.length) {
      for (const claim of claims) {
        // 既存の「同じ対象を守った各参加者は成功」ルールを維持しつつ、
        // 2倍防御の同一対象2回は実際に防げた回数まで成功回数として数える。
        const successCount = Math.min(Math.max(1, claim.power || 1), blockedPower);
        claim.defender.stats.defenseSuccessTurns += successCount;
        const defenseScore = claim.defender.playerId === targetId ? SCORING.defenseSuccess : SCORING.defenseOtherSuccess;
        const multipliers = Array.isArray(claim.multipliers) && claim.multipliers.length ? claim.multipliers : [1];
        // 防御が1回分だけ成功する場合は1回目を成功扱い。2回とも成功したときだけ2回目が2倍。
        for (let i = 0; i < successCount; i++) {
          awardNormalSuccess(room, claim.defender, 'defense', targetId, defenseScore, '防御成功', scoreEvents, { cardMultiplier: multipliers[i] || 1 });
        }
      }
    }
    if (fullDefense.has(targetId)) {
      const protectors = [...new Map((fullDefense.get(targetId) || []).map(p => [p.playerId, p])).values()];
      for (const protector of protectors) {
        fullDefenseSucceeded.add(protector.playerId);
        awardPoints(room, protector, SCORING.fullDefenseSuccess, '完全防御成功', scoreEvents, { multiplyFinal:false });
      }
    }

    if (damage > 0) {
      const actualDamage = Math.min(damage, target.hp);
      target.hp -= actualDamage;
      target.stats.damageTaken += actualDamage;
      // 防御を上回って1以上のダメージが出た場合、その対象への有効攻撃参加者は成功。
      // 2倍攻撃で同一対象へ2回出した場合は、通った攻撃回数まで個別成功扱いにし、2回目だけ成功得点を2倍。
      const hitsByAttacker = new Map();
      for (const hit of hits) {
        const id = hit.attacker.playerId;
        if (!hitsByAttacker.has(id)) hitsByAttacker.set(id, { attacker: hit.attacker, multipliers: [] });
        hitsByAttacker.get(id).multipliers.push(hit.cardMultiplier || 1);
      }
      for (const { attacker, multipliers } of hitsByAttacker.values()) {
        const successCount = Math.min(multipliers.length, damage);
        attacker.stats.attacksHit += successCount;
        // 防御で一部だけ通る場合は後の攻撃が通った扱いにする。2回目だけ得点2倍。
        const successfulMultipliers = multipliers.slice(Math.max(0, multipliers.length - successCount));
        for (const cardMultiplier of successfulMultipliers) {
          awardNormalSuccess(room, attacker, 'attack', targetId, SCORING.attackHit, '攻撃成功', scoreEvents, { cardMultiplier });
        }
      }
      publicEvents.push({ type: 'attack', text: `${hits.map(h => h.attacker.color.label).join('・')}の攻撃が${target.color.label}に${actualDamage}ダメージ` });
    } else {
      publicEvents.push({ type: 'defense', text: `${target.color.label}が攻撃を防いだ` });
    }

    if (target.hp <= 0) {
      target.hp = 0;
      target.alive = false;
      target.stats.eliminatedTurn = room.turn;
      const contributors = [...new Map(hits.map(h => [h.attacker.playerId, h.attacker])).values()];
      if (contributors.length === 1) {
        const killer = contributors[0];
        killer.stats.soloKills++;
        addUnique(killer.stats.killTargets, target.playerId);
      } else {
        for (const killer of contributors) {
          killer.stats.jointKills++;
          addUnique(killer.stats.killTargets, target.playerId);
        }
      }
      publicEvents.push({ type: 'death', text: `${target.color.label}が脱落した` });
    }
  }

  for (const a of actions.values()) {
    if (a.special !== 'fullDefense') continue;
    const success = !canceledSpecial.has(a.p.playerId) && fullDefenseSucceeded.has(a.p.playerId);
    privateEvents.push({ to: a.p.playerId, type: 'specialResult', special: 'fullDefense', success, text: `完全防御${success ? '成功' : '失敗'}` });
  }
  for (const a of actions.values()) {
    if (a.special === 'specify' && canceledSpecial.has(a.p.playerId)) privateEvents.push({ to: a.p.playerId, type: 'specialResult', special: 'specify', success: false, text: 'カード指定失敗：無効カードで打ち消されました。' });
    if (a.special === 'steal' && canceledSpecial.has(a.p.playerId)) privateEvents.push({ to: a.p.playerId, type: 'specialResult', special: 'steal', success: false, text: 'ポイント泥棒失敗：無効カードで打ち消されました。' });
  }

  // 偵察。HP・キル数・通常カードだけを本人へ返す。成功+10P。
  for (const a of actions.values()) {
    if (canceledNormal.has(a.p.playerId) || a.normal !== 'scout') continue;
    const uses = [{ targetId:a.normalTargetId, cardMultiplier:1 }];
    if (doubled.has(a.p.playerId) && a.secondNormalTargetId && a.secondNormalTargetId !== a.normalTargetId) {
      uses.push({ targetId:a.secondNormalTargetId, cardMultiplier:2 });
    }
    let scoutedThisTurn = false;
    for (const use of uses) {
      const target = getPlayer(room, use.targetId);
      if (!target || target.playerId === a.p.playerId) continue;
      scoutedThisTurn = true;
      a.p.stats.scoutedTargets.push(target.playerId);
      a.p.stats.scoutCounts[target.playerId] = (a.p.stats.scoutCounts[target.playerId] || 0) + 1;
      const report = {
        turn: room.turn,
        targetId: target.playerId,
        color: target.color.label,
        hp: target.hp,
        kills: target.stats.soloKills + target.stats.jointKills,
        hand: { ...target.hand }
      };
      a.p.scoutReports.push(report);
      if (a.p.scoutReports.length > 30) a.p.scoutReports.shift();
      privateEvents.push({ to: a.p.playerId, type: 'scout', report });
      awardNormalSuccess(room, a.p, 'scout', target.playerId, SCORING.scoutSuccess, '偵察成功', scoreEvents, { cardMultiplier: use.cardMultiplier });
    }
    if (scoutedThisTurn) {
      if (a.p.stats.lastScoutTurn === room.turn - 1) a.p.stats.consecutiveScoutTurns++;
      else a.p.stats.consecutiveScoutTurns = 1;
      a.p.stats.lastScoutTurn = room.turn;
    }
  }

  // 告発も同時判定。同じ対象を複数人が同時に正解した場合、全員が成功する。
  const accusationAttempts = [];
  const effectiveAccusationTargets = new Map();
  for (const a of actions.values()) {
    if (canceledNormal.has(a.p.playerId) || a.normal !== 'accusation') continue;
    const tries = [{ targetId: a.normalTargetId, guess: a.accusationGuess, cardMultiplier:1 }];
    if (doubled.has(a.p.playerId) && a.secondNormalTargetId && a.secondAccusationGuess) {
      tries.push({ targetId: a.secondNormalTargetId, guess: a.secondAccusationGuess, cardMultiplier:2 });
    }
    for (const tr of tries) {
      const target = getPlayer(room, tr.targetId);
      if (!target || target.playerId === a.p.playerId) continue;
      accusationAttempts.push({ actor: a.p, target, guess: tr.guess, cardMultiplier: tr.cardMultiplier || 1, targetWasValid: !target.secretState.invalid });
      if (!effectiveAccusationTargets.has(a.p.playerId)) effectiveAccusationTargets.set(a.p.playerId, new Set());
      effectiveAccusationTargets.get(a.p.playerId).add(target.playerId);
    }
  }
  const successfulByTarget = new Map();
  for (const attempt of accusationAttempts) {
    const success = attempt.targetWasValid && attempt.target.objective?.key === attempt.guess;
    if (!success) {
      const penalty = awardPoints(room, attempt.actor, SCORING.accusationFailure, '告発失敗', scoreEvents, { multiplyFinal:false });
      privateEvents.push({ to: attempt.actor.playerId, type: 'notice', text: `告発は失敗しました（${penalty}P）。` });
      continue;
    }
    awardNormalSuccess(room, attempt.actor, 'accusation', attempt.target.playerId, SCORING.accusationSuccess, '告発成功', scoreEvents, { cardMultiplier: attempt.cardMultiplier || 1 });
    attempt.actor.stats.successfulAccusations++;
    if (!attempt.actor.stats.scoutedTargets.includes(attempt.target.playerId)) attempt.actor.stats.unscoutedAccusationSuccesses++;
    if (!successfulByTarget.has(attempt.target.playerId)) successfulByTarget.set(attempt.target.playerId, []);
    if (!successfulByTarget.get(attempt.target.playerId).some(x => x.playerId === attempt.actor.playerId)) successfulByTarget.get(attempt.target.playerId).push(attempt.actor);
  }
  for (const [targetId, actors] of successfulByTarget) {
    const target = getPlayer(room, targetId);
    if (target.secretState.achieved && target.secretState.awardedPoints > 0) {
      // 既に使っていても没収を回避できないよう、獲得した秘密目標得点を全額差し引く。
      const confiscated = target.secretState.awardedPoints;
      target.points -= confiscated;
      target.secretState.awardedPoints = 0;
      scoreEvents.push({ playerId: target.playerId, base: -confiscated, actual: -confiscated, reason: '秘密目標得点没収' });
    }
    target.secretState.invalid = true;
    publicEvents.push({ type: 'accusation', text: `${actors.map(x => x.color.label).join('・')}の告発成功。${target.color.label}の秘密目標は「${target.objective.label}」` });
  }


  for (const p of startedAlive) if (p.alive) p.stats.survivedTurns++;

  const newlyAchieved = evaluateObjectives(room, scoreEvents);
  for (const pid of newlyAchieved) {
    const p = getPlayer(room, pid);
    privateEvents.push({ to: pid, type: 'notice', text: `秘密目標「${p.objective.label}」を達成しました。` });
  }

  // 公開契約判定で、カード指定により強制された行動内容も記録する。報酬は実行者本人へ入る。
  const specifiedActionsByPlayer = {};
  for (const p of room.players) {
    const forced = p.forcedNormalType;
    if (forced?.turn === room.turn && !forced.conflict && forced.type && forced.targetId && Array.isArray(forced.rewardPlayerIds) && forced.rewardPlayerIds.length) {
      specifiedActionsByPlayer[p.playerId] = {
        type: forced.type,
        targetId: forced.targetId,
        rewardPlayerIds: [...new Set(forced.rewardPlayerIds)]
      };
    }
  }

  // 公開契約の自動判定用。無効カードで消された攻撃や不正対象は含めず、
  // 実際に有効な行動として登録された対象だけをサーバー内部へ残す。
  room.lastEffectiveActions = {
    turn: room.turn,
    attacksByPlayer: Object.fromEntries([...effectiveAttackTargets.entries()].map(([playerId, ids]) => [playerId, [...ids]])),
    defensesByPlayer: Object.fromEntries([...effectiveDefenseTargets.entries()].map(([playerId, ids]) => [playerId, [...ids]])),
    healsByPlayer: Object.fromEntries([...effectiveHealTargets.entries()].map(([playerId, ids]) => [playerId, [...ids]])),
    accusationsByPlayer: Object.fromEntries([...effectiveAccusationTargets.entries()].map(([playerId, ids]) => [playerId, [...ids]])),
    specifiedActionsByPlayer
  };

  for (const p of room.players) {
    if (p.forcedNormalType?.turn === room.turn) p.forcedNormalType = null;
  }

  return { privateEvents, publicEvents, scoreEvents };
}

function awardTurnStartBonus(room) {
  const amount = Number(TURN_START_BONUSES[room.turn] || 0);
  if (!amount) return [];
  if (!Array.isArray(room.turnStartBonusesAwarded)) room.turnStartBonusesAwarded = [];
  if (room.turnStartBonusesAwarded.includes(room.turn)) return [];
  room.turnStartBonusesAwarded.push(room.turn);
  const events = [];
  for (const p of room.players) {
    if (!p.alive) continue;
    awardPoints(room, p, amount, `第${room.turn}ターン開始ボーナス`, events, { multiplyFinal: false });
  }
  return events;
}

function awardSurvivalBonus(room) {
  // 15ターン完走時だけ付与。早期終了経路から誤って呼ばれても+50Pを発生させない。
  if (room.turn < MAX_TURNS || room.survivalBonusAwarded) return [];
  room.survivalBonusAwarded = true;
  const events = [];
  for (const p of room.players) {
    if (!p.alive) continue;
    awardPoints(room, p, SCORING.survival, '15ターン生存', events, { multiplyFinal: false });
  }
  return events;
}

function objectiveTieValue(p) {
  return p.secretState.achieved && !p.secretState.invalid ? 1 : 0;
}
function rankingTuple(p) {
  return [
    p.points,
    p.stats.soloKills + p.stats.jointKills,
    p.stats.successfulAccusations,
    objectiveTieValue(p),
    p.stats.survivedTurns,
    p.hp
  ];
}
function comparePlayers(a, b) {
  const A = rankingTuple(a), B = rankingTuple(b);
  for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) return B[i] - A[i];
  return 0;
}
function sameRank(a, b) {
  const A = rankingTuple(a), B = rankingTuple(b);
  return A.every((v, i) => v === B[i]);
}
function currentPointsStanding(room, playerId) {
  const player = getPlayer(room, playerId);
  if (!player) return null;
  const points = Number(player.points || 0);
  const rank = 1 + room.players.filter(other => Number(other.points || 0) > points).length;
  const tiedCount = room.players.filter(other => Number(other.points || 0) === points).length;
  return {
    rank,
    tied: tiedCount > 1,
    tiedCount,
    total: room.players.length
  };
}

function buildRanking(room) {
  const sorted = [...room.players].sort(comparePlayers);
  let rank = 0;
  let prev = null;
  return sorted.map((p, index) => {
    if (!prev || !sameRank(prev, p)) rank = index + 1;
    prev = p;
    return {
      rank,
      playerId: p.playerId,
      color: p.color?.label || '',
      points: p.points,
      hp: p.hp,
      kills: p.stats.soloKills + p.stats.jointKills,
      accusations: p.stats.successfulAccusations,
      objective: p.objective?.label || '',
      objectiveAchieved: p.secretState.achieved,
      objectiveInvalid: p.secretState.invalid,
      survivedTurns: p.stats.survivedTurns
    };
  });
}


function canPlaceWinnerBet(room, p) {
  return !!(room && p && room.status === 'playing' && room.phase === 'chat' && p.alive && !p.winnerBet && WINNER_BET.allowedTurns.includes(room.turn));
}

function placeWinnerBet(room, p, targetId, amount) {
  if (!canPlaceWinnerBet(room, p)) return { ok:false, message:'1位予想は第3・6・9ターンの会話・行動選択中に1回だけ賭けられます。' };
  const target = getPlayer(room, targetId);
  const n = Number(amount);
  if (!target) return { ok:false, message:'予想するプレイヤーが不正です。' };
  if (!Number.isInteger(n) || n < WINNER_BET.step || n % WINNER_BET.step !== 0 || n > p.points) return { ok:false, message:'賭けポイントは所持P以内の5P刻みで指定してください。' };
  const multiplier = WINNER_BET.multipliers[room.turn];
  p.points -= n;
  p.winnerBet = { targetId: target.playerId, amount:n, placedTurn:room.turn, multiplier, settled:false, hit:null, payout:0 };
  return { ok:true, bet:{ ...p.winnerBet } };
}

function settleWinnerBets(room, preBetRanking = null) {
  const ranking = preBetRanking || buildRanking(room);
  const winnerIds = new Set(ranking.filter(row => row.rank === 1).map(row => row.playerId));
  const results = [];
  for (const p of room.players) {
    const bet = p.winnerBet;
    if (!bet || bet.settled) continue;
    const hit = winnerIds.has(bet.targetId);
    const payout = hit ? Number((bet.amount * bet.multiplier).toFixed(1)) : 0;
    if (payout) p.points += payout;
    bet.settled = true;
    bet.hit = hit;
    bet.payout = payout;
    const target = getPlayer(room, bet.targetId);
    results.push({
      playerId:p.playerId,
      color:p.color?.label || '',
      targetId:bet.targetId,
      targetColor:target?.color?.label || '',
      amount:bet.amount,
      placedTurn:bet.placedTurn,
      multiplier:bet.multiplier,
      hit,
      payout
    });
  }
  return results;
}

function splitChipPool(total, playerIds) {
  const ids = [...new Set((playerIds || []).filter(Boolean))];
  if (!ids.length || !(Number(total) > 0)) return [];
  const totalCents = Math.round(Number(total) * 100);
  const base = Math.floor(totalCents / ids.length);
  let remainder = totalCents - base * ids.length;
  return ids.map(playerId => {
    const cents = base + (remainder-- > 0 ? 1 : 0);
    return { playerId, amount: cents / 100 };
  });
}

function settleChipWager(room) {
  const stake = Number(room?.chipStake || 0);
  const multiplier = Number(GOGI_CHIPS.payoutMultiplier || 2.5);
  const pot = Number((stake * room.players.length).toFixed(2));

  // 五戯チップ賞金は「第1順位1位」と「第2順位1位」にそれぞれ賭け額×2.5。
  // 第1順位 = 1位予想払戻し前、 第2順位 = 1位予想払戻し後の最終順位。
  const firstRankingPool = Number((stake * multiplier).toFixed(2));
  const secondRankingPool = Number((stake * multiplier).toFixed(2));
  const firstRanking = Array.isArray(room.preBetRanking) && room.preBetRanking.length
    ? room.preBetRanking
    : (Array.isArray(room.finishedRanking) ? room.finishedRanking : buildRanking(room));
  const secondRanking = Array.isArray(room.finishedRanking) && room.finishedRanking.length
    ? room.finishedRanking
    : buildRanking(room);
  const firstRankingWinnerIds = firstRanking.filter(row => row.rank === 1).map(row => row.playerId);
  const secondRankingWinnerIds = secondRanking.filter(row => row.rank === 1).map(row => row.playerId);
  const firstRankingAwards = stake > 0 ? splitChipPool(firstRankingPool, firstRankingWinnerIds) : [];
  const secondRankingAwards = stake > 0 ? splitChipPool(secondRankingPool, secondRankingWinnerIds) : [];

  const byPlayer = new Map(room.players.map(p => [p.playerId, {
    playerId:p.playerId,
    color:p.color?.label || '',
    firstRankingAward:0,
    secondRankingAward:0,
    // 旧クライアント互換用エイリアス。意味はそれぞれ第1順位・第2順位賞金。
    gameAward:0,
    predictionAward:0,
    totalAward:0
  }]));
  for (const award of firstRankingAwards) {
    const p = getPlayer(room, award.playerId);
    if (!p) continue;
    p.chips = Number((Number(p.chips || 0) + award.amount).toFixed(2));
    const row = byPlayer.get(p.playerId);
    row.firstRankingAward = Number(award.amount.toFixed(2));
    row.gameAward = row.firstRankingAward;
  }
  for (const award of secondRankingAwards) {
    const p = getPlayer(room, award.playerId);
    if (!p) continue;
    p.chips = Number((Number(p.chips || 0) + award.amount).toFixed(2));
    const row = byPlayer.get(p.playerId);
    row.secondRankingAward = Number(award.amount.toFixed(2));
    row.predictionAward = row.secondRankingAward;
  }
  for (const p of room.players) {
    const row = byPlayer.get(p.playerId);
    row.totalAward = Number((row.firstRankingAward + row.secondRankingAward).toFixed(2));
    p.chipPayout = { ...row };
  }
  const totalAwarded = Number([...byPlayer.values()].reduce((sum, row) => sum + row.totalAward, 0).toFixed(2));
  return {
    stake,
    pot,
    multiplier,
    firstRankingPool,
    secondRankingPool,
    firstRankingWinnerIds,
    secondRankingWinnerIds,
    // 旧クライアント互換用エイリアス。
    gamePool:firstRankingPool,
    predictionPool:secondRankingPool,
    gameWinnerIds:firstRankingWinnerIds,
    predictionWinnerIds:secondRankingWinnerIds,
    predictionFallbackToFinalWinner:false,
    totalAwarded,
    unawarded: Number(Math.max(0, pot - totalAwarded).toFixed(2)),
    results: [...byPlayer.values()]
  };
}

module.exports = {
  randomId, randomToken, shuffle, emptyDraft, createPlayer, createRoom, getPlayer,
  startGame, validateDraft, resolveTurn, evaluateObjectives, awardTurnStartBonus, awardSurvivalBonus,
  buildRanking, currentPointsStanding, canPlaceWinnerBet, placeWinnerBet, settleWinnerBets, settleChipWager, awardPoints, randomRoomCode,
  objectiveAchieved, ensureSecretObjectives,
  sanitizeDraft, draftForResolution, canTransferNormalCard, specifiedActionTargetIsValid
};
