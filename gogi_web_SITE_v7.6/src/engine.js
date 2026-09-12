'use strict';

const crypto = require('crypto');
const {
  MAX_PLAYERS, MAX_TURNS, COLORS, NORMAL_CARDS, SPECIAL_CARDS, OBJECTIVES,
  SECRET_REWARD, SCORING, STEAL_AMOUNTS, TURN_START_BONUSES, WINNER_BET, ROOM_CODE_LENGTH, ROOM_CODE_ALPHABET,
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
    stealAmount: 5,
    specifiedType: null
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
    afkStreak: 0,
    turnHadManualInput: false,
    color: null,
    hp: 5,
    maxHp: 5,
    points: 0,
    alive: true,
    hand: baseHand(),
    specials: emptySpecials(),
    specialPurchased: false,
    normalPurchasedTurn: null,
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

function createRoom({ isPublic = false, code = null } = {}) {
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
    exchangeRequests: [],
    publicContracts: [],
    lastEffectiveActions: null,
    survivalBonusAwarded: false,
    turnStartBonusesAwarded: []
  };
}

function getPlayer(room, playerId) {
  return room.players.find(p => p.playerId === playerId) || null;
}


function ensureSecretObjectives(room, rng = null) {
  if (!room || !Array.isArray(room.players) || !room.players.length) return room;
  if (!['playing', 'finished'].includes(room.status)) return room;
  const validByKey = new Map(OBJECTIVES.map(objective => [objective.key, objective]));
  const used = new Set();
  for (const p of room.players) {
    const key = p?.objective?.key;
    if (key && validByKey.has(key)) used.add(key);
  }
  for (const p of room.players) {
    const key = p?.objective?.key;
    if (key && validByKey.has(key)) {
      if (!p.secretState || typeof p.secretState !== 'object') {
        p.secretState = { achieved:false, invalid:false, achievedTurn:null, awardedPoints:0 };
      }
      continue;
    }
    const available = OBJECTIVES.filter(objective => !used.has(objective.key));
    const pool = available.length ? available : OBJECTIVES;
    if (!pool.length) throw new Error('秘密目標定義がありません。');
    const index = rng ? Math.floor(rng() * pool.length) : crypto.randomInt(pool.length);
    p.objective = pool[Math.max(0, Math.min(pool.length - 1, index))];
    p.secretState = { achieved:false, invalid:false, achievedTurn:null, awardedPoints:0 };
    used.add(p.objective.key);
  }
  return room;
}

function startGame(room, rng = null) {
  if (room.players.length !== MAX_PLAYERS) throw new Error('5人揃っていません。');
  const colors = shuffle(COLORS, rng);
  const specials = shuffle(Object.keys(SPECIAL_CARDS), rng);
  const objectives = shuffle(OBJECTIVES, rng);

  room.status = 'playing';
  room.turn = 1;
  room.phase = 'chat';
  room.finishedAt = null;
  room.finishedRanking = null;
  room.preBetRanking = null;
  room.winnerBetResults = null;
  room.exchangeRequests = [];
  room.publicContracts = [];
  room.lastEffectiveActions = null;
  room.survivalBonusAwarded = false;
  room.turnStartBonusesAwarded = [];

  room.players.forEach((p, i) => {
    p.color = colors[i];
    p.hp = 5;
    p.maxHp = 5;
    p.points = 0;
    p.alive = true;
    p.hand = baseHand();
    p.specials = emptySpecials();
    p.specials[specials[i]] = 1;
    p.specialPurchased = false;
    p.normalPurchasedTurn = null;
    p.objective = objectives[i];
    p.secretState = { achieved: false, invalid: false, achievedTurn: null, awardedPoints: 0 };
    p.draft = emptyDraft();
    p.ready = false;
    p.autoReadySeq = null;
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
function awardPoints(room, player, base, reason, scoreEvents, { multiplyFinal = true } = {}) {
  const actual = base * (multiplyFinal ? scoreMultiplier(room) : 1);
  player.points += actual;
  if (scoreEvents) scoreEvents.push({ playerId: player.playerId, base, actual, reason });
  return actual;
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

function sanitizeDraft(draft) {
  const src = draft && typeof draft === 'object' ? draft : {};
  const base = emptyDraft();
  for (const key of Object.keys(base)) if (hasOwn(src, key)) base[key] = src[key];
  return base;
}

function validateDraft(room, p, draft, { strict = false } = {}) {
  if (!p || !p.alive) return { ok: false, message: '脱落中は行動できません。' };
  const d = sanitizeDraft(draft);

  if (d.normal && !hasOwn(NORMAL_CARDS, d.normal)) return { ok: false, message: '通常カードが不正です。' };
  if (d.special && !hasOwn(SPECIAL_CARDS, d.special)) return { ok: false, message: '特殊カードが不正です。' };
  if (d.stealAmount != null && !STEAL_AMOUNTS.includes(Number(d.stealAmount))) return { ok: false, message: '盗むポイント数が不正です。' };
  if (d.specifiedType && !hasOwn(NORMAL_CARDS, d.specifiedType)) return { ok: false, message: 'カード指定の種類が不正です。' };

  // カード指定は次ターンの通常カードを強制する。複数の異なる指定が競合した場合は全行動なし。
  if (p.forcedNormalType?.turn === room.turn) {
    if (p.forcedNormalType.conflict) {
      if (strict) return { ok: true, draft: emptyDraft(), forcedNoAction: true, forcedConflict: true };
      d.normal = null;
      d.special = null;
    } else {
      const forced = p.forcedNormalType.type;
      if ((p.hand[forced] || 0) <= 0) {
        // 行動確定時点でも持っていなければ、そのターンは全行動なし。
        if (strict) return { ok: true, draft: emptyDraft(), forcedNoAction: true };
        d.normal = null;
      } else {
        if (d.normal && d.normal !== forced) return { ok: false, message: `このターンは「${NORMAL_CARDS[forced].label}」指定です。` };
        d.normal = forced;
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
  if (!(d.special === 'double' && ['attack', 'scout', 'accusation'].includes(d.normal))) {
    d.secondNormalTargetId = null;
    d.secondAccusationGuess = null;
  }
  if (!['cancel', 'specify', 'steal'].includes(d.special)) d.specialTargetId = null;
  if (d.special !== 'specify') d.specifiedType = null;

  if (!strict) return { ok: true, draft: d };

  if (d.special === 'double' && !d.normal) return { ok: false, message: '2倍カードには通常カードが必要です。' };

  if (d.normal === 'attack' && !targetIsValid(room, p, d.normalTargetId)) {
    return { ok: false, message: '通常カードの対象を選択してください。' };
  }
  if (d.normal === 'scout' && !targetIsValid(room, p, d.normalTargetId, { aliveOnly: false })) {
    return { ok: false, message: '通常カードの対象を選択してください。' };
  }
  if (d.normal === 'accusation' && !targetIsValid(room, p, d.normalTargetId, { aliveOnly: false })) {
    return { ok: false, message: '告発する対象を選択してください。' };
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

  const specialNeedsTarget = ['cancel', 'specify', 'steal'].includes(d.special);
  if (specialNeedsTarget && !targetIsValid(room, p, d.specialTargetId)) {
    return { ok: false, message: '特殊カードの対象を選択してください。' };
  }
  if (d.special === 'specify' && !d.specifiedType) return { ok: false, message: '指定する通常カードを選択してください。' };
  if (d.special === 'steal' && !STEAL_AMOUNTS.includes(Number(d.stealAmount))) return { ok: false, message: '盗むポイント数を選択してください。' };

  if (d.special === 'double' && d.normal === 'attack' && d.secondNormalTargetId) {
    const second = targetIsValid(room, p, d.secondNormalTargetId);
    if (!second) return { ok: false, message: '2回目の攻撃対象が不正です。' };
  }
  if (d.special === 'double' && d.normal === 'scout' && d.secondNormalTargetId) {
    const second = targetIsValid(room, p, d.secondNormalTargetId, { aliveOnly: false });
    if (!second || d.secondNormalTargetId === d.normalTargetId) return { ok: false, message: '2人目の偵察対象が不正です。' };
  }
  if (d.special === 'double' && d.normal === 'accusation' && d.secondNormalTargetId) {
    const second = targetIsValid(room, p, d.secondNormalTargetId, { aliveOnly: false });
    if (!second) return { ok: false, message: '2回目の告発対象が不正です。' };
    if (!OBJECTIVES.some(x => x.key === d.secondAccusationGuess)) return { ok: false, message: '2回目の告発内容を選択してください。' };
  }

  return { ok: true, draft: d };
}

// タイムアウト時の解決用。通常は未完成選択を行動なしにするが、
// カード指定で強制された通常カードを所持している場合だけは「選択逃れ」を防ぐ。
// 対象や告発内容が未選択でも、有効候補がある場合はサーバーが自動補完して指定カードを実行する。
function draftForResolution(room, p) {
  const strict = validateDraft(room, p, p.draft, { strict: true });
  if (strict.ok) return strict.draft;

  const forced = p.forcedNormalType?.turn === room.turn && !p.forcedNormalType.conflict
    ? p.forcedNormalType.type
    : null;
  if (!forced || (p.hand[forced] || 0) <= 0) return emptyDraft();

  const action = sanitizeDraft(p.draft);
  action.normal = forced;
  // 強制通常カードの未完成入力だけを例外的に消費対象にする。
  // 特殊カード側まで未完成なら、タイムアウトで貴重な特殊カードを誤消費しない。
  if (action.special && (!hasOwn(SPECIAL_CARDS, action.special) || (p.specials[action.special] || 0) <= 0)) action.special = null;
  if (['cancel','specify','steal'].includes(action.special) && !targetIsValid(room, p, action.specialTargetId)) action.special = null;
  if (action.special === 'specify' && (!action.specifiedType || !hasOwn(NORMAL_CARDS, action.specifiedType))) action.special = null;
  if (action.special === 'steal' && !STEAL_AMOUNTS.includes(Number(action.stealAmount))) action.special = null;
  if (action.special === 'double' && !action.normal) action.special = null;
  if (!action.special) {
    action.specialTargetId = null;
    action.specifiedType = null;
  }

  const needsTarget = ['attack', 'defense', 'scout', 'accusation', 'heal'].includes(forced);
  const validOthers = room.players.filter(x => x.alive && x.playerId !== p.playerId);
  const validScoutTargets = room.players.filter(x => x.playerId !== p.playerId);
  const validAccusationTargets = room.players.filter(x => x.playerId !== p.playerId);
  if (forced === 'attack' && validOthers.length === 0) return emptyDraft();
  if (forced === 'scout' && validScoutTargets.length === 0) return emptyDraft();
  if (forced === 'accusation' && validAccusationTargets.length === 0) return emptyDraft();

  // カード指定は「そのカードを使う」強制なので、放置や対象未選択で効果まで回避できない。
  // 手動選択が有効なら尊重し、未選択/不正なら有効な相手から暗号学的乱数で1人を自動選択する。
  if (forced === 'heal' || forced === 'defense') {
    if (!healTargetIsValid(room, action.normalTargetId)) action.normalTargetId = p.playerId;
  } else if (forced === 'accusation') {
    if (!targetIsValid(room, p, action.normalTargetId, { aliveOnly: false })) {
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
  if (forced?.turn === room.turn && !forced.conflict && forced.type === type && (p.hand[type] || 0) <= 1) return false;
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

  // 特殊カードは所持中は非公開だが、使用（消費）した時点でカード名を全員へ公開する。
  // 対象・指定内容などの秘密情報まではここでは公開しない。
  for (const a of actions.values()) {
    if (!a.special) continue;
    publicEvents.push({ type: 'special', text: `${a.p.color.label}が特殊カード「${SPECIAL_CARDS[a.special].label}」を使用` });
  }

  // 無効カード同士の循環で処理順が勝敗を左右さないよう、全ての「無効」宣言を同時成立させる。
  const canceled = new Set();
  for (const a of actions.values()) {
    if (a.special !== 'cancel') continue;
    const target = getPlayer(room, a.specialTargetId);
    if (target && target.playerId !== a.p.playerId) canceled.add(target.playerId);
  }

  // カード指定は対象ごとに同時解決。異なる指定が重なった場合は、次ターンの全行動なし。
  const specifyClaims = new Map();
  const stealClaims = new Map();
  for (const a of actions.values()) {
    if (canceled.has(a.p.playerId)) continue;
    if (a.special === 'specify') {
      const target = getPlayer(room, a.specialTargetId);
      if (target && target.alive && a.specifiedType && hasOwn(NORMAL_CARDS, a.specifiedType)) {
        if (!specifyClaims.has(target.playerId)) specifyClaims.set(target.playerId, []);
        specifyClaims.get(target.playerId).push({ actor: a.p, type: a.specifiedType });
      }
    }
    if (a.special === 'steal') {
      const target = getPlayer(room, a.specialTargetId);
      const requested = Number(a.stealAmount);
      if (target && target.alive && STEAL_AMOUNTS.includes(requested)) {
        if (!stealClaims.has(target.playerId)) stealClaims.set(target.playerId, []);
        stealClaims.get(target.playerId).push({ actor: a.p, requested });
      }
    }
  }

  for (const [targetId, claims] of specifyClaims) {
    const target = getPlayer(room, targetId);
    const uniqueTypes = [...new Set(claims.map(c => c.type))];
    if (uniqueTypes.length === 1) {
      target.forcedNormalType = { turn: room.turn + 1, type: uniqueTypes[0], conflict: false };
      privateEvents.push({ to: target.playerId, type: 'notice', text: `次ターンは「${NORMAL_CARDS[uniqueTypes[0]].label}」を指定されました。` });
    } else {
      target.forcedNormalType = { turn: room.turn + 1, type: null, conflict: true };
      privateEvents.push({ to: target.playerId, type: 'notice', text: '複数の異なるカード指定が競合したため、次ターンは行動なしです。' });
    }
  }

  // ポイント泥棒は全対象の「解決開始時点のポイント」を固定してから同時解決する。
  // A→B と B→A のような循環でも、先に処理された奪取で増えたポイントを同ターン中に再び奪えない。
  const stealStartPoints = new Map(room.players.map(p => [p.playerId, Math.max(0, p.points)]));
  const stealDeltas = new Map(room.players.map(p => [p.playerId, 0]));
  const stealNotices = [];
  for (const [targetId, claims] of stealClaims) {
    const target = getPlayer(room, targetId);
    let units = Math.floor((stealStartPoints.get(targetId) || 0) / 5);
    const allocations = new Map(claims.map(c => [c.actor.playerId, 0]));
    const demands = new Map(claims.map(c => [c.actor.playerId, Math.floor(c.requested / 5)]));
    const ordered = [...claims].sort((a, b) => {
      const ai = COLORS.findIndex(c => c.key === a.actor.color?.key);
      const bi = COLORS.findIndex(c => c.key === b.actor.color?.key);
      const ar = (ai - ((room.turn - 1) % COLORS.length) + COLORS.length) % COLORS.length;
      const br = (bi - ((room.turn - 1) % COLORS.length) + COLORS.length) % COLORS.length;
      return ar - br || a.actor.playerId.localeCompare(b.actor.playerId);
    });
    while (units > 0) {
      let progressed = false;
      for (const claim of ordered) {
        if (units <= 0) break;
        const pid = claim.actor.playerId;
        if ((allocations.get(pid) || 0) >= (demands.get(pid) || 0)) continue;
        allocations.set(pid, (allocations.get(pid) || 0) + 1);
        units--;
        progressed = true;
      }
      if (!progressed) break;
    }
    let totalStolen = 0;
    for (const claim of claims) {
      const actual = (allocations.get(claim.actor.playerId) || 0) * 5;
      totalStolen += actual;
      stealDeltas.set(claim.actor.playerId, (stealDeltas.get(claim.actor.playerId) || 0) + actual);
      stealNotices.push(actual > 0
        ? { to: claim.actor.playerId, type: 'notice', text: `${target.color.label}から${actual}P奪いました。` }
        : { to: claim.actor.playerId, type: 'notice', text: '相手に奪えるポイントがありませんでした。' });
    }
    if (totalStolen > 0) {
      stealDeltas.set(targetId, (stealDeltas.get(targetId) || 0) - totalStolen);
      stealNotices.push({ to: target.playerId, type: 'notice', text: `合計${totalStolen}P奪われました。` });
    }
  }
  for (const p of room.players) p.points += stealDeltas.get(p.playerId) || 0;
  privateEvents.push(...stealNotices);

  const doubled = new Set();
  const fullDefense = new Set();
  const defenseClaims = new Map();
  const effectiveDefenseTargets = new Map();
  for (const a of actions.values()) {
    if (canceled.has(a.p.playerId)) continue;
    if (a.special === 'double' && a.normal) doubled.add(a.p.playerId);
    // 完全防御は常に使用者本人だけを守る。
    if (a.special === 'fullDefense') fullDefense.add(a.p.playerId);
    if (a.normal === 'defense') {
      const target = healTargetIsValid(room, a.normalTargetId);
      if (target) {
        if (!defenseClaims.has(target.playerId)) defenseClaims.set(target.playerId, []);
        defenseClaims.get(target.playerId).push({ defender:a.p, power:doubled.has(a.p.playerId) ? 2 : 1 });
        if (!effectiveDefenseTargets.has(a.p.playerId)) effectiveDefenseTargets.set(a.p.playerId, new Set());
        effectiveDefenseTargets.get(a.p.playerId).add(target.playerId);
      }
    }
  }

  // 攻撃を対象ごとに同時集計。2倍カードは「攻撃を2回」行い、2回目は別対象にも同一対象にも指定できる。
  // 同一対象へ2回攻撃しても攻撃成功得点はその対象につき1回分。別々の対象へ通れば各対象で成功判定する。
  const incoming = new Map();
  const effectiveAttackTargets = new Map();
  for (const a of actions.values()) {
    if (canceled.has(a.p.playerId) || a.normal !== 'attack') continue;
    const targetIds = [a.normalTargetId];
    if (doubled.has(a.p.playerId)) targetIds.push(a.secondNormalTargetId || a.normalTargetId);
    let registered = 0;
    for (const targetId of targetIds) {
      const target = getPlayer(room, targetId);
      if (!target || !target.alive || target.playerId === a.p.playerId) continue;
      if (!incoming.has(target.playerId)) incoming.set(target.playerId, []);
      incoming.get(target.playerId).push({ attacker: a.p, power: 1 });
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

    // 通常防御は実際に防いだプレイヤー本人へ成功判定と得点を付ける。
    // 同じ対象へ複数人が防御した場合、1ダメージにつき1人分だけ成功として割り当てる。
    if (!fullDefense.has(targetId) && blockedPower > 0 && claims.length) {
      let remainingBlocked = blockedPower;
      const orderedClaims = [...claims].sort((a, b) => {
        const ai = COLORS.findIndex(c => c.key === a.defender.color?.key);
        const bi = COLORS.findIndex(c => c.key === b.defender.color?.key);
        const ar = (ai - ((room.turn - 1) % COLORS.length) + COLORS.length) % COLORS.length;
        const br = (bi - ((room.turn - 1) % COLORS.length) + COLORS.length) % COLORS.length;
        return ar - br || a.defender.playerId.localeCompare(b.defender.playerId);
      });
      for (const claim of orderedClaims) {
        if (remainingBlocked <= 0) break;
        const used = Math.min(claim.power, remainingBlocked);
        if (used <= 0) continue;
        claim.defender.stats.defenseSuccessTurns++;
        awardPoints(room, claim.defender, SCORING.defenseSuccess, '防御成功', scoreEvents);
        remainingBlocked -= used;
      }
    }
    if (fullDefense.has(targetId)) {
      awardPoints(room, target, new Set(hits.map(h => h.attacker.playerId)).size * SCORING.fullDefensePerAttacker, '完全防御', scoreEvents);
    }

    if (damage > 0) {
      const actualDamage = Math.min(damage, target.hp);
      target.hp -= actualDamage;
      target.stats.damageTaken += actualDamage;
      // 防御を上回って1以上のダメージが出た場合、その対象への有効攻撃参加者全員を攻撃成功とする。
      for (const attacker of [...new Map(hits.map(h => [h.attacker.playerId, h.attacker])).values()]) {
        attacker.stats.attacksHit++;
        awardPoints(room, attacker, SCORING.attackHit, '攻撃成功', scoreEvents);
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

  // 回復は攻撃後。使用者が生存している場合、自分または生存中の他プレイヤー1人を回復できる。
  // HP0になったプレイヤーは復活しない。2倍カード併用時は同じ対象を+4回復する。
  for (const a of actions.values()) {
    if (canceled.has(a.p.playerId) || a.normal !== 'heal' || !a.p.alive) continue;
    const target = healTargetIsValid(room, a.normalTargetId);
    if (!target) continue;
    const amount = doubled.has(a.p.playerId) ? 4 : 2;
    const before = target.hp;
    target.hp = clamp(target.hp + amount, 0, target.maxHp);
    const healed = target.hp - before;
    const targetText = target.playerId === a.p.playerId ? '' : `${target.color.label}を`;
    privateEvents.push({ to: a.p.playerId, type: 'notice', text: `${targetText}HPを${healed}回復しました。` });
    if (target.playerId !== a.p.playerId) {
      privateEvents.push({ to: target.playerId, type: 'notice', text: `HPを${healed}回復されました。` });
    }
  }

  // 偵察。特殊カードは『使用まで非公開』を優先し、通常カードだけを本人へ返す。ポイントと秘密目標も返さない。
  for (const a of actions.values()) {
    if (canceled.has(a.p.playerId) || a.normal !== 'scout') continue;
    const ids = [a.normalTargetId];
    if (doubled.has(a.p.playerId) && a.secondNormalTargetId && a.secondNormalTargetId !== a.normalTargetId) ids.push(a.secondNormalTargetId);
    let scoutedThisTurn = false;
    for (const tid of ids) {
      const target = getPlayer(room, tid);
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
  const seenAttempts = new Set();
  for (const a of actions.values()) {
    if (canceled.has(a.p.playerId) || a.normal !== 'accusation') continue;
    const tries = [{ targetId: a.normalTargetId, guess: a.accusationGuess }];
    if (doubled.has(a.p.playerId) && a.secondNormalTargetId && a.secondAccusationGuess) {
      tries.push({ targetId: a.secondNormalTargetId, guess: a.secondAccusationGuess });
    }
    for (const tr of tries) {
      const key = `${a.p.playerId}:${tr.targetId}:${tr.guess}`;
      if (seenAttempts.has(key)) continue;
      seenAttempts.add(key);
      const target = getPlayer(room, tr.targetId);
      if (!target || target.playerId === a.p.playerId) continue;
      accusationAttempts.push({ actor: a.p, target, guess: tr.guess, targetWasValid: !target.secretState.invalid });
      if (!effectiveAccusationTargets.has(a.p.playerId)) effectiveAccusationTargets.set(a.p.playerId, new Set());
      effectiveAccusationTargets.get(a.p.playerId).add(target.playerId);
    }
  }
  const successfulByTarget = new Map();
  for (const attempt of accusationAttempts) {
    const success = attempt.targetWasValid && attempt.target.objective?.key === attempt.guess;
    if (!success) {
      const penalty = awardPoints(room, attempt.actor, SCORING.accusationFailure, '告発失敗', scoreEvents);
      privateEvents.push({ to: attempt.actor.playerId, type: 'notice', text: `告発は失敗しました（${penalty}P）。` });
      continue;
    }
    awardPoints(room, attempt.actor, SCORING.accusationSuccess, '告発成功', scoreEvents);
    attempt.actor.stats.successfulAccusations++;
    if (!attempt.actor.stats.scoutedTargets.includes(attempt.target.playerId)) attempt.actor.stats.unscoutedAccusationSuccesses++;
    if (!successfulByTarget.has(attempt.target.playerId)) successfulByTarget.set(attempt.target.playerId, []);
    successfulByTarget.get(attempt.target.playerId).push(attempt.actor);
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

  for (const p of room.players) {
    if (p.forcedNormalType?.turn === room.turn) p.forcedNormalType = null;
  }

  // 公開契約の自動判定用。無効カードで消された攻撃や不正対象は含めず、
  // 実際に有効な攻撃として登録された対象だけをサーバー内部へ残す。
  room.lastEffectiveActions = {
    turn: room.turn,
    attacksByPlayer: Object.fromEntries([...effectiveAttackTargets.entries()].map(([playerId, ids]) => [playerId, [...ids]])),
    defensesByPlayer: Object.fromEntries([...effectiveDefenseTargets.entries()].map(([playerId, ids]) => [playerId, [...ids]])),
    accusationsByPlayer: Object.fromEntries([...effectiveAccusationTargets.entries()].map(([playerId, ids]) => [playerId, [...ids]]))
  };

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

module.exports = {
  randomId, randomToken, shuffle, emptyDraft, createPlayer, createRoom, getPlayer,
  startGame, validateDraft, resolveTurn, evaluateObjectives, awardTurnStartBonus, awardSurvivalBonus,
  buildRanking, currentPointsStanding, canPlaceWinnerBet, placeWinnerBet, settleWinnerBets, awardPoints, randomRoomCode,
  objectiveAchieved, ensureSecretObjectives,
  sanitizeDraft, draftForResolution, canTransferNormalCard
};
