'use strict';

const crypto = require('crypto');
const {
  MAX_PLAYERS, MAX_TURNS, COLORS, NORMAL_CARDS, SPECIAL_CARDS, OBJECTIVES,
  SECRET_REWARD, SCORING, STEAL_AMOUNTS, POINT_TRANSFER_TURNS, ROOM_CODE_LENGTH, ROOM_CODE_ALPHABET,
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
    damageTaken: 0,
    survivedTurns: 0,
    scoutedTargets: [],
    scoutCounts: {},
    attackTargets: [],
    attackedBy: [],
    defenseSuccessTurns: 0,
    consecutiveAttackTurns: 0,
    lastAttackTurn: null,
    pointTransfers: 0,
    cardTransfers: 0,
    specialsUsed: 0,
    normalPurchases: 0,
    specialPurchases: 0,
    lastNormalPurchaseType: null,
    lastNormalPurchaseTurn: null,
    lastSpecialPurchaseTurn: null,
    lastNormalUsed: null,
    lastSpecialUsed: null
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
    isCpu: false,
    cpuBrain: null,
    autoReadySeq: null,
    autoLockSeq: null,
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
      awardedPoints: 0,
      infoByTurn: {},
      pendingInfoByTurn: {}
    },
    draft: emptyDraft(),
    ready: false,
    actionLocked: false,
    forcedNormalType: null,
    scoutReports: [],
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
    ownerPlayerId: null,
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
    survivalBonusAwarded: false
  };
}

function getPlayer(room, playerId) {
  return room.players.find(p => p.playerId === playerId) || null;
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
  room.survivalBonusAwarded = false;

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
    p.secretState = { achieved: false, invalid: false, achievedTurn: null, awardedPoints: 0, infoByTurn: {}, pendingInfoByTurn: {} };
    p.draft = emptyDraft();
    p.ready = false;
    p.actionLocked = false;
    p.autoReadySeq = null;
    p.autoLockSeq = null;
    p.afkStreak = 0;
    p.turnHadManualInput = false;
    p.cpuBrain = p.isCpu ? null : p.cpuBrain;
    p.forcedNormalType = null;
    p.scoutReports = [];
    p.stats = freshStats();
  });
  return room;
}

function scoreMultiplier(room) { return room.turn === MAX_TURNS ? 2 : 1; }
function awardPoints(room, player, base, reason, scoreEvents) {
  const actual = base * scoreMultiplier(room);
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
  if (!['attack', 'scout', 'accusation'].includes(d.normal)) d.normalTargetId = null;
  if (d.normal !== 'accusation') {
    d.accusationGuess = null;
    d.secondAccusationGuess = null;
  }
  if (!(d.special === 'double' && ['scout', 'accusation'].includes(d.normal))) {
    d.secondNormalTargetId = null;
    d.secondAccusationGuess = null;
  }
  if (!['cancel', 'specify', 'steal'].includes(d.special)) d.specialTargetId = null;
  if (d.special !== 'specify') d.specifiedType = null;

  if (!strict) return { ok: true, draft: d };

  if (d.special === 'double' && !d.normal) return { ok: false, message: '2倍カードには通常カードが必要です。' };

  const normalNeedsTarget = ['attack', 'scout', 'accusation'].includes(d.normal);
  if (normalNeedsTarget && !targetIsValid(room, p, d.normalTargetId)) {
    return { ok: false, message: '通常カードの対象を選択してください。' };
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

  if (d.special === 'double' && d.normal === 'scout' && d.secondNormalTargetId) {
    const second = targetIsValid(room, p, d.secondNormalTargetId);
    if (!second || d.secondNormalTargetId === d.normalTargetId) return { ok: false, message: '2人目の偵察対象が不正です。' };
  }
  if (d.special === 'double' && d.normal === 'accusation' && d.secondNormalTargetId) {
    const second = targetIsValid(room, p, d.secondNormalTargetId);
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

  const needsTarget = ['attack', 'scout', 'accusation'].includes(forced);
  const validOthers = room.players.filter(x => x.alive && x.playerId !== p.playerId);
  if (needsTarget && validOthers.length === 0) return emptyDraft();

  // カード指定は「そのカードを使う」強制なので、放置や対象未選択で効果まで回避できない。
  // 手動選択が有効なら尊重し、未選択/不正なら有効な相手から暗号学的乱数で1人を自動選択する。
  if (needsTarget && !targetIsValid(room, p, action.normalTargetId)) {
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
  if (action.normal) p.hand[action.normal]--;
  if (action.special) {
    p.specials[action.special]--;
    p.stats.specialsUsed++;
  }
  p.stats.lastNormalUsed = action.normal || null;
  p.stats.lastSpecialUsed = action.special || null;
}

function finalizePendingStructuredStatements(room, actions) {
  for (const speaker of room.players) {
    const pending = speaker.secretState.pendingInfoByTurn?.[room.turn] || [];
    if (!pending.length) continue;
    speaker.secretState.infoByTurn[room.turn] = speaker.secretState.infoByTurn[room.turn] || [];
    for (const claim of pending) {
      if (claim.kind === 'nextAction') {
        const action = actions.get(claim.subjectId);
        const actual = action?.normal || 'none';
        speaker.secretState.infoByTurn[room.turn].push(actual === claim.normalType);
      }
    }
    delete speaker.secretState.pendingInfoByTurn[room.turn];
  }
}

// ターン解決自体がシステムエラーで無効になった場合、「次の行動」の真偽は
// 正しく確定できない。保留を残してメモリに滞留させず、そのターンを
// 正直者/詐欺師どちらの連続条件にも使えない中立値(null)として記録する。
function invalidatePendingStructuredStatements(room) {
  for (const speaker of room.players) {
    const pending = speaker.secretState.pendingInfoByTurn?.[room.turn] || [];
    if (!pending.length) continue;
    speaker.secretState.infoByTurn[room.turn] = speaker.secretState.infoByTurn[room.turn] || [];
    for (const claim of pending) {
      if (claim.kind === 'nextAction') speaker.secretState.infoByTurn[room.turn].push(null);
    }
    delete speaker.secretState.pendingInfoByTurn[room.turn];
  }
}

function evaluateStructuredStreak(p, truthWanted) {
  const turns = Object.keys(p.secretState.infoByTurn).map(Number).sort((a, b) => a - b);
  if (turns.length < 5) return false;
  for (let endIndex = 4; endIndex < turns.length; endIndex++) {
    const end = turns[endIndex];
    const start = end - 4;
    let ok = true;
    for (let t = start; t <= end; t++) {
      const arr = p.secretState.infoByTurn[t];
      if (!arr || arr.length === 0 || arr.some(v => v !== truthWanted)) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

function objectiveAchieved(room, p) {
  if (!p.objective) return false;
  switch (p.objective.key) {
    case 'observer': return new Set(p.stats.scoutedTargets).size >= 4;
    case 'tracker': return Object.values(p.stats.scoutCounts).some(n => n >= 2);
    case 'gambler': return p.stats.successfulAccusations >= 1 && p.stats.scoutedTargets.length === 0;
    case 'giver': return p.stats.pointTransfers >= 1;
    case 'killer': return p.stats.consecutiveAttackTurns >= 3;
    case 'reaper': return room.turn === MAX_TURNS && p.stats.attackTargets.length >= 2 && new Set(p.stats.attackTargets).size === 1;
    case 'executioner': return p.stats.soloKills >= 1;
    case 'accomplice': return p.stats.jointKills >= 2;
    case 'avenger': return p.stats.killTargets.some(id => p.stats.attackedBy.includes(id));
    case 'ironWall': return p.stats.defenseSuccessTurns >= 3;
    case 'nearDeath': return room.turn === MAX_TURNS && p.alive && p.hp === 1;
    case 'endurer': return p.stats.damageTaken >= 4;
    case 'hermit': return room.turn === MAX_TURNS && p.alive && p.stats.specialsUsed === 0;
    case 'liar': return evaluateStructuredStreak(p, false);
    case 'honest': return evaluateStructuredStreak(p, true);
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
    p.secretState.awardedPoints = awardPoints(room, p, SECRET_REWARD, '秘密目標達成', scoreEvents);
    achieved.push(p.playerId);
  }
  return achieved;
}

function resolveTurn(room) {
  if (room.status !== 'playing' || room.phase !== 'action') throw new Error('行動フェーズではありません。');
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
    p.actionLocked = false;
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
  const defensePower = new Map();
  for (const a of actions.values()) {
    if (canceled.has(a.p.playerId)) continue;
    if (a.special === 'double' && a.normal) doubled.add(a.p.playerId);
    if (a.special === 'fullDefense') fullDefense.add(a.p.playerId);
    if (a.normal === 'defense') defensePower.set(a.p.playerId, doubled.has(a.p.playerId) ? 2 : 1);
  }

  // 攻撃を対象ごとに同時集計。2倍攻撃は攻撃力2だが「攻撃成功」の得点は1回分。
  const incoming = new Map();
  for (const a of actions.values()) {
    if (canceled.has(a.p.playerId) || a.normal !== 'attack') continue;
    const target = getPlayer(room, a.normalTargetId);
    if (!target || !target.alive || target.playerId === a.p.playerId) continue;
    const power = doubled.has(a.p.playerId) ? 2 : 1;
    if (!incoming.has(target.playerId)) incoming.set(target.playerId, []);
    incoming.get(target.playerId).push({ attacker: a.p, power });

    a.p.stats.attacksUsed++;
    a.p.stats.attackTargets.push(target.playerId);
    if (a.p.stats.lastAttackTurn === room.turn - 1) a.p.stats.consecutiveAttackTurns++;
    else a.p.stats.consecutiveAttackTurns = 1;
    a.p.stats.lastAttackTurn = room.turn;
    addUnique(target.stats.attackedBy, a.p.playerId);
  }

  for (const [targetId, hits] of incoming.entries()) {
    const target = getPlayer(room, targetId);
    const totalPower = hits.reduce((sum, hit) => sum + hit.power, 0);
    const blockedPower = fullDefense.has(targetId)
      ? totalPower
      : Math.min(totalPower, defensePower.get(targetId) || 0);
    const damage = Math.max(0, totalPower - blockedPower);

    if (blockedPower > 0) target.stats.defenseSuccessTurns++;
    if (fullDefense.has(targetId)) {
      awardPoints(room, target, hits.length * SCORING.fullDefensePerAttacker, '完全防御', scoreEvents);
    }

    if (damage > 0) {
      const actualDamage = Math.min(damage, target.hp);
      target.hp -= actualDamage;
      target.stats.damageTaken += actualDamage;
      // 防御を上回って1以上のダメージが出た場合、その対象への有効攻撃参加者全員を攻撃成功とする。
      for (const h of hits) {
        h.attacker.stats.attacksHit++;
        awardPoints(room, h.attacker, SCORING.attackHit, '攻撃成功', scoreEvents);
      }
      publicEvents.push({ type: 'attack', text: `${hits.map(h => h.attacker.color.label).join('・')}の攻撃が${target.color.label}に${actualDamage}ダメージ` });
    } else {
      publicEvents.push({ type: 'defense', text: `${target.color.label}が攻撃を防いだ` });
    }

    if (target.hp <= 0) {
      target.hp = 0;
      target.alive = false;
      const contributors = [...new Map(hits.map(h => [h.attacker.playerId, h.attacker])).values()];
      if (contributors.length === 1) {
        const killer = contributors[0];
        awardPoints(room, killer, SCORING.soloKill, '単独キル', scoreEvents);
        killer.stats.soloKills++;
        addUnique(killer.stats.killTargets, target.playerId);
      } else {
        for (const killer of contributors) {
          awardPoints(room, killer, SCORING.jointKill, '共同キル', scoreEvents);
          killer.stats.jointKills++;
          addUnique(killer.stats.killTargets, target.playerId);
        }
      }
      publicEvents.push({ type: 'death', text: `${target.color.label}が脱落した` });
    }
  }

  // 回復は攻撃後。HP0になったプレイヤーは復活しない。
  for (const a of actions.values()) {
    if (canceled.has(a.p.playerId) || a.normal !== 'heal' || !a.p.alive) continue;
    const amount = doubled.has(a.p.playerId) ? 4 : 2;
    const before = a.p.hp;
    a.p.hp = clamp(a.p.hp + amount, 0, a.p.maxHp);
    privateEvents.push({ to: a.p.playerId, type: 'notice', text: `HPを${a.p.hp - before}回復しました。` });
  }

  // 偵察。特殊カードは『使用まで非公開』を優先し、通常カードだけを本人へ返す。ポイントと秘密目標も返さない。
  for (const a of actions.values()) {
    if (canceled.has(a.p.playerId) || a.normal !== 'scout') continue;
    const ids = [a.normalTargetId];
    if (doubled.has(a.p.playerId) && a.secondNormalTargetId && a.secondNormalTargetId !== a.normalTargetId) ids.push(a.secondNormalTargetId);
    for (const tid of ids) {
      const target = getPlayer(room, tid);
      if (!target || target.playerId === a.p.playerId) continue;
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
  }

  // 告発も同時判定。同じ対象を複数人が同時に正解した場合、全員が成功する。
  const accusationAttempts = [];
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
    }
  }
  const successfulByTarget = new Map();
  for (const attempt of accusationAttempts) {
    const success = attempt.targetWasValid && attempt.target.objective?.key === attempt.guess;
    if (!success) {
      privateEvents.push({ to: attempt.actor.playerId, type: 'notice', text: '告発は失敗しました。' });
      continue;
    }
    awardPoints(room, attempt.actor, SCORING.accusationSuccess, '告発成功', scoreEvents);
    attempt.actor.stats.successfulAccusations++;
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

  // 「次の行動」情報発言は、実際に確定した通常カードを基準にここで真偽確定する。
  finalizePendingStructuredStatements(room, actions);

  for (const p of startedAlive) if (p.alive) p.stats.survivedTurns++;

  const newlyAchieved = evaluateObjectives(room, scoreEvents);
  for (const pid of newlyAchieved) {
    const p = getPlayer(room, pid);
    privateEvents.push({ to: pid, type: 'notice', text: `秘密目標「${p.objective.label}」を達成しました。` });
  }

  for (const p of room.players) {
    if (p.forcedNormalType?.turn === room.turn) p.forcedNormalType = null;
  }

  return { privateEvents, publicEvents, scoreEvents };
}

function awardSurvivalBonus(room) {
  // 15ターン完走時だけ付与。早期終了経路から誤って呼ばれても+50Pを発生させない。
  if (room.turn < MAX_TURNS || room.survivalBonusAwarded) return [];
  room.survivalBonusAwarded = true;
  const events = [];
  for (const p of room.players) {
    if (!p.alive) continue;
    p.points += SCORING.survival;
    events.push({ playerId: p.playerId, actual: SCORING.survival, reason: '15ターン生存' });
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
      isCpu: !!p.isCpu,
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

function recordStructuredStatement(room, p, payload) {
  const subject = getPlayer(room, payload.subjectId || p.playerId);
  if (!subject) return { ok: false, message: '対象が不正です。' };
  const kind = String(payload.kind || '');
  let truth = false;
  let deferred = false;
  let text = '';

  if (kind === 'hp') {
    const value = Number(payload.value);
    if (!Number.isInteger(value) || value < 0 || value > 5) return { ok: false, message: 'HPの値が不正です。' };
    truth = subject.hp === value;
    text = `${subject.color.label}のHPは${value}だ`;
  } else if (kind === 'points') {
    const value = Number(payload.value);
    if (!Number.isInteger(value) || value < -99999 || value > 99999) return { ok: false, message: 'ポイントの値が不正です。' };
    truth = subject.points === value;
    text = `${subject.color.label}のポイントは${value}Pだ`;
  } else if (kind === 'kills') {
    const value = Number(payload.value);
    if (!Number.isInteger(value) || value < 0 || value > 99) return { ok: false, message: 'キル数が不正です。' };
    truth = subject.stats.soloKills + subject.stats.jointKills === value;
    text = `${subject.color.label}のキル数は${value}だ`;
  } else if (kind === 'cardCount') {
    const cardType = String(payload.cardType || '');
    const value = Number(payload.value);
    if (!hasOwn(NORMAL_CARDS, cardType) || !Number.isInteger(value) || value < 0 || value > 99) return { ok: false, message: 'カード情報が不正です。' };
    truth = (subject.hand[cardType] || 0) === value;
    text = `${subject.color.label}は${NORMAL_CARDS[cardType].label}を${value}枚持っている`;
  } else if (kind === 'hasSpecial') {
    const specialType = String(payload.specialType || '');
    const value = payload.value === true || payload.value === 'true';
    if (!hasOwn(SPECIAL_CARDS, specialType)) return { ok: false, message: '特殊カード情報が不正です。' };
    truth = ((subject.specials[specialType] || 0) > 0) === value;
    text = `${subject.color.label}は${SPECIAL_CARDS[specialType].label}を${value ? '持っている' : '持っていない'}`;
  } else if (kind === 'objective') {
    const objectiveKey = String(payload.objectiveKey || '');
    const obj = OBJECTIVES.find(x => x.key === objectiveKey);
    if (!obj) return { ok: false, message: '秘密目標が不正です。' };
    truth = subject.objective?.key === objectiveKey;
    text = `${subject.color.label}の秘密目標は「${obj.label}」だ`;
  } else if (kind === 'lastAction') {
    if (room.turn <= 1) return { ok: false, message: '第1ターンには前ターンの行動がありません。' };
    const normalType = String(payload.normalType || 'none');
    if (normalType !== 'none' && !hasOwn(NORMAL_CARDS, normalType)) return { ok: false, message: '行動情報が不正です。' };
    truth = (subject.stats.lastNormalUsed || 'none') === normalType;
    text = `${subject.color.label}が前ターン使った通常カードは${normalType === 'none' ? 'なし' : NORMAL_CARDS[normalType].label}だ`;
  } else if (kind === 'nextAction') {
    if (!subject.alive) return { ok: false, message: '脱落済みプレイヤーの次の行動は宣言できません。' };
    const normalType = String(payload.normalType || 'none');
    if (normalType !== 'none' && !hasOwn(NORMAL_CARDS, normalType)) return { ok: false, message: '行動情報が不正です。' };
    deferred = true;
    p.secretState.pendingInfoByTurn[room.turn] = p.secretState.pendingInfoByTurn[room.turn] || [];
    p.secretState.pendingInfoByTurn[room.turn].push({ kind: 'nextAction', subjectId: subject.playerId, normalType });
    text = `${subject.color.label}は次に${normalType === 'none' ? '通常カードを使わない' : NORMAL_CARDS[normalType].label + 'を使う'}`;
  } else if (kind === 'normalPurchase') {
    const normalType = String(payload.normalType || 'none');
    if (normalType !== 'none' && !hasOwn(NORMAL_CARDS, normalType)) return { ok: false, message: '購入情報が不正です。' };
    if (normalType === 'none') {
      truth = subject.normalPurchasedTurn !== room.turn;
      text = `${subject.color.label}はこのターン通常カードを購入していない`;
    } else {
      truth = subject.stats.lastNormalPurchaseTurn === room.turn && subject.stats.lastNormalPurchaseType === normalType;
      text = `${subject.color.label}はこのターン${NORMAL_CARDS[normalType].label}を購入した`;
    }
  } else if (kind === 'specialPurchase') {
    const value = payload.value === true || payload.value === 'true';
    truth = subject.specialPurchased === value;
    text = `${subject.color.label}はこの試合で特殊カードを${value ? '購入済みだ' : '購入していない'}`;
  } else {
    return { ok: false, message: '情報発言の種類が不正です。' };
  }

  if (!deferred) {
    p.secretState.infoByTurn[room.turn] = p.secretState.infoByTurn[room.turn] || [];
    p.secretState.infoByTurn[room.turn].push(truth);
  }
  return { ok: true, truth: deferred ? null : truth, deferred, text };
}

function canTransferPoints(room) {
  return POINT_TRANSFER_TURNS.includes(room.turn) && room.phase === 'chat';
}

module.exports = {
  randomId, randomToken, shuffle, emptyDraft, createPlayer, createRoom, getPlayer,
  startGame, validateDraft, resolveTurn, evaluateObjectives, awardSurvivalBonus,
  buildRanking, currentPointsStanding, recordStructuredStatement, canTransferPoints, awardPoints, randomRoomCode,
  objectiveAchieved, evaluateStructuredStreak, finalizePendingStructuredStatements, invalidatePendingStructuredStatements,
  sanitizeDraft, draftForResolution, canTransferNormalCard
};
