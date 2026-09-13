'use strict';

const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const {
  MAX_PLAYERS, MAX_TURNS, CHAT_SECONDS, RESULT_SECONDS,
  RECONNECT_GRACE_SECONDS, LOBBY_RECONNECT_GRACE_SECONDS, FINISHED_ROOM_TTL_MS, ROOM_CODE_LENGTH, ROOM_CODE_ALPHABET,
  NORMAL_CARDS, SPECIAL_CARDS, OBJECTIVES,
  SCORING, STEAL_AMOUNTS, SECRET_REWARD, SPECIAL_PURCHASE_PRICE, TURN_START_BONUSES, WINNER_BET, GOGI_CHIPS
} = require('./src/rules');
const {
  createRoom, createPlayer, getPlayer, startGame, validateDraft, resolveTurn,
  awardTurnStartBonus, awardSurvivalBonus, buildRanking, currentPointsStanding, canPlaceWinnerBet, placeWinnerBet, settleWinnerBets, settleChipWager, evaluateObjectives,
  ensureSecretObjectives, randomId, randomRoomCode, canTransferNormalCard
} = require('./src/engine');
const { validContractStake, contractRewardPerPlayer, contractSettlement } = require('./src/contracts');

const app = express();
const server = http.createServer(app);
const BUILD_ID = '20260913-cp-strategist-max';

function envInt(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    console.warn(`${name}=${JSON.stringify(raw)} は不正なため ${fallback} を使用します。`);
    return fallback;
  }
  return n;
}
function normalizeOrigin(value) {
  try { return new URL(String(value).trim()).origin; } catch { return null; }
}

const PORT = envInt('PORT', 3000, { min: 1, max: 65535 });
const MAX_ACTIVE_ROOMS = envInt('MAX_ACTIVE_ROOMS', 300, { min: 10, max: 5000 });
const MAX_STORED_ROOMS = envInt('MAX_STORED_ROOMS', Math.max(MAX_ACTIVE_ROOMS + 50, MAX_ACTIVE_ROOMS * 2), { min: MAX_ACTIVE_ROOMS, max: 10000 });
const MAX_SOCKET_CONNECTIONS = envInt('MAX_SOCKET_CONNECTIONS', 2000, { min: 25, max: 50000 });
const CHAT_HISTORY_LIMIT = 160;
const LOG_HISTORY_LIMIT = 80;
const RECENT_MUTATION_LIMIT = 64;
const ALLOWED_ORIGINS = new Set(String(process.env.ALLOWED_ORIGINS || '').split(',').map(normalizeOrigin).filter(Boolean));
const REQUIRE_ALLOWED_ORIGINS = process.env.NODE_ENV === 'production' && process.env.REQUIRE_ALLOWED_ORIGINS !== 'false';
if (REQUIRE_ALLOWED_ORIGINS && ALLOWED_ORIGINS.size === 0) {
  throw new Error('本番環境では ALLOWED_ORIGINS を設定してください。例: https://example.com');
}

function requestOriginAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  if (ALLOWED_ORIGINS.size > 0) return ALLOWED_ORIGINS.has(normalized);
  try {
    const originUrl = new URL(normalized);
    return originUrl.host === req.headers.host;
  } catch {
    return false;
  }
}

let activeSocketConnections = 0;
const io = new Server(server, {
  maxHttpBufferSize: 20_000,
  pingInterval: 25_000,
  pingTimeout: 20_000,
  perMessageDeflate: false,
  allowRequest: (req, cb) => cb(null, activeSocketConnections < MAX_SOCKET_CONNECTIONS && requestOriginAllowed(req))
});

const rooms = new Map();
const sessionIndex = new Map(); // token -> { roomId, playerId }

app.disable('x-powered-by');
app.use(express.json({ limit: '4kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Gogi-Build', BUILD_ID);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  next();
});
app.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// カード画像はURLにASSET_REVを付けるため長期キャッシュしても更新時に安全に切り替わる。
// 1試合目の待機中に先読みし、以後のカード表示・偵察表示で再転送を避ける。
app.use('/cards', express.static(path.join(__dirname, 'public', 'cards'), {
  maxAge: '365d', immutable: true, etag: true, index: false,
  setHeaders: res => res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
}));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: true, index: false, setHeaders: res => { res.setHeader('Cache-Control', 'no-store, max-age=0'); res.setHeader('Pragma', 'no-cache'); } }));
const EXPOSE_HEALTH_DETAILS = process.env.NODE_ENV !== 'production' || process.env.EXPOSE_HEALTH_DETAILS === 'true';
app.get('/health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!EXPOSE_HEALTH_DETAILS) return res.json({ ok: true });
  const activeRooms = [...rooms.values()].filter(r => r.status !== 'finished').length;
  res.json({ ok: true, game: '五疑戦', build: BUILD_ID, activeRooms, storedRooms: rooms.size, sockets: activeSocketConnections, uptime: Math.floor(process.uptime()) });
});

app.get('/api/lobby/:code', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  const code = String(req.params.code || '').trim().toUpperCase();
  const codeRegex = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);
  if (!codeRegex.test(code)) return res.status(400).json({ ok:false });
  const room = [...rooms.values()].find(r => r.code === code);
  if (!room) return res.status(404).json({ ok:false });
  return res.json({ ok:true, roomId:room.id, code:room.code, isPublic:!!room.isPublic, status:room.status, count:room.players.length, chipStake:Number(room.chipStake || 0), build:BUILD_ID });
});

app.post('/api/leave-lobby', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (!requestOriginAllowed(req)) return res.status(403).json({ ok:false });

  const token = cleanText(req.body?.sessionToken, 128);
  const requestBrowserId = normalizeBrowserId(req.body?.browserId);
  const requestClientInstanceId = normalizeClientInstanceId(req.body?.clientInstanceId);
  const requestPageInstanceId = normalizePageInstanceId(req.body?.pageInstanceId);

  // 第一候補はsessionToken。クライアント側でtoken保存が既に消えていた場合に備え、
  // 同一browserId + clientInstanceId + pageInstanceIdでも「現在の待機室」だけを特定できるようにする。
  let room = null;
  let p = null;
  if (token) {
    const ref = sessionIndex.get(token);
    room = ref && rooms.get(ref.roomId);
    p = room && getPlayer(room, ref.playerId);
    if (!p || p.sessionToken !== token) { room = null; p = null; }
  }
  if (!p && requestBrowserId && requestClientInstanceId && requestPageInstanceId) {
    for (const candidateRoom of rooms.values()) {
      if (candidateRoom.status !== 'lobby') continue;
      const candidate = candidateRoom.players.find(player =>
        player.browserId === requestBrowserId
        && player.clientInstanceId === requestClientInstanceId
        && player.pageInstanceId === requestPageInstanceId
      );
      if (candidate) { room = candidateRoom; p = candidate; break; }
    }
  }
  // pageInstanceIdはリロードごとに変わる。同じタブの古い待機記録だけが残った場合も、
  // browserId + clientInstanceIdが一致するロビー参加者なら明示退出として掃除できるようにする。
  if (!p && requestBrowserId && requestClientInstanceId) {
    for (const candidateRoom of rooms.values()) {
      if (candidateRoom.status !== 'lobby') continue;
      const candidate = candidateRoom.players.find(player =>
        player.browserId === requestBrowserId
        && player.clientInstanceId === requestClientInstanceId
      );
      if (candidate) { room = candidateRoom; p = candidate; break; }
    }
  }

  // 明示的な待機退出では、同じブラウザに残った古いロビー記録も全て掃除する。
  // sessionStorage由来のclientInstanceIdは再読込・別タブで変わり得るため、
  // browserIdが一致する「待機中」だけを対象にする。対戦中は絶対に削除しない。
  if (requestBrowserId) {
    const removed = removeLobbyPlayersForBrowser(requestBrowserId);
    if (removed > 0) return res.json({ ok:true, removed });
  }

  // 二重送信(Socket ACK + HTTP)は正常系。先に片方が退出済みなら成功として扱う。
  if (!room || !p) return res.json({ ok:true, alreadyLeft:true });
  if (room.status !== 'lobby') return res.status(409).json({ ok:false, message:'待機室ではありません。' });

  if (p.socketId) {
    const liveSocket = io.sockets.sockets.get(p.socketId);
    if (liveSocket) {
      liveSocket.leave(room.id);
      if (liveSocket.data.roomId === room.id && liveSocket.data.playerId === p.playerId) {
        liveSocket.data.roomId = null;
        liveSocket.data.playerId = null;
      }
    }
  }
  removePlayerRecord(room, p.playerId);
  if (room.players.length === 0) deleteRoom(room); else emitState(room);
  return res.json({ ok:true });
});

function safeCb(cb, payload) { if (typeof cb === 'function') cb(payload); }
function now() { return Date.now(); }
function cleanText(value, max = 300) {
  const clean = String(value ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    // 双方向制御・不可視の方向指定/空白偽装を除去。絵文字のZWJ(U+200D)は保持する。
    .replace(/[\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g, '')
    // UIは1行入力なので、改行/タブを悪用した巨大な空白メッセージを作れないよう正規化する。
    .replace(/[\t\r\n]+/g, ' ')
    .trim();
  // UTF-16の途中で絵文字/サロゲートペアを切断しない。
  return Array.from(clean).slice(0, max).join('');
}
function objectPayload(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function log(room, text, targets = null) {
  // 対戦ログはサーバー内部の監査・デバッグ用だけに保持する。
  // 公開結果を廃止した現在、クライアントへ配信すると非表示UI経由でも
  // 攻撃・特殊・告発・交換内容などを通信解析で取得できてしまうため送信しない。
  const entry = { id: randomId('log'), turn: room.turn, text: cleanText(text, 500), at: now(), targets };
  room.logs.push(entry);
  if (room.logs.length > LOG_HISTORY_LIMIT) room.logs.shift();
  return entry;
}
function visibleChat(room, playerId) {
  return room.chat.filter(m => !m.toId || m.fromId === playerId || m.toId === playerId).slice(-CHAT_HISTORY_LIMIT);
}
function clearRoomTimer(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}
function getAlive(room) { return room.players.filter(p => p.alive); }
function allAliveReady(room) {
  const alive = getAlive(room);
  return alive.length > 0 && alive.every(p => p.ready);
}
function resultVoters(room) {
  // 結果の『次へ』は接続中プレイヤー全員で判定する。
  return room.players.filter(p => p.connected);
}
function allResultReady(room) {
  const voters = resultVoters(room);
  return voters.length === 0 || voters.every(p => p.resultReady);
}


// 確認テスト版専用CP。外部AI/APIは使わず、サーバー内で「状況判断→目的達成→勝率最大化」を行う。
// 重要: 対戦相手の秘密目標・ポイント・未偵察の手札を直接読んで答えを知る“透視”はしない。
// CPが戦略判断に使うのは、自分の状態、自分の秘密目標、自分の偵察結果、公開契約、公開済みの生死/告発済み情報、
// および自分自身の前ターン結果だけ。完全ランダムではなく、複数ターン先の秘密目標進行・生存・得点効率を評価する。
function isTestCpu(p) { return p?.isCpu === true; }
function cpuRandom(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return items[crypto.randomInt(items.length)];
}
function cpuJitter(scale = 1) { return (crypto.randomInt(2001) - 1000) / 1000 * scale; }
function cpuAliveTargets(room, p) { return room.players.filter(x => x.alive && x.playerId !== p.playerId); }
function cpuAnyTargets(room, p) { return room.players.filter(x => x.playerId !== p.playerId); }
function cpuUnresolvedAccusationTargets(room, p) { return cpuAnyTargets(room, p).filter(x => !x.secretState?.invalid); }
function cpuEmptyDraft() {
  return { normal:null, special:null, normalTargetId:null, secondNormalTargetId:null, specialTargetId:null, accusationGuess:null, secondAccusationGuess:null, stealAmount:5, specifiedType:null, specifiedTargetId:null };
}
function cpuBrain(p) {
  if (!p.cpuBrain || typeof p.cpuBrain !== 'object') {
    p.cpuBrain = {
      lastLearnedTurn: 0,
      lastPlan: null,
      failedObjectiveGuesses: {},
      attackResults: {},
      defenseSuccesses: 0,
      profile: {
        aggression: 0.9 + crypto.randomInt(31) / 100,
        caution: 0.9 + crypto.randomInt(31) / 100,
        information: 0.9 + crypto.randomInt(31) / 100,
        deception: 0.9 + crypto.randomInt(31) / 100
      }
    };
  }
  return p.cpuBrain;
}
function cpuReportsFor(p, targetId) {
  return (p.scoutReports || []).filter(r => r.targetId === targetId).sort((a,b) => Number(a.turn||0) - Number(b.turn||0));
}
function cpuLatestScout(p, targetId) {
  const reports = cpuReportsFor(p, targetId);
  return reports.length ? reports[reports.length - 1] : null;
}
function cpuHandSpendEvidence(p, targetId) {
  const reports = cpuReportsFor(p, targetId);
  const initial = Object.fromEntries(Object.entries(NORMAL_CARDS).map(([key, def]) => [key, Number(def.initial || 0)]));
  const minSeen = { ...initial };
  for (const report of reports) {
    for (const key of Object.keys(NORMAL_CARDS)) minSeen[key] = Math.min(minSeen[key], Number(report.hand?.[key] ?? initial[key]));
  }
  return Object.fromEntries(Object.keys(NORMAL_CARDS).map(key => [key, Math.max(0, initial[key] - minSeen[key])]));
}
function cpuLearnFromLastTurn(room) {
  const r = room.lastResult;
  if (!r || !Number.isInteger(r.turn)) return;
  for (const p of room.players) {
    if (!isTestCpu(p)) continue;
    const brain = cpuBrain(p);
    if (brain.lastLearnedTurn >= r.turn) continue;
    brain.lastLearnedTurn = r.turn;
    const plan = brain.lastPlan && brain.lastPlan.turn === r.turn ? brain.lastPlan : null;
    const own = r.playerResults?.[p.playerId]?.items || [];
    if (plan?.normal === 'attack' && plan.normalTargetId) {
      const success = own.some(x => String(x).startsWith('攻撃成功'));
      const failure = own.some(x => String(x).startsWith('攻撃失敗'));
      if (!brain.attackResults[plan.normalTargetId]) brain.attackResults[plan.normalTargetId] = { success:0, fail:0 };
      if (success) brain.attackResults[plan.normalTargetId].success++;
      if (failure) brain.attackResults[plan.normalTargetId].fail++;
    }
    if (plan?.normal === 'defense' && own.some(x => String(x).startsWith('防御成功'))) brain.defenseSuccesses++;
    if (plan?.normal === 'accusation' && plan.normalTargetId && !plan.secondNormalTargetId) {
      const failed = own.some(x => String(x).startsWith('告発失敗'));
      if (failed && plan.accusationGuess) {
        if (!brain.failedObjectiveGuesses[plan.normalTargetId]) brain.failedObjectiveGuesses[plan.normalTargetId] = [];
        if (!brain.failedObjectiveGuesses[plan.normalTargetId].includes(plan.accusationGuess)) brain.failedObjectiveGuesses[plan.normalTargetId].push(plan.accusationGuess);
      }
    }
  }
}
function cpuObjectiveInference(room, p, target) {
  const scores = Object.fromEntries(OBJECTIVES.map(o => [o.key, 1]));
  const spent = cpuHandSpendEvidence(p, target.playerId);
  const latest = cpuLatestScout(p, target.playerId);
  const reports = cpuReportsFor(p, target.playerId);
  const failed = new Set(cpuBrain(p).failedObjectiveGuesses[target.playerId] || []);
  for (const key of failed) scores[key] = 0.01;

  if (spent.scout >= 2) scores.observer += 2.4;
  if (spent.scout >= 3) scores.observer += 4.0;
  if (spent.scout >= 4) scores.tracker += 4.0;
  if (spent.scout >= 5) scores.tracker += 6.0;
  if (spent.attack >= 2) scores.killer += 2.4;
  if (spent.attack >= 3) scores.killer += 4.2;
  if (spent.attack >= 4) scores.reaper += 4.0;
  if (spent.attack >= 5) scores.reaper += 6.0;
  if (spent.accusation >= 1) scores.gambler += 2.8;
  if (spent.accusation >= 2) scores.gambler += 1.8;
  if (spent.defense >= 2) scores.ironWall += 2.2;
  if (spent.defense >= 3) scores.ironWall += 4.8;

  // 未使用系は「遅いターンでも初期枚数が残っている」ことを偵察できた時だけ強く推定する。
  if (latest && room.turn >= 8) {
    if (Number(latest.hand?.heal ?? -1) >= Number(NORMAL_CARDS.heal.initial || 0)) scores.endurer += 2.4 + (room.turn - 8) * 0.35;
    if (Number(latest.hand?.defense ?? -1) >= Number(NORMAL_CARDS.defense.initial || 0)) scores.unguarded += 2.4 + (room.turn - 8) * 0.35;
  }
  if (latest && Number(latest.hp) <= 2 && room.turn >= 5) scores.nearDeath += 2.4;
  if (latest && Number(latest.hp) === 1) scores.nearDeath += 1.5;
  // 隠者は特殊カードが偵察で見えないため、直接証拠を捏造せず事前確率のまま扱う。

  // 連続偵察の差分は「その期間に確実に減ったカード」の追加証拠として使う。
  if (reports.length >= 2) {
    const recent = reports.slice(-2);
    const dt = Math.max(1, Number(recent[1].turn||0) - Number(recent[0].turn||0));
    const scoutDrop = Number(recent[0].hand?.scout||0) - Number(recent[1].hand?.scout||0);
    const attackDrop = Number(recent[0].hand?.attack||0) - Number(recent[1].hand?.attack||0);
    const defenseDrop = Number(recent[0].hand?.defense||0) - Number(recent[1].hand?.defense||0);
    if (dt <= 2 && scoutDrop > 0) scores.observer += 1.8;
    if (dt <= 2 && attackDrop > 0) scores.killer += 1.8;
    if (dt <= 2 && defenseDrop > 0) scores.ironWall += 1.2;
  }

  const entries = OBJECTIVES.map(o => ({ key:o.key, score:Math.max(0.001, scores[o.key] || 0.001) })).sort((a,b) => b.score - a.score);
  const total = entries.reduce((s,x) => s + x.score, 0) || 1;
  const ranked = entries.map(x => ({ ...x, probability:x.score / total }));
  const top = ranked[0] || { key:null, probability:0, score:0 };
  const second = ranked[1] || { key:null, probability:0, score:0 };
  const margin = Math.max(0, top.score - second.score);
  const confidence = Math.max(0.05, Math.min(0.94, top.probability + margin / 22));
  return {
    guess: top.key || cpuRandom(OBJECTIVES)?.key || null,
    confidence,
    secondGuess: second.key || null,
    secondConfidence: second.probability,
    scores: ranked
  };
}
function cpuIntel(room, p, target) {
  const latest = cpuLatestScout(p, target.playerId);
  const age = latest ? Math.max(0, room.turn - Number(latest.turn || room.turn)) : 99;
  const freshness = latest ? Math.max(0.15, 1 - age * 0.12) : 0;
  const attackResult = cpuBrain(p).attackResults[target.playerId] || { success:0, fail:0 };
  const knownCards = latest ? Object.values(latest.hand || {}).reduce((s,n) => s + Number(n||0), 0) : null;
  return {
    latest,
    age,
    freshness,
    hp: latest ? Number(latest.hp) : null,
    kills: latest ? Number(latest.kills || 0) : 0,
    knownCards,
    attackSuccesses: Number(attackResult.success || 0),
    attackFails: Number(attackResult.fail || 0),
    objective: cpuObjectiveInference(room, p, target)
  };
}
function cpuTargetThreat(room, p, target) {
  if (!target?.alive) return -50;
  const i = cpuIntel(room, p, target);
  let score = 12;
  score += i.kills * 8 * i.freshness;
  score += i.attackSuccesses * 2;
  if (i.knownCards != null) score += Math.min(10, i.knownCards * 0.6) * i.freshness;
  if (i.hp != null) score += Math.max(0, i.hp - 2) * 1.2 * i.freshness;
  if (!i.latest) score += 2; // 未偵察相手も過小評価しない。
  return score;
}
function cpuAttackOpportunity(room, p, target) {
  const i = cpuIntel(room, p, target);
  let score = cpuTargetThreat(room, p, target) * 0.55;
  if (i.hp != null) {
    if (i.hp <= 1) score += 34;
    else if (i.hp === 2) score += 24;
    else if (i.hp === 3) score += 12;
    if (i.age >= 3) score *= 0.9;
  }
  score += i.attackSuccesses * 3 - i.attackFails * 1.5;
  return score;
}
function cpuInformationValue(room, p, target) {
  const latest = cpuLatestScout(p, target.playerId);
  let score = latest ? 10 + Math.min(16, Math.max(0, room.turn - Number(latest.turn||0)) * 4) : 29;
  if (target.alive) score += 5;
  if (target.secretState?.invalid) score -= 7;
  if (room.turn >= 11) score -= 7;
  return score;
}
function cpuDueContracts(room, p) {
  return (room.publicContracts || []).filter(c => c.status === 'accepted' && c.dueTurn === room.turn && Array.isArray(c.acceptorIds) && c.acceptorIds.includes(p.playerId));
}
function cpuContractBonus(room, p, normal, targetId) {
  let bonus = 0;
  for (const c of cpuDueContracts(room, p)) {
    let matches = false;
    if (c.conditionType === 'attackTarget') matches = normal === 'attack' && targetId === c.subjectId;
    if (c.conditionType === 'dontAttackIssuer') matches = !(normal === 'attack' && targetId === c.issuerId);
    if (c.conditionType === 'defendIssuer') matches = normal === 'defense' && targetId === c.issuerId;
    if (c.conditionType === 'accuseTarget') matches = normal === 'accusation' && targetId === c.subjectId;
    if (matches) bonus += contractRewardPerPlayer(c.reward, c.dueTurn === MAX_TURNS ? 2 : 1);
  }
  return bonus;
}

function cpuObjectiveFeasibility(room, p) {
  const key = p.objective?.key || null;
  const turnsLeft = Math.max(1, MAX_TURNS - room.turn + 1);
  const s = p.stats || {};
  if (!key || p.secretState?.invalid || p.secretState?.achieved) return { key, active:false, feasible:false, need:0, turnsLeft, urgency:0 };
  let feasible = true;
  let need = 0;
  if (key === 'observer') need = Math.max(0, 3 - Number(s.consecutiveScoutTurns || 0));
  else if (key === 'tracker') need = Math.max(0, 5 - Math.max(0, ...Object.values(s.scoutCounts || {}).map(Number)));
  else if (key === 'gambler') {
    const unscouted = cpuUnresolvedAccusationTargets(room,p).filter(t => !(s.scoutedTargets || []).includes(t.playerId));
    need = unscouted.length ? 1 : 99;
  } else if (key === 'killer') need = Math.max(0, 3 - Number(s.consecutiveAttackTurns || 0));
  else if (key === 'reaper') {
    const counts = {};
    for (const id of s.attackTargets || []) counts[id] = (counts[id] || 0) + 1;
    need = Math.max(0, 5 - Math.max(0, ...Object.values(counts).map(Number)));
  } else if (key === 'ironWall') need = Math.max(0, 3 - Number(s.defenseSuccessTurns || 0));
  else if (key === 'endurer') feasible = Number(s.healsUsed || 0) === 0;
  else if (key === 'nearDeath') need = Math.max(0, 5 - Number(s.damageTaken || 0));
  else if (key === 'unguarded') feasible = Number(s.defensesUsed || 0) === 0;
  else if (key === 'hermit') feasible = Number(s.specialsUsed || 0) === 0;
  if (['observer','tracker','killer','reaper','ironWall'].includes(key) && need > turnsLeft) feasible = false;
  if (key === 'gambler' && need > 1) feasible = false;
  let urgency = 0;
  if (feasible) {
    if (['endurer','unguarded','hermit'].includes(key)) urgency = 36 + (room.turn / MAX_TURNS) * 18;
    else if (need > 0) urgency = 24 + Math.min(36, (need / turnsLeft) * 42) + (turnsLeft <= need + 1 ? 18 : 0);
    else urgency = 22;
  }
  return { key, active:true, feasible, need, turnsLeft, urgency };
}
function cpuStrategicContext(room, p) {
  const standing = room.turn >= 10 ? currentPointsStanding(room, p.playerId) : null;
  const total = Math.max(2, Number(standing?.total || room.players.length || 5));
  const rankPressure = standing ? Math.max(0, (Number(standing.rank || total) - 1) / (total - 1)) : 0.45;
  const leading = !!standing && Number(standing.rank) === 1;
  const endgame = room.turn / MAX_TURNS;
  const hpRisk = Math.max(0, (4 - Number(p.hp || 0)) / 3);
  const survivalPressure = 12 + hpRisk * 34 + endgame * 18 + (leading ? 16 : 0) + (room.turn >= 13 ? 14 : 0);
  const comebackPressure = rankPressure * (18 + endgame * 20);
  return { standing, rankPressure, leading, endgame, hpRisk, survivalPressure, comebackPressure, objective:cpuObjectiveFeasibility(room,p) };
}
function cpuReplan(room, p) {
  if (!room || room.status !== 'playing' || room.phase !== 'chat' || !isTestCpu(p) || !p.alive) return false;
  p.draft = buildTestCpuDraft(room, p);
  p.ready = true;
  p.turnHadManualInput = true;
  return true;
}
function cpuObjectiveActionBonus(room, p, normal, targetId) {
  const ctx = cpuStrategicContext(room,p);
  const plan = ctx.objective;
  const key = plan.key;
  if (!plan.active || !plan.feasible) return 0;
  const s = p.stats || {};
  let b = 0;
  if (key === 'observer' && normal === 'scout') b += plan.urgency + Number(s.consecutiveScoutTurns || 0) * 11;
  if (key === 'tracker' && normal === 'scout') {
    const count = Number(s.scoutCounts?.[targetId] || 0);
    b += plan.urgency * 0.72 + count * 12 + (count >= 4 ? 42 : 0);
  }
  if (key === 'gambler' && normal === 'accusation') {
    const wasScouted = (s.scoutedTargets || []).includes(targetId);
    b += wasScouted ? -90 : plan.urgency + 18;
  }
  if (key === 'killer' && normal === 'attack') b += plan.urgency + Number(s.consecutiveAttackTurns || 0) * 12;
  if (key === 'reaper' && normal === 'attack') {
    const count = (s.attackTargets || []).filter(id => id === targetId).length;
    b += plan.urgency * 0.72 + count * 12 + (count >= 4 ? 42 : 0);
  }
  if (key === 'ironWall' && normal === 'defense') b += plan.urgency + Number(s.defenseSuccessTurns || 0) * 8;
  if (key === 'endurer' && normal === 'heal') b -= 500;
  if (key === 'unguarded' && normal === 'defense') b -= 500;
  if (key === 'nearDeath') {
    const needDamage = Math.max(0, 5 - Number(s.damageTaken || 0));
    if (needDamage > 0 && normal === 'defense' && p.hp >= 3) b -= 35 + needDamage * 4;
    if (needDamage > 0 && normal === 'heal' && p.hp >= 3) b -= 24;
    if (p.hp <= 1 && normal === 'heal') b += 70; // 目標より生存を優先する非常時。
  }
  return b;
}
function cpuNormalCandidateScore(room, p, normal, target) {
  const targetId = target?.playerId || null;
  const profile = cpuBrain(p).profile;
  const ctx = cpuStrategicContext(room,p);
  let score = 0;
  if (normal === null) score = 2 + (ctx.leading ? 2 : 0);
  if (normal === 'attack') {
    score = 12 * profile.aggression + cpuAttackOpportunity(room, p, target) + ctx.comebackPressure * 0.35;
    const ti = cpuIntel(room,p,target);
    if (ti.hp != null && ti.hp <= 2) score += 10;
    if (room.turn === MAX_TURNS) score += 16;
  }
  if (normal === 'scout') {
    score = cpuInformationValue(room, p, target) * profile.information;
    score += room.turn <= 7 ? 8 : room.turn <= 11 ? 3 : -5;
    if (!cpuLatestScout(p,targetId)) score += 4;
  }
  if (normal === 'defense') {
    if (targetId === p.playerId) {
      score = ctx.survivalPressure * profile.caution + (ctx.leading ? 12 : 0);
      if (p.hp >= 5 && room.turn < 10) score -= 18;
    } else {
      const ti = cpuIntel(room, p, target);
      score = 2 + (ti.hp != null && ti.hp <= 2 ? 5 : 0);
      // 他人防御は+15Pを狙えるが、相手の生存も助けるため契約なしでは低評価。
      if (room.turn === MAX_TURNS) score -= 8;
    }
  }
  if (normal === 'heal') {
    if (targetId === p.playerId) {
      score = (p.hp <= 1 ? 78 : p.hp === 2 ? 52 : p.hp === 3 ? 24 : 1) * profile.caution + ctx.survivalPressure * 0.45;
      if (room.turn === MAX_TURNS && p.hp <= 3) score += 20;
    } else {
      const ti = cpuIntel(room, p, target);
      score = ti.hp != null && ti.hp <= 2 ? 2 : -8;
      if (room.turn === MAX_TURNS) score -= 30; // 相手の完走+50Pを助ける危険が大きい。
    }
  }
  if (normal === 'accusation') {
    const inf = cpuObjectiveInference(room, p, target);
    const expected = inf.confidence * SCORING.accusationSuccess + (1 - inf.confidence) * SCORING.accusationFailure;
    score = expected + inf.confidence * 18 + ctx.comebackPressure * 0.25;
    if (p.objective?.key === 'gambler' && !(p.stats.scoutedTargets || []).includes(targetId)) score += inf.confidence * SECRET_REWARD;
    if (inf.confidence < 0.18 && p.objective?.key !== 'gambler') score -= 13;
    if (room.turn === MAX_TURNS) score += expected; // 最終ターンは告発得点/失点が2倍。
  }
  score += cpuObjectiveActionBonus(room, p, normal, targetId);
  score += cpuContractBonus(room, p, normal, targetId) * 1.55;
  if (room.turn === MAX_TURNS && ['attack','defense'].includes(normal)) score += 12;
  return score + cpuJitter(1.4);
}
function cpuForcedDraft(room, p) {
  const forced = p.forcedNormalType?.turn === room.turn ? p.forcedNormalType : null;
  if (!forced || forced.conflict || !forced.type || (p.hand[forced.type] || 0) <= 0) return null;
  const d = cpuEmptyDraft();
  d.normal = forced.type;
  d.normalTargetId = forced.targetId || null;
  if (d.normal === 'accusation') {
    const target = getPlayer(room, d.normalTargetId);
    d.accusationGuess = target ? cpuObjectiveInference(room, p, target).guess : cpuRandom(OBJECTIVES)?.key || null;
  }
  return d;
}
function cpuBestNormalPlan(room, p) {
  const forced = cpuForcedDraft(room, p);
  if (forced) return { draft:forced, score:999, confidence:1 };
  const candidates = [{ normal:null, target:null, score:cpuNormalCandidateScore(room, p, null, null) }];
  const aliveTargets = cpuAliveTargets(room, p);
  const anyTargets = cpuAnyTargets(room, p);
  const accusationTargets = cpuUnresolvedAccusationTargets(room, p);
  const allAliveIncludingSelf = room.players.filter(x => x.alive);
  const available = Object.keys(NORMAL_CARDS).filter(k => (p.hand[k] || 0) > 0);
  for (const normal of available) {
    let targets = [];
    if (normal === 'attack') targets = aliveTargets;
    if (normal === 'scout') targets = anyTargets;
    if (normal === 'accusation') targets = accusationTargets;
    if (normal === 'defense' || normal === 'heal') targets = allAliveIncludingSelf;
    for (const target of targets) candidates.push({ normal, target, score:cpuNormalCandidateScore(room, p, normal, target) });
  }
  candidates.sort((a,b) => b.score - a.score);
  const best = candidates[0] || { normal:null, target:null, score:0 };
  const second = candidates[1] || { score:best.score - 8 };
  const d = cpuEmptyDraft();
  d.normal = best.normal;
  d.normalTargetId = best.target?.playerId || null;
  if (best.normal === 'accusation' && best.target) d.accusationGuess = cpuObjectiveInference(room, p, best.target).guess;
  return { draft:d, score:best.score, confidence:Math.max(0, Math.min(1, 0.5 + (best.score - second.score) / 35)) };
}
function cpuBestThreatTarget(room, p, candidates = null) {
  const pool = (candidates || cpuAliveTargets(room, p)).filter(x => x && x.playerId !== p.playerId);
  return pool.sort((a,b) => cpuTargetThreat(room,p,b) - cpuTargetThreat(room,p,a) + cpuJitter(0.5))[0] || null;
}
function cpuBestAttackTarget(room, p, candidates = null, excludeId = null) {
  const pool = (candidates || cpuAliveTargets(room, p)).filter(x => x.playerId !== excludeId);
  return pool.sort((a,b) => cpuAttackOpportunity(room,p,b) - cpuAttackOpportunity(room,p,a) + cpuJitter(0.5))[0] || null;
}
function cpuKnownCardCount(p, targetId, type) {
  const latest = cpuLatestScout(p, targetId);
  return latest ? Number(latest.hand?.[type] || 0) : null;
}
function cpuChooseSpecial(room, p, plan) {
  const d = { ...plan.draft };
  const ctx = cpuStrategicContext(room,p);
  if (p.objective?.key === 'hermit' && ctx.objective.feasible) return d;
  const owned = Object.keys(SPECIAL_CARDS).filter(k => (p.specials[k] || 0) > 0);
  if (!owned.length) return d;
  const options = [{ special:null, score:0 }];
  const stage = room.turn / MAX_TURNS;
  const reserveBias = stage < 0.4 ? 15 : stage < 0.72 ? 9 : stage < 0.9 ? 3 : 0;

  if (owned.includes('fullDefense')) {
    let score = ctx.survivalPressure + (p.hp <= 1 ? 30 : p.hp === 2 ? 18 : 0) + (ctx.leading ? 12 : 0);
    if (room.turn === MAX_TURNS) score += 28;
    if (p.objective?.key === 'nearDeath' && ctx.objective.feasible && Number(p.stats.damageTaken || 0) < 5 && p.hp >= 3) score -= 34;
    options.push({ special:'fullDefense', score:score - reserveBias });
  }
  if (owned.includes('cancel')) {
    const target = cpuBestThreatTarget(room, p);
    if (target) options.push({ special:'cancel', target, score:14 + cpuTargetThreat(room,p,target) * 0.85 + (ctx.leading ? 8 : 0) + (room.turn >= 12 ? 14 : 0) - reserveBias });
  }
  if (owned.includes('steal')) {
    const target = cpuBestThreatTarget(room, p);
    if (target) options.push({ special:'steal', target, score:17 + cpuTargetThreat(room,p,target) * 0.48 + ctx.comebackPressure * 0.7 + (room.turn >= 10 ? 12 : 0) - reserveBias });
  }
  if (owned.includes('specify')) {
    let best = null;
    for (const forcedPlayer of cpuAliveTargets(room, p)) {
      const knownAttack = cpuKnownCardCount(p, forcedPlayer.playerId, 'attack');
      if (knownAttack === 0) continue;
      const victimPool = room.players.filter(x => x.alive && x.playerId !== forcedPlayer.playerId && x.playerId !== p.playerId);
      const victim = cpuBestAttackTarget(room, p, victimPool);
      if (!victim) continue;
      const intelBonus = knownAttack == null ? -4 : Math.min(16, knownAttack * 5);
      const value = 18 + intelBonus + cpuAttackOpportunity(room, p, victim) * 0.78 + cpuTargetThreat(room,p,forcedPlayer) * 0.18 + (room.turn >= 11 ? 8 : 0);
      if (!best || value > best.score) best = { special:'specify', target:forcedPlayer, forcedType:'attack', forcedTarget:victim, score:value - reserveBias };
    }
    if (best) options.push(best);
  }
  if (owned.includes('double') && d.normal) {
    let score = 0;
    if (d.normal === 'attack') {
      const first = getPlayer(room, d.normalTargetId);
      score = 16 + (first ? cpuAttackOpportunity(room,p,first) * 0.58 : 0) + (room.turn === MAX_TURNS ? 34 : 0);
      if (['killer','reaper'].includes(p.objective?.key) && ctx.objective.feasible) score += 10;
    } else if (d.normal === 'scout') {
      score = 8 + (['observer','tracker'].includes(p.objective?.key) && ctx.objective.feasible ? 15 : 0) + (room.turn <= 9 ? 5 : -4);
    } else if (d.normal === 'accusation') {
      const first = getPlayer(room, d.normalTargetId);
      const inf = first ? cpuObjectiveInference(room,p,first) : null;
      const combined = inf ? Math.min(0.98, inf.confidence + inf.secondConfidence) : 0;
      score = 8 + combined * 38 + ctx.comebackPressure * 0.35 + (room.turn === MAX_TURNS ? 24 : 0);
    } else if (d.normal === 'defense') score = ctx.survivalPressure * 0.75 + (room.turn === MAX_TURNS ? 20 : 0);
    else if (d.normal === 'heal') score = p.hp <= 2 ? 34 + ctx.survivalPressure * 0.45 : 4;
    options.push({ special:'double', score:score - reserveBias });
  }
  options.sort((a,b) => b.score - a.score + cpuJitter(0.35));
  const best = options[0];
  if (!best?.special || best.score < 18) return d;
  d.special = best.special;
  if (['cancel','steal','specify'].includes(best.special)) d.specialTargetId = best.target?.playerId || null;
  if (best.special === 'steal') d.stealAmount = 25;
  if (best.special === 'specify') {
    d.specifiedType = best.forcedType;
    d.specifiedTargetId = best.forcedTarget?.playerId || null;
  }
  if (best.special === 'double' && ['attack','scout','accusation'].includes(d.normal)) {
    if (d.normal === 'attack') {
      const first = getPlayer(room, d.normalTargetId);
      const firstIntel = first ? cpuIntel(room,p,first) : null;
      const sameTarget = first && firstIntel?.hp != null && firstIntel.hp <= 2;
      const second = sameTarget ? first : cpuBestAttackTarget(room, p, cpuAliveTargets(room,p), d.normalTargetId);
      d.secondNormalTargetId = second?.playerId || d.normalTargetId;
    } else if (d.normal === 'scout') {
      const second = cpuAnyTargets(room,p).filter(x => x.playerId !== d.normalTargetId).sort((a,b) => cpuInformationValue(room,p,b) - cpuInformationValue(room,p,a))[0];
      d.secondNormalTargetId = second?.playerId || null;
    } else if (d.normal === 'accusation') {
      const first = getPlayer(room, d.normalTargetId);
      const firstInf = first ? cpuObjectiveInference(room,p,first) : null;
      // 同じ相手に上位2仮説をぶつけられる仕様を利用。十分な第二仮説がある時はこちらを優先する。
      if (first && firstInf?.secondGuess && firstInf.secondGuess !== d.accusationGuess && firstInf.secondConfidence >= 0.08) {
        d.secondNormalTargetId = first.playerId;
        d.secondAccusationGuess = firstInf.secondGuess;
      } else {
        const pool = cpuUnresolvedAccusationTargets(room,p).filter(x => x.playerId !== d.normalTargetId)
          .map(x => ({ target:x, inf:cpuObjectiveInference(room,p,x) })).sort((a,b) => b.inf.confidence - a.inf.confidence);
        const second = pool[0];
        if (second) {
          d.secondNormalTargetId = second.target.playerId;
          d.secondAccusationGuess = second.inf.guess;
        }
      }
    }
  }
  return d;
}
function buildTestCpuDraft(room, p) {
  const empty = cpuEmptyDraft();
  if (!p?.alive) return empty;
  const plan = cpuBestNormalPlan(room, p);
  let d = cpuChooseSpecial(room, p, plan);
  const checked = validateDraft(room, p, d, { strict:true });
  if (!checked.ok) {
    // 特殊カードの組合せだけが不正だった場合、通常行動を捨てず特殊だけ外して再検証する。
    const withoutSpecial = { ...d, special:null, secondNormalTargetId:null, specialTargetId:null, secondAccusationGuess:null, stealAmount:5, specifiedType:null, specifiedTargetId:null };
    const retry = validateDraft(room, p, withoutSpecial, { strict:true });
    d = retry.ok ? retry.draft : empty;
  } else d = checked.draft;
  const brain = cpuBrain(p);
  brain.lastPlan = { turn:room.turn, ...structuredClone(d) };
  return d;
}
function createTestCpuPlayer(room) {
  const p = createPlayer({ socketId:null });
  p.isCpu = true;
  p.connected = false;
  p.autoAdvance = true;
  p.chips = Math.max(Number(GOGI_CHIPS.initialBalance || 100000), Number(room?.chipStake || 0));
  p.clientInstanceId = `cpu_${randomId('client')}`;
  p.pageInstanceId = `cpu_${randomId('page')}`;
  p.browserId = `cpu_${randomId('browser')}`;
  cpuBrain(p);
  room.players.push(p);
  return p;
}
function fillRoomWithTestCpu(room) {
  if (!room || room.status !== 'lobby') return 0;
  let added = 0;
  while (room.players.length < MAX_PLAYERS) { createTestCpuPlayer(room); added++; }
  return added;
}

function cpuObjectivePurchaseType(p) {
  switch (p.objective?.key) {
    case 'observer': case 'tracker': return 'scout';
    case 'gambler': return 'accusation';
    case 'killer': case 'reaper': return 'attack';
    case 'ironWall': return 'defense';
    case 'nearDeath': return p.hp <= 2 ? 'heal' : 'attack';
    case 'endurer': return 'attack';
    case 'unguarded': return 'attack';
    default: return null;
  }
}
function cpuCardNeedScore(room, p, type) {
  const have = Number(p.hand?.[type] || 0);
  const plan = cpuObjectiveFeasibility(room,p);
  let score = Math.max(0, 9 - have * 3);
  const preferred = plan.feasible ? cpuObjectivePurchaseType(p) : null;
  if (preferred === type && !p.secretState?.achieved && !p.secretState?.invalid) score += 34 + plan.urgency * 0.35;
  if (type === 'heal' && p.hp <= 2 && p.objective?.key !== 'endurer') score += 42;
  if (type === 'defense' && p.hp <= 2 && p.objective?.key !== 'unguarded') score += 24;
  if (type === 'accusation') {
    const best = cpuUnresolvedAccusationTargets(room,p).map(t => cpuObjectiveInference(room,p,t).confidence).sort((a,b)=>b-a)[0] || 0;
    score += best >= 0.30 ? best * 24 : 0;
  }
  if (room.turn >= 13 && type === 'scout' && !['observer','tracker'].includes(p.objective?.key)) score -= 16;
  if (room.turn >= 14 && preferred !== type && !(['heal','defense'].includes(type) && p.hp <= 2)) score -= 12;
  if (p.objective?.key === 'endurer' && plan.feasible && type === 'heal') score = -500;
  if (p.objective?.key === 'unguarded' && plan.feasible && type === 'defense') score = -500;
  return score;
}
function cpuBuy(room, p, type) {
  if (!isTestCpu(p) || !p.alive || room.phase !== 'chat') return false;
  if (type === 'special') {
    if (p.points < SPECIAL_PURCHASE_PRICE) return false;
    const keys = Object.keys(SPECIAL_CARDS);
    const special = cpuRandom(keys);
    if (!special) return false;
    p.points -= SPECIAL_PURCHASE_PRICE;
    p.specials[special] = (p.specials[special] || 0) + 1;
    p.stats.specialPurchases++;
    p.stats.lastSpecialPurchaseTurn = room.turn;
    p.turnHadManualInput = true;
    log(room, `${p.color.label}（CP）が特殊カードを購入しました。`);
    return true;
  }
  const def = NORMAL_CARDS[type];
  if (!def || p.points < def.price) return false;
  p.points -= def.price;
  p.hand[type] = (p.hand[type] || 0) + 1;
  p.stats.normalPurchases++;
  p.stats.lastNormalPurchaseType = type;
  p.stats.lastNormalPurchaseTurn = room.turn;
  p.turnHadManualInput = true;
  log(room, `${p.color.label}（CP）が通常カードを購入しました。`);
  return true;
}
function cpuPointReserve(room, p) {
  let reserve = room.turn <= 9 && !p.winnerBet ? 10 : 5;
  if (p.hp <= 2) reserve += 10;
  if (room.turn >= 13) reserve = Math.min(reserve, 10);
  return reserve;
}
function maybeRunCpuPurchases(room) {
  for (const p of room.players) {
    if (!isTestCpu(p) || !p.alive) continue;
    const reserve = cpuPointReserve(room, p);
    const options = Object.keys(NORMAL_CARDS).map(type => ({ type, score:cpuCardNeedScore(room,p,type), price:NORMAL_CARDS[type].price }))
      .filter(x => x.score >= 30 && p.points - x.price >= reserve).sort((a,b) => b.score - a.score);
    // 購入自体は無制限だが、CPは期待値の低い買い溜めをしない。緊急時/秘密目標用のみ最大2枚。
    for (const option of options.slice(0, 2)) cpuBuy(room, p, option.type);
    const specialCount = Object.values(p.specials || {}).reduce((s,n)=>s+Number(n||0),0);
    const obj = cpuObjectiveFeasibility(room,p);
    const shouldBuySpecial = !(p.objective?.key === 'hermit' && obj.feasible) && specialCount === 0 && room.turn <= 12 && p.points - SPECIAL_PURCHASE_PRICE >= reserve + 20 && (p.hp <= 2 || room.turn >= 9 || p.points >= 100);
    if (shouldBuySpecial) cpuBuy(room, p, 'special');
  }
}
function cpuWinCandidateScore(room, p, candidate) {
  if (!candidate.alive) return -80;
  if (candidate.playerId === p.playerId) {
    let s = 32 + p.points * 0.55 + p.hp * 4;
    if (p.secretState?.achieved) s += 10;
    if (!p.secretState?.invalid && !p.secretState?.achieved) s += 6;
    return s;
  }
  const i = cpuIntel(room, p, candidate);
  let s = 30 + i.kills * 13;
  if (i.hp != null) s += i.hp * 4 * i.freshness;
  if (i.knownCards != null) s += Math.min(18, i.knownCards * 0.8) * i.freshness;
  if (!i.latest) s += 4;
  return s;
}
function maybePlaceCpuWinnerBets(room) {
  if (!WINNER_BET.allowedTurns.includes(room.turn)) return;
  for (const p of room.players) {
    if (!isTestCpu(p) || !p.alive || p.winnerBet || p.points < WINNER_BET.step || !canPlaceWinnerBet(room, p)) continue;
    const ranked = room.players.map(target => ({ target, score:cpuWinCandidateScore(room,p,target) })).sort((a,b)=>b.score-a.score);
    if (!ranked.length) continue;
    const maxScore = ranked[0].score;
    const temperature = room.turn === 3 ? 24 : room.turn === 6 ? 18 : 14;
    const weighted = ranked.map(x => ({ ...x, weight:Math.exp((x.score - maxScore)/temperature) }));
    const totalWeight = weighted.reduce((s,x)=>s+x.weight,0) || 1;
    for (const x of weighted) x.probability = x.weight / totalWeight;
    const best = weighted[0];
    const multiplier = Number(WINNER_BET.multipliers?.[room.turn] || 1);
    const expectedReturnRatio = best.probability * multiplier;
    if (expectedReturnRatio < 1.03 && room.turn !== 9) continue;
    const reserve = cpuPointReserve(room,p);
    const budget = Math.max(0, p.points - reserve);
    if (budget < WINNER_BET.step) continue;
    const edge = Math.max(0, expectedReturnRatio - 1);
    const baseFraction = room.turn === 3 ? 0.28 : room.turn === 6 ? 0.24 : 0.20;
    const fraction = Math.min(0.48, baseFraction + edge * 0.10 + best.probability * 0.10);
    let amount = Math.floor((budget * fraction) / WINNER_BET.step) * WINNER_BET.step;
    amount = Math.max(WINNER_BET.step, amount);
    amount = Math.min(amount, budget - (budget % WINNER_BET.step));
    if (best?.target && amount >= WINNER_BET.step) placeWinnerBet(room, p, best.target.playerId, amount);
  }
}
function cpuCardStrategicValue(room, p, type, { special=false } = {}) {
  if (special) return 38 + (room.turn >= 10 ? 12 : 0) + (p.hp <= 2 ? 8 : 0);
  const def = NORMAL_CARDS[type];
  if (!def) return 0;
  return def.price + cpuCardNeedScore(room,p,type) * 0.65;
}
function cpuBundleValue(room, p, bundle) {
  let value = Number(bundle?.points || 0);
  if (bundle?.card) value += cpuCardStrategicValue(room,p,bundle.card.type,{ special:bundle.card.special === true });
  return value;
}
function cpuDesiredTradeCard(room, p) {
  return Object.keys(NORMAL_CARDS).map(type => ({ type, value:cpuCardStrategicValue(room,p,type) - Number(p.hand?.[type]||0) * 4 }))
    .sort((a,b)=>b.value-a.value)[0]?.type || 'attack';
}
function maybeCreateCpuExchanges(room) {
  if (!Array.isArray(room.exchangeRequests)) room.exchangeRequests = [];
  for (const cpu of room.players) {
    if (!isTestCpu(cpu) || !cpu.alive) continue;
    const wantedType = cpuDesiredTradeCard(room, cpu);
    if ((cpu.hand[wantedType] || 0) >= 3 && cpuCardNeedScore(room,cpu,wantedType) < 30) continue;
    // 相手のready状態は対戦中非公開なので判断材料にしない。
    const candidates = room.players.filter(x => x.alive && x.playerId !== cpu.playerId);
    if (!candidates.length) continue;
    candidates.sort((a,b) => {
      const ac = cpuKnownCardCount(cpu,a.playerId,wantedType); const bc = cpuKnownCardCount(cpu,b.playerId,wantedType);
      const av = ac == null ? 0.8 : ac; const bv = bc == null ? 0.8 : bc;
      return bv - av + cpuJitter(0.35);
    });
    const target = candidates[0];
    if (cpuKnownCardCount(cpu,target.playerId,wantedType) === 0) continue;
    const spareTypes = Object.keys(NORMAL_CARDS).filter(k => (cpu.hand[k] || 0) >= 2 && canTransferNormalCard(room, cpu, k) && k !== wantedType)
      .sort((a,b) => cpuCardStrategicValue(room,cpu,a) - cpuCardStrategicValue(room,cpu,b));
    let offer = { points:0, card:null };
    const wantedValue = cpuCardStrategicValue(room,cpu,wantedType);
    const spare = spareTypes[0];
    if (spare && cpuCardStrategicValue(room,cpu,spare) <= wantedValue * 0.82) {
      const taken = takeCardForExchange(room, cpu, { type:spare, special:false });
      if (!taken.ok) continue;
      offer.card = taken.card;
    } else {
      const offerPoints = Math.min(15, Math.max(5, Math.ceil(Math.min(wantedValue * 0.30, cpu.points) / 5) * 5));
      if (cpu.points - offerPoints < cpuPointReserve(room,cpu)) continue;
      cpu.points -= offerPoints;
      offer.points = offerPoints;
    }
    const request = { points:0, card:{ type:wantedType, special:false, cardLabel:NORMAL_CARDS[wantedType].label } };
    const req = { requestId:randomId('ex'), fromId:cpu.playerId, toId:target.playerId, offer, request, turn:room.turn, createdAt:now() };
    room.exchangeRequests.push(req);
    cpu.turnHadManualInput = true;
    log(room, `${cpu.color.label}（CP）から${target.color.label}${isTestCpu(target) ? '（CP）' : ''}へ交換提案が届きました。`, [cpu.playerId, target.playerId]);
    emitGameNotice(room, [target.playerId], { kind:'exchange', toolTarget:'transfer', text:`${cpu.color.label}（CP）から交換提案が届きました。` });
    if (isTestCpu(target)) tryAcceptExchangeAsCpu(room, req);
  }
}
function tryAcceptExchangeAsCpu(room, req) {
  const cpu = req && getPlayer(room, req.toId);
  const from = req && getPlayer(room, req.fromId);
  if (!isTestCpu(cpu) || !cpu.alive || !from?.alive) return false;
  const wantPoints = Number(req.request?.points || 0);
  if (cpu.points < wantPoints || cpu.points - wantPoints < cpuPointReserve(room,cpu)) return false;
  let targetCard = null;
  if (req.request?.card) {
    const normalized = normalizeExchangeCard(room, cpu, req.request.card.type, req.request.card.special, { requireOwned:true });
    if (!normalized || normalized.error) return false;
    targetCard = normalized;
  }
  const requestValue = wantPoints + (targetCard ? cpuCardStrategicValue(room,cpu,targetCard.type,{ special:targetCard.special === true }) : 0);
  const offerValue = cpuBundleValue(room,cpu,req.offer);
  // 自分の秘密目標に直結するカードを手放す取引は、かなり有利な条件でない限り拒否する。
  const criticalType = cpuObjectivePurchaseType(cpu);
  const criticalPenalty = targetCard && !targetCard.special && targetCard.type === criticalType && !cpu.secretState?.achieved ? 18 : 0;
  if (offerValue + cpuJitter(2) < requestValue + criticalPenalty - 3) return false;

  cpu.points -= wantPoints;
  if (targetCard) {
    const taken = takeCardForExchange(room, cpu, targetCard);
    if (!taken.ok) { cpu.points += wantPoints; return false; }
    targetCard = taken.card;
  }
  removeExchangeRequest(room, req.requestId);
  cpu.points += Number(req.offer?.points || 0);
  giveExchangeCard(cpu, req.offer?.card);
  from.points += wantPoints;
  giveExchangeCard(from, targetCard);
  cpu.turnHadManualInput = true;
  log(room, `交換成立：${from.color.label}「${bundleLabel(req.offer)}」⇔ ${cpu.color.label}（CP）「${bundleLabel({ points:wantPoints, card:targetCard })}」`);
  emitGameNotice(room, [from.playerId], { kind:'exchange', toolTarget:'transfer', text:`交換成立：${from.color.label} ⇔ ${cpu.color.label}（CP）` });
  emitPlayerState(room, from);
  cpuReplan(room, cpu);
  return true;
}
function cpuContractPlan(room, cpu) {
  const reserve = cpuPointReserve(room,cpu);
  if (cpu.points - 20 < reserve) return null;
  const ctx = cpuStrategicContext(room,cpu);
  const aliveTargets = cpuAliveTargets(room,cpu);
  if (!aliveTargets.length) return null;
  const threat = cpuBestThreatTarget(room,cpu,aliveTargets);
  const attack = cpuBestAttackTarget(room,cpu,aliveTargets);
  const unresolved = cpuUnresolvedAccusationTargets(room,cpu).map(t => ({ target:t, inf:cpuObjectiveInference(room,cpu,t) })).sort((a,b)=>b.inf.confidence-a.inf.confidence);
  const options = [];
  if (cpu.hp <= 2 || (ctx.leading && room.turn >= 10) || room.turn >= 14) options.push({ kind:'defendIssuer', subject:null, utility:38 + ctx.survivalPressure * 0.6 });
  if (cpu.hp <= 3 && room.turn >= 8) options.push({ kind:'dontAttackIssuer', subject:null, utility:26 + ctx.survivalPressure * 0.55 });
  if (attack) options.push({ kind:'attackTarget', subject:attack, utility:15 + cpuAttackOpportunity(room,cpu,attack) * 0.72 + cpuTargetThreat(room,cpu,attack) * 0.28 + ctx.comebackPressure * 0.45 });
  if (threat && unresolved[0]?.target?.playerId === threat.playerId && unresolved[0].inf.confidence >= 0.24) {
    options.push({ kind:'accuseTarget', subject:threat, utility:14 + unresolved[0].inf.confidence * 42 + cpuTargetThreat(room,cpu,threat) * 0.22 + ctx.comebackPressure * 0.3 });
  }
  options.sort((a,b)=>b.utility-a.utility + cpuJitter(0.35));
  const best = options[0];
  if (!best || best.utility < 34) return null;
  const can40 = cpu.points - 40 >= reserve;
  const stake = can40 && best.utility >= 58 && (room.turn >= 11 || cpu.hp <= 2 || ctx.rankPressure >= 0.5) ? 40 : 20;
  if (!validContractStake(stake,cpu.points)) return null;
  return { ...best, stake };
}
function maybePostCpuPublicContracts(room) {
  if (!Array.isArray(room.publicContracts)) room.publicContracts = [];
  for (const cpu of room.players) {
    if (!isTestCpu(cpu) || !cpu.alive) continue;
    const plan = cpuContractPlan(room,cpu);
    if (!plan) continue;
    // 乱発ではなく「このターンに意味がある」と評価した場合のみ1件提示する。
    const kind = plan.kind;
    const subject = plan.subject;
    const stake = plan.stake;
    cpu.points -= stake;
    const contract = { contractId:randomId('ct'), issuerId:cpu.playerId, acceptorIds:[], conditionType:kind, subjectId:subject?.playerId || null, reward:stake, createdTurn:room.turn, dueTurn:room.turn, status:'open', createdAt:now() };
    room.publicContracts.push(contract);
    const autoParticipantCount = autoEnrollPublicContract(room, contract);
    cpu.turnHadManualInput = true;
    const perPlayer = contractRewardPerPlayer(stake, room.turn === MAX_TURNS ? 2 : 1);
    const targetColor = ['dontAttackIssuer','defendIssuer'].includes(kind) ? cpu.color.label : (subject?.color?.label || '');
    const condition = kind === 'attackTarget' ? `このターンに${targetColor}を有効な攻撃で狙う`
      : kind === 'dontAttackIssuer' ? `このターンに${targetColor}を攻撃しない`
      : kind === 'defendIssuer' ? `このターンに${targetColor}へ防御カードを使う`
      : `このターンに${targetColor}へ告発する（成功・失敗どちらでも可）`;
    log(room, `公開契約を提示：「${condition}」（報酬1人${perPlayer}P / 自動参加${autoParticipantCount}人）。`);
    emitGameNotice(room, room.players.map(x => x.playerId), { kind:'contract', toolTarget:'contractBox', text:`公開契約が提示されました：${condition} / 報酬1人${perPlayer}P / 対象者は自動参加` });
  }
}
function autoEnrollPublicContract(room, contract) {
  if (!contract || !Array.isArray(room.players)) return 0;
  // 公開契約は選択参加ではなく自動参加。提示者本人と、条件上自分自身を対象にできない色だけ除外する。
  const participants = room.players.filter(p => p.alive && p.playerId !== contract.issuerId && !(['attackTarget','accuseTarget'].includes(contract.conditionType) && contract.subjectId === p.playerId));
  contract.acceptorIds = participants.map(p => p.playerId);
  // CP確認版では、同ターン契約へ自動参加したCPだけ現在ターンの行動を再選択する。
  for (const cpu of participants.filter(isTestCpu)) cpuReplan(room, cpu);
  contract.status = 'accepted';
  return participants.length;
}

function uniqueRoomCode() {
  for (let i = 0; i < 40; i++) {
    const code = randomRoomCode();
    if (![...rooms.values()].some(r => r.code === code)) return code;
  }
  throw new Error('ルームコードの生成に失敗しました。');
}
function makeRoom({ isPublic = false, chipStake = 0 } = {}) {
  const activeRooms = [...rooms.values()].filter(r => r.status !== 'finished').length;
  if (activeRooms >= MAX_ACTIVE_ROOMS) return null;
  // 終了画面を残すTTLのせいで新規対戦が塞がらないよう、保存総数が膨らんだら古い終了部屋から掃除する。
  if (rooms.size >= MAX_STORED_ROOMS) {
    const finished = [...rooms.values()]
      .filter(r => r.status === 'finished')
      .sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0));
    for (const oldRoom of finished) {
      if (rooms.size < MAX_STORED_ROOMS) break;
      deleteRoom(oldRoom);
    }
  }
  if (rooms.size >= MAX_STORED_ROOMS) return null;
  const room = createRoom({ isPublic, code: uniqueRoomCode(), chipStake });
  rooms.set(room.id, room);
  return room;
}
function findPublicWaitingRoom(chipStake = 0) {
  return [...rooms.values()]
    .filter(r => r.isPublic && r.status === 'lobby' && Number(r.chipStake || 0) === Number(chipStake || 0) && r.players.length < MAX_PLAYERS && r.players.every(p => p.connected))
    .sort((a, b) => b.players.length - a.players.length || a.createdAt - b.createdAt)[0] || null;
}

function normalizeExchangeCard(room, owner, type, special, { requireOwned = true } = {}) {
  const key = cleanText(type, 32);
  if (!key) return null;
  const isSpecial = special === true;
  const defs = isSpecial ? SPECIAL_CARDS : NORMAL_CARDS;
  const bag = isSpecial ? owner.specials : owner.hand;
  if (!defs[key]) return null;
  if (requireOwned && (bag[key] || 0) <= 0) return null;
  if (!isSpecial && requireOwned && !canTransferNormalCard(room, owner, key)) return { error: 'カード指定中の最後の指定カードは交換に出せません。' };
  return { type:key, special:isSpecial, cardLabel:defs[key].label };
}
function exchangeCardView(card) {
  if (!card) return null;
  return { type:card.type, special:!!card.special, cardLabel:card.cardLabel || ((card.special ? SPECIAL_CARDS : NORMAL_CARDS)[card.type]?.label || card.type) };
}
function exchangeRequestView(room, req) {
  const from = getPlayer(room, req.fromId);
  const to = getPlayer(room, req.toId);
  return {
    requestId:req.requestId,
    turn:req.turn,
    fromId:req.fromId,
    toId:req.toId,
    fromColor:from?.color?.label || '',
    toColor:to?.color?.label || '',
    offer:{ points:Number(req.offer?.points || 0), card:exchangeCardView(req.offer?.card) },
    request:{ points:Number(req.request?.points || 0), card:exchangeCardView(req.request?.card) },
    createdAt:req.createdAt
  };
}
function pendingExchangesFor(room, playerId) {
  const pending = Array.isArray(room.exchangeRequests) ? room.exchangeRequests.filter(req => req.turn === room.turn) : [];
  return {
    incoming:pending.filter(req => req.toId === playerId).map(req => exchangeRequestView(room, req)),
    outgoing:pending.filter(req => req.fromId === playerId).map(req => exchangeRequestView(room, req))
  };
}
function removeExchangeRequest(room, requestId) {
  if (!Array.isArray(room.exchangeRequests)) room.exchangeRequests = [];
  const index = room.exchangeRequests.findIndex(req => req.requestId === requestId);
  if (index < 0) return null;
  return room.exchangeRequests.splice(index, 1)[0] || null;
}
function refundExchangeOffer(room, req) {
  const from = req && getPlayer(room, req.fromId);
  if (!from) return;
  from.points += Number(req.offer?.points || 0);
  const card = req.offer?.card;
  if (card) {
    const bag = card.special ? from.specials : from.hand;
    bag[card.type] = (bag[card.type] || 0) + 1;
  }
}
function expirePendingExchanges(room) {
  if (!Array.isArray(room.exchangeRequests) || room.exchangeRequests.length === 0) return;
  const expired = room.exchangeRequests.splice(0);
  for (const req of expired) {
    refundExchangeOffer(room, req);
    const from = getPlayer(room, req.fromId);
    const to = getPlayer(room, req.toId);
    if (from && to) {
      log(room, `${to.color.label}が未回答のため、${from.color.label}の交換提案はターン終了で自動キャンセルされました。`, [from.playerId, to.playerId]);
      emitGameNotice(room, [from.playerId, to.playerId], { kind:'exchange', toolTarget:'transfer', text:`交換提案はターン終了で自動キャンセルされました。` });
    }
  }
}
function bundleHasAsset(bundle) { return Number(bundle?.points || 0) > 0 || !!bundle?.card; }
function bundleLabel(bundle) {
  const parts = [];
  if (Number(bundle?.points || 0) > 0) parts.push(`${Number(bundle.points)}P`);
  if (bundle?.card) parts.push(`「${bundle.card.cardLabel || ((bundle.card.special ? SPECIAL_CARDS : NORMAL_CARDS)[bundle.card.type]?.label || bundle.card.type)}」1枚`);
  return parts.join('＋') || 'なし';
}
function takeCardForExchange(room, player, card) {
  if (!card) return { ok:true };
  const normalized = normalizeExchangeCard(room, player, card.type, card.special, { requireOwned:true });
  if (!normalized) return { ok:false, message:'交換に出すカードを所持していません。' };
  if (normalized.error) return { ok:false, message:normalized.error };
  const bag = normalized.special ? player.specials : player.hand;
  bag[normalized.type]--;
  if (!normalized.special && player.draft.normal === normalized.type && bag[normalized.type] <= 0) {
    player.draft.normal = null; player.draft.normalTargetId = null; player.draft.secondNormalTargetId = null; player.draft.accusationGuess = null; player.draft.secondAccusationGuess = null;
    if (player.draft.special === 'double') player.draft.special = null;
  }
  if (normalized.special && player.draft.special === normalized.type && bag[normalized.type] <= 0) {
    player.draft.special = null; player.draft.specialTargetId = null; player.draft.specifiedType = null; player.draft.specifiedTargetId = null; player.draft.secondNormalTargetId = null; player.draft.secondAccusationGuess = null;
  }
  return { ok:true, card:normalized };
}
function giveExchangeCard(player, card) {
  if (!player || !card) return;
  const bag = card.special ? player.specials : player.hand;
  bag[card.type] = (bag[card.type] || 0) + 1;
}
function playerHasPendingDeal(room, playerId) {
  return Array.isArray(room.exchangeRequests) && room.exchangeRequests.some(req => req.turn === room.turn && (req.fromId === playerId || req.toId === playerId));
}

function publicContractView(room, contract) {
  const issuer = getPlayer(room, contract.issuerId);
  const subject = contract.subjectId ? getPlayer(room, contract.subjectId) : null;
  const reward = Number(contract.reward || 0);
  const targetColor = ['dontAttackIssuer', 'defendIssuer'].includes(contract.conditionType)
    ? (issuer?.color?.label || '')
    : (subject?.color?.label || '');
  // 提示者ID・提示者色・参加者ID/色はクライアントへ配信しない。
  return {
    contractId:contract.contractId,
    createdTurn:contract.createdTurn,
    dueTurn:contract.dueTurn,
    conditionType:contract.conditionType,
    targetColor,
    rewardPerPlayer:contractRewardPerPlayer(reward, contract.dueTurn === MAX_TURNS ? 2 : 1),
    rewardMultiplier:contract.dueTurn === MAX_TURNS ? 2 : 1,
    status:contract.status
  };
}
function activePublicContracts(room) {
  if (!Array.isArray(room.publicContracts)) room.publicContracts = [];
  return room.publicContracts.filter(c => ['open','accepted'].includes(c.status)).map(c => publicContractView(room, c));
}
function refundPublicContract(room, contract, amount = null) {
  const issuer = contract && getPlayer(room, contract.issuerId);
  const value = amount == null ? Number(contract?.reward || 0) : Number(amount || 0);
  if (issuer && value > 0) issuer.points += value;
}
function expireOpenPublicContracts(room) {
  if (!Array.isArray(room.publicContracts)) return;
  for (const contract of room.publicContracts) {
    if (contract.status !== 'open' || contract.createdTurn !== room.turn) continue;
    // 旧状態や再接続復元でopenが残っていても、自動参加へ正規化する。
    const count = autoEnrollPublicContract(room, contract);
    if (count > 0) continue;
    contract.status = 'expired';
    refundPublicContract(room, contract);
    const perPlayer = contractRewardPerPlayer(contract.reward, contract.dueTurn === MAX_TURNS ? 2 : 1);
    log(room, `公開契約は参加対象者なしで終了し、使用Pを提示者へ返却しました（報酬1人${perPlayer}P）。`);
    emitGameNotice(room, room.players.map(x => x.playerId), { kind:'contract', toolTarget:'contractBox', text:`公開契約は参加対象者なしで終了 / 報酬1人${perPlayer}P / 使用P返却` });
  }
}
function settleDuePublicContracts(room, result) {
  if (!Array.isArray(room.publicContracts)) return;
  const actions = room.lastEffectiveActions?.turn === room.turn
    ? room.lastEffectiveActions
    : { attacksByPlayer:{}, defensesByPlayer:{}, accusationsByPlayer:{} };
  for (const contract of room.publicContracts) {
    if (contract.status !== 'accepted' || contract.dueTurn !== room.turn) continue;
    const issuer = getPlayer(room, contract.issuerId);
    const acceptorIds = Array.isArray(contract.acceptorIds) ? contract.acceptorIds : [];
    const rewardMultiplier = contract.dueTurn === MAX_TURNS ? 2 : 1;
    const perPlayer = contractRewardPerPlayer(contract.reward, rewardMultiplier);
    const subject = contract.subjectId ? getPlayer(room, contract.subjectId) : null;
    const aliveAtTurnStart = player => !!player && !(player.stats?.eliminatedTurn && player.stats.eliminatedTurn < room.turn);
    const relevantPlayer = contract.conditionType === 'attackTarget' ? subject
      : ['dontAttackIssuer', 'defendIssuer'].includes(contract.conditionType) ? issuer
      : null;
    if (relevantPlayer && !aliveAtTurnStart(relevantPlayer)) {
      contract.status = 'cancelled';
      refundPublicContract(room, contract);
      const color = relevantPlayer?.color?.label || (contract.conditionType === 'attackTarget' || contract.conditionType === 'accuseTarget' ? '指定色' : '提示色');
      const text = `公開契約は${color}が判定ターン開始前に脱落済みのため取消し、使用Pを契約提示者へ返却しました。`;
      result.publicEvents.push({ type:'contract', text });
      emitGameNotice(room, room.players.map(x => x.playerId), { kind:'contract', toolTarget:'contractBox', text });
      continue;
    }
    let payoutTotal = 0;
    let successCount = 0;
    for (const playerId of acceptorIds) {
      const acceptor = getPlayer(room, playerId);
      const attacks = new Set(actions.attacksByPlayer?.[playerId] || []);
      const defenses = new Set(actions.defensesByPlayer?.[playerId] || []);
      const accusations = new Set(actions.accusationsByPlayer?.[playerId] || []);
      const wasAliveAtTurnStart = !!acceptor && !(acceptor.stats?.eliminatedTurn && acceptor.stats.eliminatedTurn < room.turn);
      let success = false;
      if (wasAliveAtTurnStart && contract.conditionType === 'attackTarget') success = attacks.has(contract.subjectId);
      if (wasAliveAtTurnStart && contract.conditionType === 'dontAttackIssuer') success = !attacks.has(contract.issuerId);
      if (wasAliveAtTurnStart && contract.conditionType === 'defendIssuer') success = defenses.has(contract.issuerId);
      if (wasAliveAtTurnStart && contract.conditionType === 'accuseTarget') success = accusations.has(contract.subjectId);
      if (success && acceptor) {
        acceptor.points += perPlayer;
        payoutTotal += perPlayer;
        successCount++;
      }
    }
    const settlement = contractSettlement(contract.reward, successCount, rewardMultiplier);
    const refund = settlement.refund;
    if (refund > 0) refundPublicContract(room, contract, refund);
    contract.status = successCount > 0 ? 'completed' : 'failed';
    const text = successCount > 0
      ? `公開契約結果：達成者${successCount}人。報酬は1人${perPlayer}P。未配布分は契約提示者へ返却しました。`
      : `公開契約結果：達成者なし。使用Pは契約提示者へ返却しました。`;
    result.publicEvents.push({ type:'contract', text });
    emitGameNotice(room, room.players.map(x => x.playerId), {
      kind:'contract',
      toolTarget:'contractBox',
      text: successCount > 0
        ? `公開契約結果：達成者${successCount}人 / 報酬1人${perPlayer}P / 未配布分は契約提示者へ返却`
        : `公開契約結果：達成者なし / 使用Pは契約提示者へ返却`
    });
  }
}

function refundOutstandingPublicContracts(room) {
  if (!Array.isArray(room.publicContracts)) return;
  for (const contract of room.publicContracts) {
    if (!['open','accepted'].includes(contract.status)) continue;
    contract.status = 'cancelled';
    refundPublicContract(room, contract);
    const issuer = getPlayer(room, contract.issuerId);
    if (issuer) log(room, `試合終了のため${issuer.color.label}の未決済公開契約を取消し、使用Pを返却しました。`);
  }
}

function publicPlayerView(p) {
  // 同時行動の心理戦を壊さないよう、他人が準備/確定した個人情報は公開しない。
  return {
    playerId: p.playerId,
    color: p.color,
    alive: p.alive,
    connected: p.connected,
    isCpu: p.isCpu === true,
    // 告発成功は全体公開情報。成功済み対象を次回以降の候補から外すため公開する。
    accusationResolved: !!p.secretState?.invalid
  };
}
function selfView(p, room) {
  const forcedConflict = !!(p.forcedNormalType?.turn === room.turn && p.forcedNormalType.conflict);
  const forcedUnavailable = !!(p.forcedNormalType?.turn === room.turn && !forcedConflict && (p.hand[p.forcedNormalType.type] || 0) <= 0);
  return {
    playerId: p.playerId,
    color: p.color,
    hp: p.hp,
    maxHp: p.maxHp,
    points: p.points,
    chips: Number(p.chips || 0),
    chipStake: Number(p.chipStake || room.chipStake || 0),
    chipPayout: p.chipPayout ? { ...p.chipPayout } : null,
    chipLastGrantDate: p.chipLastGrantDate || null,
    currentStanding: room.status === 'playing' && room.turn >= 10 ? currentPointsStanding(room, p.playerId) : null,
    alive: p.alive,
    connected: p.connected,
    ready: p.ready,
    resultReady: !!p.resultReady,
    afkStreak: p.afkStreak || 0,
    hand: { ...p.hand },
    specials: { ...p.specials },
    specialPurchased: p.specialPurchased,
    normalPurchasedThisTurn: p.normalPurchasedTurn === room.turn,
    objective: p.objective,
    objectiveState: {
      achieved: p.secretState.achieved,
      invalid: p.secretState.invalid
    },
    draft: { ...p.draft },
    forcedNormalType: p.forcedNormalType ? {
      turn: p.forcedNormalType.turn,
      type: p.forcedNormalType.type,
      targetId: p.forcedNormalType.targetId || null,
      conflict: !!p.forcedNormalType.conflict
    } : null,
    forcedUnavailable,
    forcedConflict,
    scoutReports: p.scoutReports.slice(-30),
    winnerBet: p.winnerBet ? { ...p.winnerBet } : null,
    exchanges: pendingExchangesFor(room, p.playerId),
    stats: {
      kills: p.stats.soloKills + p.stats.jointKills,
      accusations: p.stats.successfulAccusations,
      survivedTurns: p.stats.survivedTurns
    }
  };
}
function signedDelta(value) {
  const n = Number(value || 0);
  if (n > 0) return `+${n}`;
  if (n < 0) return `${n}`;
  return '±0';
}
function buildPlayerTurnResult(room, playerId, turnSnapshot, result) {
  const p = getPlayer(room, playerId);
  const before = turnSnapshot?.find(x => x.playerId === playerId)?.data;
  if (!p || !before) return { items: [] };

  const items = [];
  const forced = before.forcedNormalType?.turn === room.turn ? before.forcedNormalType : null;
  let normal = before.draft?.normal || null;
  if (forced?.conflict) normal = null;
  else if (forced?.type && Number(before.hand?.[forced.type] || 0) > 0) normal = forced.type;

  const ownPrivate = (result.privateEvents || []).filter(e => e.to === playerId);
  // カード指定による成功得点が指定者へ移っても、実際に行動した本人の成功/失敗表示は正しく判定する。
  // 逆に、他人の指定成功で受け取った得点だけで自分の通常行動を成功扱いにはしない。
  const hasOwnActionScoreReason = reason => (result.scoreEvents || []).some(e =>
    e.reason === reason && (e.sourcePlayerId === playerId || (e.playerId === playerId && !e.viaCardSpecify))
  );

  if (normal && NORMAL_CARDS[normal]) {
    let success = false;
    if (normal === 'attack') success = hasOwnActionScoreReason('攻撃成功');
    else if (normal === 'defense') success = hasOwnActionScoreReason('防御成功');
    else if (normal === 'scout') success = ownPrivate.some(e => e.type === 'scout' && e.report);
    else if (normal === 'accusation') success = hasOwnActionScoreReason('告発成功');
    else if (normal === 'heal') {
      success = ownPrivate.some(e => {
        const text = String(e.text || '');
        const m = text.match(/HPを(\d+)回復しました。$/);
        return m && Number(m[1]) > 0;
      });
    }
    items.push(`${NORMAL_CARDS[normal].label}${success ? '成功' : '失敗'}`);
  }

  for (const e of ownPrivate) {
    if (e.type !== 'specialResult' || !['fullDefense','specify','steal'].includes(e.special)) continue;
    const label = SPECIAL_CARDS[e.special]?.label || e.special;
    items.push(`${label}${e.success ? '成功' : '失敗'}`);
  }

  for (const e of ownPrivate) {
    if (e.type !== 'scout' || !e.report) continue;
    const hand = Object.entries(NORMAL_CARDS)
      .map(([key, def]) => `${def.label}${Number(e.report.hand?.[key] || 0)}枚`)
      .join(' / ');
    items.push(`偵察結果：${e.report.color}｜HP${e.report.hp}｜キル${e.report.kills}｜${hand}`);
  }

  const hpDelta = Number(p.hp || 0) - Number(before.hp || 0);
  const pointDelta = Number(p.points || 0) - Number(before.points || 0);
  items.push(`HP${signedDelta(hpDelta)}　ポイント${signedDelta(pointDelta)}`);
  return { items };
}
function turnHistoryPlayerLabel(room, playerId) {
  return getPlayer(room, playerId)?.color?.label || '不明';
}
function buildTurnHistoryEntry(room, turnSnapshot, result, playerResults) {
  const snapshotById = new Map((turnSnapshot || []).map(item => [item.playerId, item.data]));
  const canceledIds = new Set();
  for (const [playerId, before] of snapshotById.entries()) {
    if (!before?.alive) continue;
    const special = before.draft?.special || null;
    const targetId = before.draft?.specialTargetId || null;
    if (special === 'cancel' && targetId && targetId !== playerId && getPlayer(room, targetId)) canceledIds.add(targetId);
  }
  const rows = [];
  for (const p of room.players) {
    const before = snapshotById.get(p.playerId);
    if (!before) continue;
    if (!before.alive) {
      rows.push({ playerId:p.playerId, color:p.color?.label || '', action:'脱落済み', results:['このターンは行動できません'] });
      continue;
    }
    const forced = before.forcedNormalType?.turn === room.turn ? before.forcedNormalType : null;
    let normal = before.draft?.normal || null;
    let forcedText = '';
    if (forced?.conflict) {
      normal = null;
      forcedText = 'カード指定競合により通常行動なし';
    } else if (forced?.type && Number(before.hand?.[forced.type] || 0) > 0) {
      normal = forced.type;
      forcedText = 'カード指定による強制行動';
    }
    const d = before.draft || {};
    const actionParts = [];
    const labelTarget = id => id ? turnHistoryPlayerLabel(room, id) : '対象なし';
    if (normal && NORMAL_CARDS[normal]) {
      const label = NORMAL_CARDS[normal].label;
      if (normal === 'accusation') {
        const guess = OBJECTIVES.find(o => o.key === d.accusationGuess)?.label || '未選択';
        actionParts.push(`${label} → ${labelTarget(forced?.targetId || d.normalTargetId)}（予想：${guess}）`);
        if (d.special === 'double' && d.secondNormalTargetId) {
          const secondGuess = OBJECTIVES.find(o => o.key === d.secondAccusationGuess)?.label || '未選択';
          actionParts.push(`${label}2回目 → ${labelTarget(d.secondNormalTargetId)}（予想：${secondGuess}）`);
        }
      } else {
        const primaryTargetId = forced?.targetId || d.normalTargetId;
        actionParts.push(`${label} → ${labelTarget(primaryTargetId)}`);
        if (d.special === 'double' && ['attack','scout'].includes(normal)) {
          actionParts.push(`${label}2回目 → ${labelTarget(d.secondNormalTargetId || primaryTargetId)}`);
        }
      }
    }
    if (forcedText) actionParts.push(forcedText);
    const special = d.special || null;
    if (special && SPECIAL_CARDS[special]) {
      if (special === 'fullDefense') actionParts.push('特殊：完全防御');
      else if (special === 'cancel') actionParts.push(`特殊：無効 → ${labelTarget(d.specialTargetId)}`);
      else if (special === 'steal') actionParts.push(`特殊：ポイント泥棒 → ${labelTarget(d.specialTargetId)}（${Number(d.stealAmount || 0)}P）`);
      else if (special === 'specify') {
        const specifiedLabel = NORMAL_CARDS[d.specifiedType]?.label || '未選択';
        actionParts.push(`特殊：カード指定 → ${labelTarget(d.specialTargetId)}（${specifiedLabel}を${labelTarget(d.specifiedTargetId)}へ）`);
      } else if (special === 'double') actionParts.push('特殊：2倍カード');
    }
    if (!actionParts.length) actionParts.push('行動なし');
    const results = [];
    if (canceledIds.has(p.playerId)) results.push('無効カードにより行動無効');
    for (const text of playerResults?.[p.playerId]?.items || []) results.push(String(text));
    rows.push({ playerId:p.playerId, color:p.color?.label || '', action:actionParts.join(' / '), results });
  }
  return {
    turn: room.turn,
    players: rows,
    events: (result?.publicEvents || []).map(event => String(event?.text || '')).filter(Boolean)
  };
}

function resultView(room, playerId) {
  const r = room.lastResult;
  if (!r) return null;
  const own = r.playerResults?.[playerId] || { items: [] };
  return { turn: r.turn, items: Array.isArray(own.items) ? own.items : [] };
}

function snapshot(room, playerId, { includeHistory = false, includeCatalog = true } = {}) {
  // 対戦中の本人用秘密目標は必須。まれな状態欠損・再接続時も空欄を配信しない。
  ensureSecretObjectives(room);
  const p = getPlayer(room, playerId);
  const data = {
    gameName: '五疑戦',
    serverNow: now(),
    roomId: room.id,
    code: room.code,
    isPublic: room.isPublic,
    chipStake: Number(room.chipStake || 0),
    chipPot: Number(room.chipPot || 0),
    status: room.status,
    turn: room.turn,
    maxTurns: MAX_TURNS,
    phase: room.phase,
    phaseEndsAt: room.phaseEndsAt,
    phaseSeq: room.phaseSeq,
    chatSeconds: CHAT_SECONDS,
    resultSeconds: RESULT_SECONDS,
    players: room.players.map(publicPlayerView),
    phaseProgress: {
      alive: getAlive(room).length,
      ready: getAlive(room).filter(x => x.ready).length,
      resultReady: resultVoters(room).filter(x => x.resultReady).length,
      resultVoters: resultVoters(room).length
    },
    me: p ? selfView(p, room) : null,
    resumeToken: p?.sessionToken || null,
    publicContracts: activePublicContracts(room),
    preBetRanking: room.preBetRanking,
    winnerBetResults: Array.isArray(room.winnerBetResults) ? (room.status === 'finished' ? room.winnerBetResults.map(x => ({ ...x })) : (p ? room.winnerBetResults.filter(x => x.playerId === p.playerId) : [])) : [],
    chipSettlement: room.status === 'finished' && room.chipSettlement ? JSON.parse(JSON.stringify(room.chipSettlement)) : null,
    turnHistory: room.status === 'finished' ? JSON.parse(JSON.stringify(room.turnHistory || [])) : [],
    finishedRanking: room.finishedRanking,
    lastResult: p ? resultView(room, p.playerId) : null
  };
  // カード定義・秘密目標一覧・得点表は対戦中に変化しないため、同じSocketへ毎回再送しない。
  // 初回stateだけ送ってクライアント側で保持し、準備/確定など高頻度stateの帯域を削減する。
  if (includeCatalog) {
    data.normalCards = NORMAL_CARDS;
    data.specialCards = SPECIAL_CARDS;
    data.objectives = OBJECTIVES;
    data.rules = { scoring: SCORING, stealAmounts: STEAL_AMOUNTS, secretReward: SECRET_REWARD, specialPurchasePrice: SPECIAL_PURCHASE_PRICE, turnStartBonuses: TURN_START_BONUSES, winnerBet: WINNER_BET, gogiChips: GOGI_CHIPS };
  }
  if (includeHistory) {
    // 対戦ログはクライアントへ返さない。再接続時に復元するのは本人が見られるチャットだけ。
    data.chat = p ? visibleChat(room, p.playerId) : [];
  }
  return data;
}
function emitSnapshot(room, p, { includeHistory = false } = {}) {
  if (!p?.connected || !p.socketId) return;
  const liveSocket = io.sockets.sockets.get(p.socketId);
  const includeCatalog = !liveSocket?.data?.catalogSent;
  io.to(p.socketId).emit('state', snapshot(room, p.playerId, { includeHistory, includeCatalog }));
  if (liveSocket && includeCatalog) liveSocket.data.catalogSent = true;
}
function emitLobbyStatus(room) {
  if (!room) return;
  io.to(room.id).emit('lobbyStatus', {
    roomId: room.id,
    code: room.code,
    isPublic: !!room.isPublic,
    status: room.status,
    count: room.players.length,
    chipStake: Number(room.chipStake || 0),
    serverNow: now()
  });
}
function emitState(room, { includeHistoryFor = null } = {}) {
  for (const p of room.players) {
    if (p.connected && p.socketId) {
      const includeHistory = !!includeHistoryFor?.has?.(p.playerId);
      emitSnapshot(room, p, { includeHistory });
    }
  }
  // 待機人数は個別snapshotとは別の軽量イベントでも全Socketへ通知する。
  // これにより一方のstate ACKが欠落しても1/5のまま止まらない。
  if (room.status === 'lobby') emitLobbyStatus(room);
}
function emitPlayerState(room, p, { includeHistory = false } = {}) {
  emitSnapshot(room, p, { includeHistory });
}
function emitPrivateEvent(room, playerId, event) {
  const p = getPlayer(room, playerId);
  if (p?.connected && p.socketId) io.to(p.socketId).emit('privateEvent', event);
}
function emitGameNotice(room, targets, notice) {
  const payload = { kind:cleanText(notice?.kind || 'notice', 24), text:cleanText(notice?.text || '', 220), toolTarget:cleanText(notice?.toolTarget || '', 40) };
  if (!payload.text) return;
  const ids = Array.isArray(targets) ? [...new Set(targets)] : room.players.map(p => p.playerId);
  for (const playerId of ids) {
    const p = getPlayer(room, playerId);
    if (p?.connected && p.socketId) io.to(p.socketId).emit('gameNotice', payload);
  }
}
function phaseSeqMatches(room, p, supplied) {
  if (Number(supplied) === room.phaseSeq) return true;
  emitPlayerState(room, p);
  return false;
}
function advanceExpiredPhase(room) {
  if (!room || room.status !== 'playing' || !Number.isFinite(room.phaseEndsAt) || now() < room.phaseEndsAt) return false;
  if (room.phase === 'chat') {
    resolveAndShowResult(room);
    return true;
  }
  if (room.phase === 'result') {
    advanceFromResult(room);
    return true;
  }
  return false;
}
function phaseAcceptsMutation(room, expectedPhase) {
  if (!room || room.status !== 'playing' || room.phase !== expectedPhase) return false;
  if (Number.isFinite(room.phaseEndsAt) && now() >= room.phaseEndsAt) {
    advanceExpiredPhase(room);
    return false;
  }
  return true;
}

function setPhase(room, phase, seconds, onTimeout) {
  clearRoomTimer(room);
  room.phase = phase;
  room.phaseSeq++;
  const seq = room.phaseSeq;
  room.phaseEndsAt = now() + seconds * 1000;
  emitState(room);
  room.timer = setTimeout(() => {
    if (room.phaseSeq !== seq || room.phase !== phase || room.status !== 'playing') return;
    onTimeout();
  }, seconds * 1000 + 40);
}

function markTurnActivity(room, p) {
  if (!room || !p || room.status !== 'playing' || !p.alive) return;
  p.turnHadManualInput = true;
}

function applyAfkPolicy(room, result) {
  for (const p of room.players) {
    if (!p.alive) continue;
    if (p.turnHadManualInput) {
      p.afkStreak = 0;
      continue;
    }

    p.afkStreak = (p.afkStreak || 0) + 1;
    if (p.afkStreak === 2) {
      result.privateEvents.push({
        to: p.playerId,
        type: 'afkWarning',
        text: '2ターン連続で操作がありません。次のターンも無操作の場合は脱落します。'
      });
      continue;
    }

    if (p.afkStreak >= 3) {
      // このターンをAFK脱落として扱うため、生存ターン数は加算しない。
      if (p.stats?.survivedTurns > 0) p.stats.survivedTurns--;


      p.hp = 0;
      p.alive = false;
      p.stats.eliminatedTurn = room.turn;
      p.ready = true;
      result.publicEvents.push({
        type: 'afkElimination',
        text: `${p.color?.label || 'プレイヤー'}は3ターン連続で操作がなかったため脱落しました。`
      });
      result.privateEvents.push({
        to: p.playerId,
        type: 'afkElimination',
        text: '3ターン連続で操作がなかったため脱落しました。'
      });
    }
  }
}
function beginChat(room) {
  if (room.status !== 'playing') return;
  // 前ターンのresult状態から入る場合も、CPの1位予想・購入など内部操作を行えるよう先にchatへ切り替える。
  // phaseSeq/timer/配信は後段のsetPhaseで正式更新する。
  room.phase = 'chat';
  // 全員脱落済みなら操作できる人がいないため即終了する。
  // ターン番号を人工的に15へ進めると、第15ターン限定目標や2倍得点を誤発火させるため行わない。
  if (getAlive(room).length === 0) {
    log(room, '全プレイヤーが脱落したため試合を終了します。');
    finishGame(room);
    return;
  }
  const turnStartEvents = awardTurnStartBonus(room);
  if (turnStartEvents.length) {
    const amount = turnStartEvents[0].actual;
    log(room, `第${room.turn}ターン開始ボーナス：生存者に+${amount}P`);
  }
  for (const p of room.players) {
    p.ready = !p.alive || p.autoAdvance;
    p.resultReady = false;
    p.autoReadySeq = null;
    p.turnHadManualInput = false;
    p.draft = {
      normal: null, special: null,
      normalTargetId: null, secondNormalTargetId: null, specialTargetId: null,
      accusationGuess: null, secondAccusationGuess: null,
      stealAmount: 5, specifiedType: null, specifiedTargetId: null
    };
  }
  // CPも人間と同じゲーム機能を使う。チャットだけは自動送信しない。
  // 前ターンの自分自身の結果を学習し、同じ失敗を機械的に繰り返さない。
  cpuLearnFromLastTurn(room);
  maybePlaceCpuWinnerBets(room);
  maybeRunCpuPurchases(room);
  maybeCreateCpuExchanges(room);
  maybePostCpuPublicContracts(room);
  for (const p of room.players) {
    if (!p.alive || !isTestCpu(p)) continue;
    p.draft = buildTestCpuDraft(room, p);
    p.ready = true;
    p.turnHadManualInput = true;
  }
  log(room, `ターン${room.turn}：会話・行動選択開始（最大${CHAT_SECONDS}秒）`);
  setPhase(room, 'chat', CHAT_SECONDS, () => resolveAndShowResult(room));
  for (const p of room.players) if (p.alive && p.autoAdvance && p.ready) p.autoReadySeq = room.phaseSeq;
  if (allAliveReady(room)) resolveAndShowResult(room);
}
function captureTurnState(room) {
  const fields = ['hp','maxHp','points','alive','hand','specials','specialPurchased','normalPurchasedTurn','secretState','draft','ready','forcedNormalType','scoutReports','stats'];
  return room.players.map(p => ({
    playerId: p.playerId,
    data: Object.fromEntries(fields.map(key => [key, structuredClone(p[key])]))
  }));
}
function restoreTurnState(room, snapshot) {
  for (const item of snapshot) {
    const p = getPlayer(room, item.playerId);
    if (!p) continue;
    for (const [key, value] of Object.entries(item.data)) p[key] = structuredClone(value);
  }
}

function resolveAndShowResult(room) {
  if (room.status !== 'playing' || room.phase !== 'chat') return;
  clearRoomTimer(room);
  // 未回答の交換提案はターン終了時に自動キャンセル。
  // 未成立の公開契約も当該ターン終了時に失効し、預けた報酬を返却する。
  expirePendingExchanges(room);
  expireOpenPublicContracts(room);
  room.lastEffectiveActions = null;
  const turnSnapshot = captureTurnState(room);
  let result;
  try {
    result = resolveTurn(room);
  } catch (error) {
    console.error('resolveTurn failed', error);
    restoreTurnState(room, turnSnapshot);
    const text = 'システムエラーにより、このターンの行動はすべて無効として処理しました。';
    log(room, text);
    result = { privateEvents: [], publicEvents: [{ type: 'system', text }], scoreEvents: [] };
  }

  // 前ターンに成立した公開契約は、このターンの実際の有効攻撃結果で自動判定する。
  settleDuePublicContracts(room, result);

  // 2ターン連続無操作で警告、3ターン連続無操作で脱落。
  // 第15ターンの生存ボーナス判定より先に適用し、AFK脱落者へ生存+50Pを付与しない。
  applyAfkPolicy(room, result);

  // AFK脱落も通常脱落と同様、何ターン目でも未使用系秘密目標をその場で判定する。
  const afkAchieved = evaluateObjectives(room, result.scoreEvents);
  for (const pid of afkAchieved) {
    const p = getPlayer(room, pid);
    result.privateEvents.push({ to: pid, type: 'notice', text: `秘密目標「${p.objective.label}」を達成しました。` });
  }

  // 第15ターンの結果画面時点で、生存ボーナス+50Pを固定付与する（最終ターン2倍の対象外）。
  if (room.turn >= MAX_TURNS) {
    const survivalEvents = awardSurvivalBonus(room);
    result.scoreEvents.push(...survivalEvents);
  }
  const playerResults = Object.fromEntries(room.players.map(p => [p.playerId, buildPlayerTurnResult(room, p.playerId, turnSnapshot, result)]));
  if (!Array.isArray(room.turnHistory)) room.turnHistory = [];
  room.turnHistory.push(buildTurnHistoryEntry(room, turnSnapshot, result, playerResults));
  if (room.turnHistory.length > MAX_TURNS) room.turnHistory = room.turnHistory.slice(-MAX_TURNS);
  room.lastResult = { turn: room.turn, publicEvents: result.publicEvents, privateEvents: result.privateEvents, scoreEvents: result.scoreEvents, playerResults };
  for (const e of result.publicEvents) log(room, e.text);
  for (const e of result.privateEvents) {
    // 偵察はscoutReportsと結果サマリーに残るため、意味のない「個別結果」ログを作らない。
    if (e.text) log(room, e.text, [e.to]);
    emitPrivateEvent(room, e.to, e);
  }
  for (const p of room.players) p.resultReady = !p.connected;
  room.phase = 'result';
  room.phaseSeq++;
  const seq = room.phaseSeq;
  room.phaseEndsAt = now() + RESULT_SECONDS * 1000;
  emitState(room);
  room.timer = setTimeout(() => {
    if (room.phaseSeq !== seq || room.status !== 'playing' || room.phase !== 'result') return;
    advanceFromResult(room);
  }, RESULT_SECONDS * 1000 + 40);
  if (allResultReady(room)) queueMicrotask(() => {
    if (room.phaseSeq === seq && room.phase === 'result') advanceFromResult(room);
  });
}
function advanceFromResult(room) {
  if (room.status !== 'playing' || room.phase !== 'result') return;
  clearRoomTimer(room);
  if (room.turn >= MAX_TURNS || getAlive(room).length === 0) return finishGame(room);
  room.turn++;
  beginChat(room);
}
function finishGame(room) {
  if (room.status !== 'playing') return;
  clearRoomTimer(room);
  refundOutstandingPublicContracts(room);
  awardSurvivalBonus(room);
  // 1位予想は払戻し前順位を正解判定に使う。払戻し後に順位を再計算するため、順位発表は2段階になる。
  room.preBetRanking = buildRanking(room);
  room.winnerBetResults = settleWinnerBets(room, room.preBetRanking);
  room.finishedRanking = buildRanking(room);
  room.chipSettlement = settleChipWager(room);
  room.status = 'finished';
  room.phase = 'finished';
  room.phaseEndsAt = null;
  room.phaseSeq++;
  room.finishedAt = now();
  log(room, 'ゲーム終了。賭け判定前順位・1位予想結果・払戻し後の最終順位・五戯チップ結果を公開します。');
  emitState(room);
}
function maybeStart(room) {
  if (room.status !== 'lobby') return;
  if (room.players.length !== MAX_PLAYERS) return;
  // 公開マッチは、切断中の待機枠を含めて開始しない。
  // プライベートルームは「5人参加済み」を開始条件にする。
  // スマホの一瞬のSocket再接続/バックグラウンド遷移で connected=false が混ざっても、
  // 5人揃っているのに開始不能になる競合を防ぐ。切断中の参加者は既存のresume/AFK処理で復帰・進行できる。
  if (room.isPublic && !room.players.every(p => p.connected || isTestCpu(p))) return;
  try {
    startGame(room);
    log(room, 'ゲーム開始。ポイントと秘密目標は本人以外には非公開です。');
    beginChat(room);
  } catch (error) {
    console.error('startGame failed', error);
  }
}

function normalizeClientInstanceId(value) {
  const id = cleanText(value, 96);
  return /^[A-Za-z0-9_-]{8,96}$/.test(id) ? id : null;
}
function normalizePageInstanceId(value) {
  const id = cleanText(value, 96);
  return /^[A-Za-z0-9_-]{8,96}$/.test(id) ? id : null;
}
function normalizeBrowserId(value) {
  const id = cleanText(value, 96);
  return /^[A-Za-z0-9_-]{12,96}$/.test(id) ? id : null;
}
function normalizeChipStake(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 1000000000000 || n % GOGI_CHIPS.stakeStep !== 0) return null;
  return n;
}
function normalizeChipBalance(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1000000000000000) return null;
  return Math.round(n * 100) / 100;
}
function browserIdInUse(browserId, exceptPlayerId = null) {
  if (!browserId) return false;
  for (const room of rooms.values()) {
    if (!['lobby', 'playing'].includes(room.status)) continue;
    if (room.players.some(p => p.playerId !== exceptPlayerId && p.browserId === browserId)) return true;
  }
  return false;
}
function removeLobbyPlayersForBrowser(browserId) {
  const normalizedBrowserId = normalizeBrowserId(browserId);
  if (!normalizedBrowserId) return 0;
  let removed = 0;
  for (const room of [...rooms.values()]) {
    if (room.status !== 'lobby') continue;
    const ids = room.players.filter(p => p.browserId === normalizedBrowserId).map(p => p.playerId);
    for (const playerId of ids) {
      const p = getPlayer(room, playerId);
      if (!p) continue;
      if (p.socketId) {
        const liveSocket = io.sockets.sockets.get(p.socketId);
        if (liveSocket) {
          liveSocket.leave(room.id);
          if (liveSocket.data.roomId === room.id && liveSocket.data.playerId === p.playerId) {
            liveSocket.data.roomId = null;
            liveSocket.data.playerId = null;
          }
        }
      }
      removePlayerRecord(room, playerId);
      removed++;
    }
    if (ids.length) {
      if (room.players.length === 0) deleteRoom(room);
      else emitState(room);
    }
  }
  return removed;
}
function findClientPlayer(clientInstanceId, browserId) {
  const instanceId = normalizeClientInstanceId(clientInstanceId);
  const normalizedBrowserId = normalizeBrowserId(browserId);
  if (!instanceId || !normalizedBrowserId) return null;
  for (const room of rooms.values()) {
    if (!['lobby', 'playing'].includes(room.status)) continue;
    const p = room.players.find(x => x.clientInstanceId === instanceId && x.browserId === normalizedBrowserId);
    if (p) return { room, p };
  }
  return null;
}
function recoverClientJoin(socket, clientInstanceId, browserId, pageInstanceId) {
  const current = socketPlayer(socket);
  if (current.room && current.p) {
    const sameClient = current.p.clientInstanceId === normalizeClientInstanceId(clientInstanceId)
      && current.p.browserId === normalizeBrowserId(browserId)
      && current.p.pageInstanceId === normalizePageInstanceId(pageInstanceId);
    if (!sameClient) return null;
    return current;
  }
  const found = findClientPlayer(clientInstanceId, browserId);
  if (!found) return null;
  // 待機室では自動復帰しない。以前の「切断＝退出」仕様へ戻す。
  // 同一タブの古い待機記録が残っていた場合もここで除去して新規参加を妨げない。
  if (found.room.status === 'lobby') {
    removeLobbyPlayer(found.room, found.p.playerId);
    return null;
  }
  try {
    bindSocketToPlayer(socket, found.room, found.p, clientInstanceId, browserId, pageInstanceId);
  } catch (error) {
    return { ...found, error };
  }
  return found;
}
function bindSocketToPlayer(socket, room, p, clientInstanceId = null, browserId = null, pageInstanceId = null) {
  const instanceId = normalizeClientInstanceId(clientInstanceId);
  const normalizedBrowserId = normalizeBrowserId(browserId);
  const normalizedPageInstanceId = normalizePageInstanceId(pageInstanceId);
  if (!instanceId || !normalizedBrowserId || !normalizedPageInstanceId) throw new Error('クライアント識別子が不正です。');
  if (p.browserId && p.browserId !== normalizedBrowserId) {
    const error = new Error('この復帰情報は別ブラウザ用です。');
    error.code = 'BROWSER_MISMATCH';
    throw error;
  }
  if (p.connected && p.pageInstanceId && p.pageInstanceId !== normalizedPageInstanceId) {
    const error = new Error('この試合は別のタブまたは端末で接続中です。');
    error.code = 'SESSION_IN_USE';
    throw error;
  }
  if (p.connected && p.clientInstanceId && p.clientInstanceId !== instanceId) {
    const error = new Error('この試合は別のタブまたは端末で接続中です。');
    error.code = 'SESSION_IN_USE';
    throw error;
  }
  if (p.disconnectTimer) clearTimeout(p.disconnectTimer);
  p.disconnectTimer = null;
  if (p.autoReadySeq === room.phaseSeq && room.phase === 'chat') p.ready = false;
  p.autoReadySeq = null;
  const oldSocketId = p.socketId;
  // 先に新Socketを正としてから旧Socketを切断する。旧disconnectイベントが
  // 誤って「切断中」に戻したり再接続タイマーを作るレースを防ぐ。
  p.socketId = socket.id;
  p.connected = true;
  p.clientInstanceId = instanceId;
  p.pageInstanceId = normalizedPageInstanceId;
  p.browserId = normalizedBrowserId;
  p.autoAdvance = false;
  socket.data.roomId = room.id;
  socket.data.playerId = p.playerId;
  socket.join(room.id);
  if (oldSocketId && oldSocketId !== socket.id) {
    const oldSocket = io.sockets.sockets.get(oldSocketId);
    if (oldSocket) oldSocket.disconnect(true);
  }
}
function registerPlayer(room, socket, clientInstanceId, browserId, pageInstanceId, chipBalance = 0) {
  if (room.players.length >= MAX_PLAYERS) throw new Error('満員です。');
  const instanceId = normalizeClientInstanceId(clientInstanceId);
  const normalizedBrowserId = normalizeBrowserId(browserId);
  const normalizedPageInstanceId = normalizePageInstanceId(pageInstanceId);
  if (!instanceId || !normalizedBrowserId || !normalizedPageInstanceId) throw new Error('クライアント識別子が不正です。');
  if (browserIdInUse(normalizedBrowserId)) {
    const error = new Error('このブラウザはすでに別の対戦に参加中です。');
    error.code = 'BROWSER_IN_USE';
    throw error;
  }
  const p = createPlayer({ socketId: null });
  p.chips = normalizeChipBalance(chipBalance) ?? 0;
  p.chipLastGrantDate = null;
  p.clientInstanceId = instanceId;
  p.pageInstanceId = normalizedPageInstanceId;
  p.browserId = normalizedBrowserId;
  room.players.push(p);
  sessionIndex.set(p.sessionToken, { roomId: room.id, playerId: p.playerId });
  try {
    bindSocketToPlayer(socket, room, p, instanceId, normalizedBrowserId, normalizedPageInstanceId);
  } catch (error) {
    room.players.pop();
    sessionIndex.delete(p.sessionToken);
    throw error;
  }
  return p;
}
function removePlayerRecord(room, playerId) {
  const idx = room.players.findIndex(p => p.playerId === playerId);
  if (idx < 0) return null;
  const [p] = room.players.splice(idx, 1);
  if (p.disconnectTimer) clearTimeout(p.disconnectTimer);
  sessionIndex.delete(p.sessionToken);
  return p;
}
function deleteRoom(room) {
  clearRoomTimer(room);
  for (const p of room.players) {
    if (p.disconnectTimer) clearTimeout(p.disconnectTimer);
    sessionIndex.delete(p.sessionToken);
    // 終了済みルームをTTL掃除する時も、Socket.IOアダプタ側のroom membershipを残さない。
    // stale membershipは長時間稼働時のメモリ増加と、極端なID再利用時の誤配信要因になる。
    if (p.socketId) {
      const liveSocket = io.sockets.sockets.get(p.socketId);
      if (liveSocket) {
        liveSocket.leave(room.id);
        if (liveSocket.data.roomId === room.id && liveSocket.data.playerId === p.playerId) {
          liveSocket.data.roomId = null;
          liveSocket.data.playerId = null;
        }
      }
    }
  }
  rooms.delete(room.id);
}
function removeLobbyPlayer(room, playerId) {
  removePlayerRecord(room, playerId);
  if (room.players.length === 0) deleteRoom(room);
  else emitState(room);
}

const rateBySocket = new WeakMap();
function consumeRateBucket(buckets, key, limit, windowMs) {
  const t = now();
  let item = buckets.get(key);
  if (!item || t - item.start >= windowMs) item = { start: t, count: 0 };
  item.count++;
  buckets.set(key, item);
  return item.count <= limit;
}
function allow(socket, key, limit, windowMs) {
  let buckets = rateBySocket.get(socket);
  if (!buckets) {
    buckets = new Map();
    rateBySocket.set(socket, buckets);
  }
  return consumeRateBucket(buckets, key, limit, windowMs);
}
function allowPlayer(p, key, limit, windowMs) {
  p._rateBuckets ||= new Map();
  return consumeRateBucket(p._rateBuckets, key, limit, windowMs);
}
function checkMutation(p, scope, opId) {
  const id = cleanText(opId, 96);
  const safeScope = cleanText(scope, 32);
  if (!/^[A-Za-z0-9_-]{8,96}$/.test(id) || !/^[A-Za-z0-9_-]{2,32}$/.test(safeScope)) {
    return { ok: false, message: '操作IDが不正です。画面を更新してください。' };
  }
  p._recentMutations ||= new Map();
  const key = `${safeScope}:${id}`;
  return { ok: true, duplicate: p._recentMutations.has(key), key };
}
function commitMutation(p, key) {
  p._recentMutations ||= new Map();
  p._recentMutations.set(key, now());
  while (p._recentMutations.size > RECENT_MUTATION_LIMIT) p._recentMutations.delete(p._recentMutations.keys().next().value);
}
function socketPlayer(socket) {
  const room = rooms.get(socket.data.roomId);
  if (!room) return { room: null, p: null };
  const p = getPlayer(room, socket.data.playerId);
  if (!p || p.socketId !== socket.id) return { room: null, p: null };
  return { room, p };
}
function validTarget(room, p, id, { aliveOnly = true, accusationOnly = false } = {}) {
  const target = getPlayer(room, id);
  if (!target || target.playerId === p.playerId) return null;
  if (aliveOnly && !target.alive) return null;
  if (accusationOnly && target.secretState?.invalid) return null;
  return target;
}

function registrationErrorPayload(error) {
  if (error?.code === 'BROWSER_IN_USE') return { ok: false, code: 'BROWSER_IN_USE', message: 'このブラウザはすでに別の対戦に参加中です。' };
  return { ok: false, message: '参加情報が不正です。画面を更新してください。' };
}
function recoveryErrorPayload(error) {
  if (error?.code === 'SESSION_IN_USE') return { ok: false, code: 'SESSION_IN_USE', message: 'この試合は別のタブで接続中です。' };
  if (error?.code === 'BROWSER_MISMATCH') return { ok: false, code: 'BROWSER_MISMATCH', message: '復帰情報がこのブラウザと一致しません。' };
  return { ok: false, message: '参加状態を復元できませんでした。' };
}


io.on('connection', socket => {
  activeSocketConnections++;
  socket.once('disconnect', () => { activeSocketConnections = Math.max(0, activeSocketConnections - 1); });

  socket.on('resume', (rawPayload = {}, cb) => {
    const { sessionToken, clientInstanceId, browserId, pageInstanceId } = objectPayload(rawPayload);
    if (!allow(socket, 'resume', 8, 10_000)) return safeCb(cb, { ok: false, message: '操作が多すぎます。' });
    const token = cleanText(sessionToken, 128);
    // ACKだけ失われて同じSocketからresumeが再送された場合は冪等に成功させる。
    // 別セッションのtokenなら従来通り拒否する。
    if (socket.data.roomId) {
      const current = socketPlayer(socket);
      if (current.room && current.p && current.p.sessionToken === token) {
        emitPlayerState(current.room, current.p, { includeHistory: true });
        return safeCb(cb, { ok: true, duplicate: true, sessionToken: current.p.sessionToken });
      }
      return safeCb(cb, { ok: false, message: 'すでに参加中です。' });
    }
    const ref = sessionIndex.get(token);
    if (!ref) return safeCb(cb, { ok: false, message: '復帰できる試合がありません。' });
    const room = rooms.get(ref.roomId);
    const p = room && getPlayer(room, ref.playerId);
    if (!room || !p || p.sessionToken !== token) return safeCb(cb, { ok: false, message: '復帰情報が無効です。' });
    // 待機室の再接続・自動復帰は廃止。切断した待機者は完全退出として扱う。
    if (room.status === 'lobby') {
      removeLobbyPlayer(room, p.playerId);
      return safeCb(cb, { ok: false, code: 'LOBBY_RESUME_DISABLED', message: '待機状態は終了しました。もう一度参加してください。' });
    }
    if (!allowPlayer(p, 'resume', 8, 10_000)) return safeCb(cb, { ok: false, message: '再接続が多すぎます。少し待ってください。' });
    try {
      bindSocketToPlayer(socket, room, p, clientInstanceId, browserId, pageInstanceId);
    } catch (error) {
      const message = error?.code === 'SESSION_IN_USE'
        ? 'この試合は別のタブまたは端末で接続中です。そちらを閉じてから再接続してください。'
        : '復帰情報が不正です。';
      return safeCb(cb, { ok: false, code: error?.code || 'INVALID_CLIENT_INSTANCE', message });
    }
    // 終了済み試合の最終結果確認では、再接続ログを追加して履歴を汚さない。
    if (room.status !== 'finished') log(room, `${p.color?.label || 'プレイヤー'}が再接続しました。`);
    emitState(room, { includeHistoryFor: new Set([p.playerId]) });
    maybeStart(room);
    safeCb(cb, { ok: true, sessionToken: p.sessionToken });
  });

  socket.on('publicMatch', (rawPayload = {}, cb) => {
    const { clientInstanceId, browserId, pageInstanceId, chipStake, chipBalance } = objectPayload(rawPayload);
    if (!allow(socket, 'join', 4, 10_000)) return safeCb(cb, { ok: false, message: '操作が多すぎます。' });
    if (!normalizeClientInstanceId(clientInstanceId) || !normalizeBrowserId(browserId) || !normalizePageInstanceId(pageInstanceId)) return safeCb(cb, { ok: false, message: '参加情報が不正です。画面を更新してください。' });
    const stake = normalizeChipStake(chipStake);
    const balance = normalizeChipBalance(chipBalance);
    if (stake == null || balance == null) return safeCb(cb, { ok:false, message:'五戯チップ情報が不正です。' });
    if (balance < stake) return safeCb(cb, { ok:false, code:'CHIPS_SHORT', message:`五戯チップが不足しています。必要${stake} / 所持${balance}` });
    // 新規参加前に、同じブラウザへ残った古い待機枠だけを除去する。対戦中は保持する。
    removeLobbyPlayersForBrowser(browserId);
    const recovered = recoverClientJoin(socket, clientInstanceId, browserId, pageInstanceId);
    if (recovered?.error) return safeCb(cb, recoveryErrorPayload(recovered.error));
    if (recovered) {
      emitPlayerState(recovered.room, recovered.p, { includeHistory: true });
      return safeCb(cb, { ok: true, recovered: true, code: recovered.room.code, sessionToken: recovered.p.sessionToken });
    }
    if (socket.data.roomId) return safeCb(cb, { ok: false, message: 'すでに参加中です。' });
    if (browserIdInUse(normalizeBrowserId(browserId))) return safeCb(cb, { ok: false, code: 'BROWSER_IN_USE', message: 'このブラウザはすでに別の対戦に参加中です。' });
    let room = findPublicWaitingRoom(stake);
    if (!room) room = makeRoom({ isPublic: true, chipStake: stake });
    if (!room) return safeCb(cb, { ok: false, message: '現在満室です。少し待ってから再試行してください。' });
    let p;
    try { p = registerPlayer(room, socket, clientInstanceId, browserId, pageInstanceId, balance); }
    catch (error) {
      if (room.players.length === 0) deleteRoom(room);
      return safeCb(cb, registrationErrorPayload(error));
    }
    emitState(room);
    safeCb(cb, { ok: true, sessionToken: p.sessionToken });
    maybeStart(room);
  });

  socket.on('createPrivate', (rawPayload = {}, cb) => {
    const { clientInstanceId, browserId, pageInstanceId, chipStake, chipBalance } = objectPayload(rawPayload);
    if (!allow(socket, 'join', 4, 10_000)) return safeCb(cb, { ok: false, message: '操作が多すぎます。' });
    if (!normalizeClientInstanceId(clientInstanceId) || !normalizeBrowserId(browserId) || !normalizePageInstanceId(pageInstanceId)) return safeCb(cb, { ok: false, message: '参加情報が不正です。画面を更新してください。' });
    const stake = normalizeChipStake(chipStake);
    const balance = normalizeChipBalance(chipBalance);
    if (stake == null || balance == null) return safeCb(cb, { ok:false, message:'五戯チップ情報が不正です。' });
    if (balance < stake) return safeCb(cb, { ok:false, code:'CHIPS_SHORT', message:`五戯チップが不足しています。必要${stake} / 所持${balance}` });
    // 新規参加前に、同じブラウザへ残った古い待機枠だけを除去する。対戦中は保持する。
    removeLobbyPlayersForBrowser(browserId);
    const recovered = recoverClientJoin(socket, clientInstanceId, browserId, pageInstanceId);
    if (recovered?.error) return safeCb(cb, recoveryErrorPayload(recovered.error));
    if (recovered) {
      emitPlayerState(recovered.room, recovered.p, { includeHistory: true });
      return safeCb(cb, { ok: true, recovered: true, code: recovered.room.code, sessionToken: recovered.p.sessionToken });
    }
    if (socket.data.roomId) return safeCb(cb, { ok: false, message: 'すでに参加中です。' });
    if (browserIdInUse(normalizeBrowserId(browserId))) return safeCb(cb, { ok: false, code: 'BROWSER_IN_USE', message: 'このブラウザはすでに別の対戦に参加中です。' });
    const room = makeRoom({ isPublic: false, chipStake: stake });
    if (!room) return safeCb(cb, { ok: false, message: '現在部屋を作成できません。少し待ってから再試行してください。' });
    let p;
    try { p = registerPlayer(room, socket, clientInstanceId, browserId, pageInstanceId, balance); }
    catch (error) {
      if (room.players.length === 0) deleteRoom(room);
      return safeCb(cb, registrationErrorPayload(error));
    }
    emitState(room);
    safeCb(cb, { ok: true, code: room.code, sessionToken: p.sessionToken });
  });

  socket.on('joinPrivate', (rawPayload = {}, cb) => {
    const { code, clientInstanceId, browserId, pageInstanceId, chipBalance } = objectPayload(rawPayload);
    if (!allow(socket, 'join', 4, 10_000)) return safeCb(cb, { ok: false, message: '操作が多すぎます。' });
    if (!normalizeClientInstanceId(clientInstanceId) || !normalizeBrowserId(browserId) || !normalizePageInstanceId(pageInstanceId)) return safeCb(cb, { ok: false, message: '参加情報が不正です。画面を更新してください。' });
    const balance = normalizeChipBalance(chipBalance);
    if (balance == null) return safeCb(cb, { ok:false, message:'五戯チップ情報が不正です。' });
    // 新規参加前に、同じブラウザへ残った古い待機枠だけを除去する。対戦中は保持する。
    removeLobbyPlayersForBrowser(browserId);
    const recovered = recoverClientJoin(socket, clientInstanceId, browserId, pageInstanceId);
    if (recovered?.error) return safeCb(cb, recoveryErrorPayload(recovered.error));
    if (recovered) {
      emitPlayerState(recovered.room, recovered.p, { includeHistory: true });
      return safeCb(cb, { ok: true, recovered: true, code: recovered.room.code, sessionToken: recovered.p.sessionToken });
    }
    if (socket.data.roomId) return safeCb(cb, { ok: false, message: 'すでに参加中です。' });
    if (browserIdInUse(normalizeBrowserId(browserId))) return safeCb(cb, { ok: false, code: 'BROWSER_IN_USE', message: 'このブラウザはすでに別の対戦に参加中です。' });
    const rawCode = String(code ?? '').trim().toUpperCase();
    const codeRegex = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);
    if (!codeRegex.test(rawCode)) return safeCb(cb, { ok: false, message: `${ROOM_CODE_LENGTH}文字のルームコードが不正です。` });
    const c = rawCode;
    const room = [...rooms.values()].find(r => !r.isPublic && r.code === c);
    if (!room) return safeCb(cb, { ok: false, message: '部屋コードが見つかりません。' });
    if (room.status !== 'lobby' || room.players.length >= MAX_PLAYERS) return safeCb(cb, { ok: false, message: 'この部屋には参加できません。' });
    if (balance < Number(room.chipStake || 0)) return safeCb(cb, { ok:false, code:'CHIPS_SHORT', message:`この部屋は${Number(room.chipStake || 0)}五戯チップ必要です。所持${balance}` });
    let p;
    try { p = registerPlayer(room, socket, clientInstanceId, browserId, pageInstanceId, balance); }
    catch (error) { return safeCb(cb, registrationErrorPayload(error)); }
    emitState(room);
    safeCb(cb, { ok: true, sessionToken: p.sessionToken });
    // プライベート対戦も5人目の参加直後に公開マッチと同じ条件で自動開始する。
    maybeStart(room);
  });


  socket.on('requestState', (_payload = {}, cb) => {
    if (!allow(socket, 'requestState', 24, 10_000)) return safeCb(cb, { ok: false, message: '操作が多すぎます。' });
    const { room, p } = socketPlayer(socket);
    if (!room || !p) return safeCb(cb, { ok: false, message: '参加中の試合がありません。' });
    emitPlayerState(room, p);
    safeCb(cb, { ok: true });
  });

  socket.on('fillWithCpu', (_rawPayload = {}, cb) => {
    if (!allow(socket, 'fillWithCpu', 3, 10_000)) return safeCb(cb, { ok:false, message:'操作が多すぎます。' });
    const { room, p } = socketPlayer(socket);
    if (!room || !p) return safeCb(cb, { ok:false, message:'参加中の部屋がありません。' });
    if (room.status !== 'lobby') return safeCb(cb, { ok:false, message:'CP補充は待機中のみです。' });
    const added = fillRoomWithTestCpu(room);
    if (added <= 0) return safeCb(cb, { ok:false, message:'空き枠がありません。' });
    log(room, `確認テスト用CPを${added}人補充しました。`);
    emitState(room);
    safeCb(cb, { ok:true, added });
    maybeStart(room);
  });

  socket.on('leaveRoom', (rawPayload = {}, cb) => {
    let { room, p } = socketPlayer(socket);
    const { sessionToken, clientInstanceId, browserId } = objectPayload(rawPayload);

    // Socket紐付けが先に外れていても、明示退出の識別子から待機プレイヤーを特定して削除する。
    if (!room || !p) {
      const token = cleanText(sessionToken, 128);
      const normalizedBrowserId = normalizeBrowserId(browserId);
      const normalizedClientId = normalizeClientInstanceId(clientInstanceId);
      if (token) {
        const ref = sessionIndex.get(token);
        room = ref && rooms.get(ref.roomId);
        p = room && getPlayer(room, ref.playerId);
        if (!p || p.sessionToken !== token) { room = null; p = null; }
      }
      if (!p && normalizedBrowserId && normalizedClientId) {
        for (const candidateRoom of rooms.values()) {
          if (candidateRoom.status !== 'lobby') continue;
          const candidate = candidateRoom.players.find(player =>
            player.browserId === normalizedBrowserId && player.clientInstanceId === normalizedClientId
          );
          if (candidate) { room = candidateRoom; p = candidate; break; }
        }
      }
    }

    if (!room || !p) {
      const staleRoomId = socket.data.roomId;
      if (staleRoomId) socket.leave(staleRoomId);
      socket.data.roomId = null;
      socket.data.playerId = null;
      return safeCb(cb, { ok: true, alreadyLeft: true });
    }
    if (!['lobby', 'finished'].includes(room.status)) return safeCb(cb, { ok: false, message: '対戦中は退出できません。' });
    if (p.socketId) {
      const liveSocket = io.sockets.sockets.get(p.socketId);
      if (liveSocket) {
        liveSocket.leave(room.id);
        if (liveSocket.data.roomId === room.id && liveSocket.data.playerId === p.playerId) {
          liveSocket.data.roomId = null;
          liveSocket.data.playerId = null;
        }
      }
    }
    socket.leave(room.id);
    socket.data.roomId = null;
    socket.data.playerId = null;
    removePlayerRecord(room, p.playerId);
    if (room.players.length === 0) deleteRoom(room); else emitState(room);
    safeCb(cb, { ok: true });
  });

  socket.on('setReady', (rawPayload = {}, cb) => {
    const { ready, phaseSeq } = objectPayload(rawPayload);
    if (!allow(socket, 'ready', 10, 5_000)) return safeCb(cb, { ok: false, message: '操作が多すぎます。' });
    const { room, p } = socketPlayer(socket);
    if (!room || !p) return safeCb(cb, { ok: false, message: '参加中の試合がありません。' });
    if (!allowPlayer(p, 'ready', 10, 5_000)) return safeCb(cb, { ok: false, message: '操作が多すぎます。' });
    if (!p.alive || !phaseAcceptsMutation(room, 'chat')) return safeCb(cb, { ok: false, message: '会話時間が終了したため準備操作できません。' });
    if (!phaseSeqMatches(room, p, phaseSeq)) return safeCb(cb, { ok: false, message: '画面が古いため更新しました。' });
    if (ready) {
      if (playerHasPendingDeal(room, p.playerId)) return safeCb(cb, { ok: false, message: '未処理の交換提案があります。承認・拒否・取消をしてから次へ進んでください。' });
      const validated = validateDraft(room, p, p.draft, { strict: true });
      if (!validated.ok) return safeCb(cb, validated);
      p.draft = validated.draft;
    }
    markTurnActivity(room, p);
    p.ready = !!ready;
    safeCb(cb, { ok: true });
    // 会話・選択は同一フェーズ。全生存者が『次へ』なら即ターン解決へ進む。
    if (allAliveReady(room)) resolveAndShowResult(room);
    else emitState(room);
  });

  socket.on('setDraft', (rawPayload = {}, cb) => {
    const { draft, phaseSeq } = objectPayload(rawPayload);
    if (!allow(socket, 'draft', 40, 5_000)) return safeCb(cb, { ok: false, message: '操作が多すぎます。' });
    const { room, p } = socketPlayer(socket);
    if (!room || !p) return safeCb(cb, { ok: false, message: '参加中の試合がありません。' });
    if (!allowPlayer(p, 'draft', 40, 5_000)) return safeCb(cb, { ok: false, message: '操作が多すぎます。' });
    if (!p.alive || room.phase !== 'chat') return safeCb(cb, { ok: false, message: '今は行動を選択できません。' });
    if (Number.isFinite(room.phaseEndsAt) && now() >= room.phaseEndsAt) { advanceExpiredPhase(room); return safeCb(cb, { ok: false, message: '選択時間が終了しました。' }); }
    if (room.phase === 'chat' && p.ready) return safeCb(cb, { ok: false, message: '準備OKを解除してから変更してください。' });
    if (!phaseSeqMatches(room, p, phaseSeq)) return safeCb(cb, { ok: false, message: '画面が古いため更新しました。' });
    const result = validateDraft(room, p, draft, { strict: false });
    if (!result.ok) return safeCb(cb, result);
    markTurnActivity(room, p);
    p.draft = result.draft;
    // draft変更は本人の仮選択だけなので、チャット履歴等を含む全snapshotを毎回再送しない。
    // 高速操作時の帯域・DOM再描画負荷を抑え、サーバーで正規化したdraftをACKで返す。
    safeCb(cb, { ok: true, draft: result.draft });
  });


  socket.on('nextResult', (rawPayload = {}, cb) => {
    const { phaseSeq } = objectPayload(rawPayload);
    if (!allow(socket, 'resultNext', 8, 5_000)) return safeCb(cb, { ok: false, message: '操作が多すぎます。' });
    const { room, p } = socketPlayer(socket);
    if (!room || !p) return safeCb(cb, { ok: false, message: '参加中の試合がありません。' });
    if (room.status !== 'playing' || room.phase !== 'result') return safeCb(cb, { ok: false, message: '今は結果確認中ではありません。' });
    if (!phaseSeqMatches(room, p, phaseSeq)) return safeCb(cb, { ok: false, message: '画面が古いため更新しました。' });
    p.resultReady = true;
    safeCb(cb, { ok: true });
    if (allResultReady(room)) advanceFromResult(room);
    else emitState(room);
  });

  socket.on('chat', (rawPayload = {}, cb) => {
    const { text, toId = null, phaseSeq, opId } = objectPayload(rawPayload);
    if (!allow(socket, 'chat', 8, 5_000)) return safeCb(cb, { ok: false, message: '送信が速すぎます。' });
    const { room, p } = socketPlayer(socket);
    if (!room || !p) return safeCb(cb, { ok: false, message: '参加中の試合がありません。' });
    if (!allowPlayer(p, 'chat', 8, 5_000)) return safeCb(cb, { ok: false, message: '送信が速すぎます。' });
    const mutation = checkMutation(p, 'chat', opId);
    if (!mutation.ok) return safeCb(cb, mutation);
    if (mutation.duplicate) return safeCb(cb, { ok: true, duplicate: true });
    if (!p.alive || !phaseAcceptsMutation(room, 'chat')) return safeCb(cb, { ok: false, message: '会話時間が終了したため送信できません。' });
    if (!phaseSeqMatches(room, p, phaseSeq)) return safeCb(cb, { ok: false, message: '画面が古いため更新しました。' });
    if (p.ready) return safeCb(cb, { ok: false, message: '準備OKを解除してから送信してください。' });
    const clean = cleanText(text, 300);
    if (!clean) return safeCb(cb, { ok: false, message: 'メッセージを入力してください。' });
    let target = null;
    if (toId) {
      target = validTarget(room, p, toId);
      if (!target) return safeCb(cb, { ok: false, message: '個別チャットの相手が不正です。' });
    }
    commitMutation(p, mutation.key);
    markTurnActivity(room, p);
    const message = {
      id: randomId('msg'), fromId: p.playerId, fromColor: p.color.label,
      toId: target?.playerId || null, toColor: target?.color?.label || null,
      text: clean, at: now(), structured: false
    };
    room.chat.push(message);
    if (room.chat.length > CHAT_HISTORY_LIMIT) room.chat.shift();
    if (target) {
      io.to(p.socketId).emit('chatMessage', message);
      if (target.connected) io.to(target.socketId).emit('chatMessage', message);
    } else {
      io.to(room.id).emit('chatMessage', message);
    }
    safeCb(cb, { ok: true });
  });

  socket.on('buy', (rawPayload = {}, cb) => {
    const { type, phaseSeq, opId } = objectPayload(rawPayload);
    if (!allow(socket, 'buy', 8, 5_000)) return safeCb(cb, { ok: false, message: '操作が多すぎます。' });
    const { room, p } = socketPlayer(socket);
    if (!room || !p) return safeCb(cb, { ok: false, message: '参加中の試合がありません。' });
    if (!allowPlayer(p, 'buy', 8, 5_000)) return safeCb(cb, { ok: false, message: '操作が多すぎます。' });
    const mutation = checkMutation(p, 'buy', opId);
    if (!mutation.ok) return safeCb(cb, mutation);
    if (mutation.duplicate) return safeCb(cb, { ok: true, duplicate: true });
    if (!p.alive || !phaseAcceptsMutation(room, 'chat')) return safeCb(cb, { ok: false, message: '購入は会話時間内のみです。' });
    if (!phaseSeqMatches(room, p, phaseSeq)) return safeCb(cb, { ok: false, message: '画面が古いため更新しました。' });
    if (p.ready) return safeCb(cb, { ok: false, message: '準備OKを解除してから購入してください。' });
    const key = cleanText(type, 32);
    if (key === 'special') {
      if (p.points < SPECIAL_PURCHASE_PRICE) return safeCb(cb, { ok: false, message: 'ポイント不足です。' });
      const keys = Object.keys(SPECIAL_CARDS);
      const special = keys[crypto.randomInt(keys.length)];
      markTurnActivity(room, p);
      commitMutation(p, mutation.key);
      p.points -= SPECIAL_PURCHASE_PRICE;
      p.specials[special] = (p.specials[special] || 0) + 1;
      p.stats.specialPurchases++;
      p.stats.lastSpecialPurchaseTurn = room.turn;
      log(room, `${p.color.label}が特殊カードを購入しました。`);
      emitPrivateEvent(room, p.playerId, { type: 'notice', text: `「${SPECIAL_CARDS[special].label}」を購入しました。` });
    } else {
      const def = NORMAL_CARDS[key];
      if (!def) return safeCb(cb, { ok: false, message: 'カードが不正です。' });
      if (p.points < def.price) return safeCb(cb, { ok: false, message: 'ポイント不足です。' });
      markTurnActivity(room, p);
      commitMutation(p, mutation.key);
      p.points -= def.price;
      p.hand[key] = (p.hand[key] || 0) + 1;
      p.stats.normalPurchases++;
      p.stats.lastNormalPurchaseType = key;
      p.stats.lastNormalPurchaseTurn = room.turn;
      log(room, `${p.color.label}が通常カードを購入しました。`);
    }
    emitPlayerState(room, p);
    safeCb(cb, { ok: true });
  });

  socket.on('createExchange', (rawPayload = {}, cb) => {
    const { toId, offerPoints = 0, offerCardType = '', offerCardSpecial = false, requestPoints = 0, requestCardType = '', requestCardSpecial = false, phaseSeq, opId } = objectPayload(rawPayload);
    if (!allow(socket, 'createExchange', 8, 5_000)) return safeCb(cb, { ok:false, message:'操作が多すぎます。' });
    const { room, p } = socketPlayer(socket);
    if (!room || !p) return safeCb(cb, { ok:false, message:'参加中の試合がありません。' });
    if (!allowPlayer(p, 'createExchange', 8, 5_000)) return safeCb(cb, { ok:false, message:'操作が多すぎます。' });
    const mutation = checkMutation(p, 'createExchange', opId);
    if (!mutation.ok) return safeCb(cb, mutation);
    if (mutation.duplicate) return safeCb(cb, { ok:true, duplicate:true });
    if (!p.alive || !phaseAcceptsMutation(room, 'chat')) return safeCb(cb, { ok:false, message:'交換は会話時間内のみです。' });
    if (!phaseSeqMatches(room, p, phaseSeq)) return safeCb(cb, { ok:false, message:'画面が古いため更新しました。' });
    if (p.ready) return safeCb(cb, { ok:false, message:'準備OKを解除してから交換を提案してください。' });
    const target = validTarget(room, p, toId);
    if (!target || (target.ready && !isTestCpu(target))) return safeCb(cb, { ok:false, message:'交換相手が不正、または準備OK中です。' });

    const givePoints = Number(offerPoints || 0);
    const wantPoints = Number(requestPoints || 0);
    const validPoints = n => Number.isInteger(n) && n >= 0 && (n === 0 || n % 5 === 0);
    if (!validPoints(givePoints) || !validPoints(wantPoints)) return safeCb(cb, { ok:false, message:'交換ポイントは0Pまたは5P刻みで指定してください。' });
    if (givePoints > p.points) return safeCb(cb, { ok:false, message:'交換に出すポイントが不足しています。' });

    let offerCard = null;
    if (cleanText(offerCardType, 32)) {
      const card = normalizeExchangeCard(room, p, offerCardType, offerCardSpecial === true, { requireOwned:true });
      if (!card) return safeCb(cb, { ok:false, message:'交換に出すカードが不正です。' });
      if (card.error) return safeCb(cb, { ok:false, message:card.error });
      offerCard = card;
    }
    let requestedCard = null;
    if (cleanText(requestCardType, 32)) {
      const card = normalizeExchangeCard(room, target, requestCardType, requestCardSpecial === true, { requireOwned:false });
      if (!card || card.error) return safeCb(cb, { ok:false, message:'受け取りたいカードが不正です。' });
      requestedCard = card;
    }
    const offer = { points:givePoints, card:offerCard };
    const request = { points:wantPoints, card:requestedCard };
    if (!bundleHasAsset(offer) && !bundleHasAsset(request)) return safeCb(cb, { ok:false, message:'交換内容が空です。少なくともどちらか一方にポイントまたはカードを指定してください。' });

    // 提案者側だけ先にエスクロー。受け手側は承認時に原子的に確認・移動する。
    p.points -= givePoints;
    if (offerCard) {
      const taken = takeCardForExchange(room, p, offerCard);
      if (!taken.ok) { p.points += givePoints; return safeCb(cb, taken); }
      offer.card = taken.card;
    }
    if (!Array.isArray(room.exchangeRequests)) room.exchangeRequests = [];
    const req = { requestId:randomId('ex'), fromId:p.playerId, toId:target.playerId, offer, request, turn:room.turn, createdAt:now() };
    room.exchangeRequests.push(req);
    markTurnActivity(room, p);
    commitMutation(p, mutation.key);
    log(room, `${p.color.label}から${target.color.label}${isTestCpu(target) ? '（CP）' : ''}へ交換提案が届きました。`, [p.playerId, target.playerId]);
    emitGameNotice(room, [target.playerId], { kind:'exchange', toolTarget:'transfer', text:`${p.color.label}から交換提案が届きました。` });
    if (isTestCpu(target) && tryAcceptExchangeAsCpu(room, req)) {
      emitPlayerState(room, p);
      return safeCb(cb, { ok:true, pending:false, accepted:true, requestId:req.requestId });
    }
    emitPlayerState(room, p); emitPlayerState(room, target);
    safeCb(cb, { ok:true, pending:true, requestId:req.requestId });
  });

  socket.on('respondExchange', (rawPayload = {}, cb) => {
    const { requestId, accept = false, phaseSeq, opId } = objectPayload(rawPayload);
    if (!allow(socket, 'respondExchange', 12, 5_000)) return safeCb(cb, { ok:false, message:'操作が多すぎます。' });
    const { room, p } = socketPlayer(socket);
    if (!room || !p) return safeCb(cb, { ok:false, message:'参加中の試合がありません。' });
    if (!allowPlayer(p, 'respondExchange', 12, 5_000)) return safeCb(cb, { ok:false, message:'操作が多すぎます。' });
    const mutation = checkMutation(p, 'respondExchange', opId);
    if (!mutation.ok) return safeCb(cb, mutation);
    if (mutation.duplicate) return safeCb(cb, { ok:true, duplicate:true });
    if (!p.alive || !phaseAcceptsMutation(room, 'chat')) return safeCb(cb, { ok:false, message:'今は交換提案へ回答できません。' });
    if (!phaseSeqMatches(room, p, phaseSeq)) return safeCb(cb, { ok:false, message:'画面が古いため更新しました。' });
    if (p.ready) return safeCb(cb, { ok:false, message:'準備OKを解除してから回答してください。' });
    const req = Array.isArray(room.exchangeRequests) ? room.exchangeRequests.find(x => x.requestId === cleanText(requestId, 96) && x.turn === room.turn) : null;
    if (!req || req.toId !== p.playerId) return safeCb(cb, { ok:false, message:'交換提案が見つかりません。' });
    const from = getPlayer(room, req.fromId);
    if (!from || !from.alive) {
      const removed = removeExchangeRequest(room, req.requestId); if (removed) refundExchangeOffer(room, removed);
      emitPlayerState(room, p);
      return safeCb(cb, { ok:false, message:'提案者が脱落しているため交換を取り消しました。' });
    }
    if (accept !== true) {
      markTurnActivity(room, p);
      commitMutation(p, mutation.key);
      removeExchangeRequest(room, req.requestId); refundExchangeOffer(room, req);
      log(room, `${p.color.label}が${from.color.label}からの交換提案を拒否しました。`, [from.playerId, p.playerId]);
      emitGameNotice(room, [from.playerId], { kind:'exchange', toolTarget:'transfer', text:`${p.color.label}が交換提案を拒否しました。` });
      emitPlayerState(room, from); emitPlayerState(room, p);
      return safeCb(cb, { ok:true, accepted:false });
    }

    const wantPoints = Number(req.request?.points || 0);
    if (p.points < wantPoints) return safeCb(cb, { ok:false, message:'交換に必要なポイントが不足しています。' });
    let targetCard = null;
    if (req.request?.card) {
      const normalized = normalizeExchangeCard(room, p, req.request.card.type, req.request.card.special, { requireOwned:true });
      if (!normalized) return safeCb(cb, { ok:false, message:'交換に必要なカードを所持していません。' });
      if (normalized.error) return safeCb(cb, { ok:false, message:normalized.error });
      targetCard = normalized;
    }
    p.points -= wantPoints;
    if (targetCard) {
      const taken = takeCardForExchange(room, p, targetCard);
      if (!taken.ok) { p.points += wantPoints; return safeCb(cb, taken); }
      targetCard = taken.card;
    }
    markTurnActivity(room, p);
    commitMutation(p, mutation.key);
    removeExchangeRequest(room, req.requestId);
    p.points += Number(req.offer?.points || 0);
    giveExchangeCard(p, req.offer?.card);
    from.points += wantPoints;
    giveExchangeCard(from, targetCard);
    log(room, `交換成立：${from.color.label}「${bundleLabel(req.offer)}」⇔ ${p.color.label}「${bundleLabel({ points:wantPoints, card:targetCard })}」`);
    emitGameNotice(room, [from.playerId, p.playerId], { kind:'exchange', toolTarget:'transfer', text:`交換成立：${from.color.label} ⇔ ${p.color.label}` });
    emitPlayerState(room, from); emitPlayerState(room, p);
    safeCb(cb, { ok:true, accepted:true });
  });

  socket.on('cancelExchange', (rawPayload = {}, cb) => {
    const { requestId, phaseSeq, opId } = objectPayload(rawPayload);
    if (!allow(socket, 'cancelExchange', 10, 5_000)) return safeCb(cb, { ok:false, message:'操作が多すぎます。' });
    const { room, p } = socketPlayer(socket);
    if (!room || !p) return safeCb(cb, { ok:false, message:'参加中の試合がありません。' });
    if (!allowPlayer(p, 'cancelExchange', 10, 5_000)) return safeCb(cb, { ok:false, message:'操作が多すぎます。' });
    const mutation = checkMutation(p, 'cancelExchange', opId);
    if (!mutation.ok) return safeCb(cb, mutation);
    if (mutation.duplicate) return safeCb(cb, { ok:true, duplicate:true });
    if (!p.alive || !phaseAcceptsMutation(room, 'chat') || !phaseSeqMatches(room, p, phaseSeq)) return safeCb(cb, { ok:false, message:'今は交換提案を取り消せません。' });
    const req = Array.isArray(room.exchangeRequests) ? room.exchangeRequests.find(x => x.requestId === cleanText(requestId, 96) && x.turn === room.turn) : null;
    if (!req || req.fromId !== p.playerId) return safeCb(cb, { ok:false, message:'交換提案が見つかりません。' });
    commitMutation(p, mutation.key);
    removeExchangeRequest(room, req.requestId); refundExchangeOffer(room, req); markTurnActivity(room, p);
    const target = getPlayer(room, req.toId);
    if (target) log(room, `${p.color.label}が${target.color.label}への交換提案を取り消しました。`, [p.playerId, target.playerId]);
    if (target) emitGameNotice(room, [target.playerId], { kind:'exchange', toolTarget:'transfer', text:`${p.color.label}が交換提案を取り消しました。` });
    emitPlayerState(room, p); if (target) emitPlayerState(room, target);
    safeCb(cb, { ok:true });
  });

  socket.on('postPublicContract', (rawPayload = {}, cb) => {
    const { conditionType, subjectId = null, reward, phaseSeq, opId } = objectPayload(rawPayload);
    if (!allow(socket, 'postPublicContract', 6, 5_000)) return safeCb(cb, { ok:false, message:'操作が多すぎます。' });
    const { room, p } = socketPlayer(socket);
    if (!room || !p) return safeCb(cb, { ok:false, message:'参加中の試合がありません。' });
    if (!allowPlayer(p, 'postPublicContract', 6, 5_000)) return safeCb(cb, { ok:false, message:'操作が多すぎます。' });
    const mutation = checkMutation(p, 'postPublicContract', opId);
    if (!mutation.ok) return safeCb(cb, mutation);
    if (mutation.duplicate) return safeCb(cb, { ok:true, duplicate:true });
    if (!p.alive || !phaseAcceptsMutation(room, 'chat') || room.turn > MAX_TURNS) return safeCb(cb, { ok:false, message:'公開契約は第1〜15ターンの会話時間内に作成できます。' });
    if (!phaseSeqMatches(room, p, phaseSeq) || p.ready) return safeCb(cb, { ok:false, message:'準備OKを解除し、最新画面から契約してください。' });
    if (!Array.isArray(room.publicContracts)) room.publicContracts = [];
    const n = Number(reward);
    if (!validContractStake(n, p.points)) return safeCb(cb, { ok:false, message:'使用Pは所持P以内の20P刻みで指定してください。' });
    const kind = cleanText(conditionType, 32);
    let subject = null;
    if (kind === 'attackTarget' || kind === 'accuseTarget') {
      subject = validTarget(room, p, subjectId, { aliveOnly: kind !== 'accuseTarget', accusationOnly: kind === 'accuseTarget' });
      if (!subject) return safeCb(cb, { ok:false, message:kind === 'attackTarget' ? '攻撃対象が不正です。' : '告発済みの相手は選択できません。' });
    } else if (!['dontAttackIssuer', 'defendIssuer'].includes(kind)) {
      return safeCb(cb, { ok:false, message:'契約条件が不正です。' });
    }
    p.points -= n;
    // 公開契約は提示したそのターンの行動で判定する。
    const dueTurn = room.turn;
    const rewardMultiplier = dueTurn === MAX_TURNS ? 2 : 1;
    const perPlayer = contractRewardPerPlayer(n, rewardMultiplier);
    const contract = { contractId:randomId('ct'), issuerId:p.playerId, acceptorIds:[], conditionType:kind, subjectId:subject?.playerId || null, reward:n, createdTurn:room.turn, dueTurn, status:'open', createdAt:now() };
    room.publicContracts.push(contract);
    const autoParticipantCount = autoEnrollPublicContract(room, contract);
    markTurnActivity(room, p); commitMutation(p, mutation.key);
    const timing = dueTurn === room.turn ? 'このターン' : '次ターン';
    const condition = kind === 'attackTarget'
      ? `${timing}に${subject.color.label}を有効な攻撃で狙う`
      : kind === 'dontAttackIssuer'
        ? `${timing}に${p.color.label}を攻撃しない`
        : kind === 'defendIssuer'
          ? `${timing}に${p.color.label}へ防御カードを使う`
          : `${timing}に${subject.color.label}へ告発する（成功・失敗どちらでも可）`;
    log(room, `公開契約を提示：「${condition}」（報酬1人${perPlayer}P / 自動参加${autoParticipantCount}人）。`);
    emitGameNotice(room, room.players.map(x => x.playerId), { kind:'contract', toolTarget:'contractBox', text:`公開契約が提示されました：${condition} / 報酬1人${perPlayer}P / 対象者は自動参加` });
    emitState(room); safeCb(cb, { ok:true, contractId:contract.contractId });
  });

  socket.on('acceptPublicContract', (rawPayload = {}, cb) => {
    // 互換用。公開契約は現在すべて自動参加のため、手動参加は受け付けない。
    safeCb(cb, { ok:false, message:'公開契約は対象者が自動参加します。' });
  });

  socket.on('cancelPublicContract', (rawPayload = {}, cb) => {
    // 自動参加へ変更したため、提示後の手動取消は行わない。
    safeCb(cb, { ok:false, message:'公開契約は提示と同時に自動参加が確定するため取り消せません。' });
  });

  socket.on('placeWinnerBet', (rawPayload = {}, cb) => {
    const { targetId, amount, phaseSeq, opId } = objectPayload(rawPayload);
    if (!allow(socket, 'placeWinnerBet', 6, 5_000)) return safeCb(cb, { ok:false, message:'操作が多すぎます。' });
    const { room, p } = socketPlayer(socket);
    if (!room || !p) return safeCb(cb, { ok:false, message:'参加中の試合がありません。' });
    if (!allowPlayer(p, 'placeWinnerBet', 6, 5_000)) return safeCb(cb, { ok:false, message:'操作が多すぎます。' });
    const mutation = checkMutation(p, 'placeWinnerBet', opId);
    if (!mutation.ok) return safeCb(cb, mutation);
    if (mutation.duplicate) return safeCb(cb, { ok:true, duplicate:true });
    if (!phaseAcceptsMutation(room, 'chat') || !canPlaceWinnerBet(room, p)) return safeCb(cb, { ok:false, message:'1位予想は第3・6・9ターンの会話・行動選択中に1回だけ賭けられます。' });
    if (!phaseSeqMatches(room, p, phaseSeq)) return safeCb(cb, { ok:false, message:'画面が古いため更新しました。' });
    if (p.ready) return safeCb(cb, { ok:false, message:'準備OKを解除してから賭けてください。' });
    const result = placeWinnerBet(room, p, targetId, amount);
    if (!result.ok) return safeCb(cb, result);
    markTurnActivity(room, p);
    commitMutation(p, mutation.key);
    const target = getPlayer(room, targetId);
    log(room, `${p.color.label}が1位予想に${amount}Pを賭けました。`, [p.playerId]);
    emitPlayerState(room, p);
    safeCb(cb, { ok:true, bet:result.bet, targetColor:target?.color?.label || '' });
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomId);
    const p = room && getPlayer(room, socket.data.playerId);
    if (!room || !p || p.socketId !== socket.id) return;
    p.connected = false;
    p.socketId = null;
    // 終了画面ではクライアントが意図的にSocketを解放する。ここで切断ログや
    // 再接続猶予を作ると、終了直後に不要なstate/ログが連鎖する。
    if (room.status === 'finished') return;
    log(room, `${p.color?.label || 'プレイヤー'}が切断しました。`);
    emitState(room);

    // 待機室は以前の仕様へ戻し、切断した時点で即時退出。復帰猶予は作らない。
    if (room.status === 'lobby') {
      removeLobbyPlayer(room, p.playerId);
      return;
    }

    p.disconnectTimer = setTimeout(() => {
      p.disconnectTimer = null;
      if (p.connected) return;
      if (room.status === 'playing') {
        p.autoAdvance = true;
        if (room.phase === 'chat') { p.ready = true; p.autoReadySeq = room.phaseSeq; }
        if (room.phase === 'result') p.resultReady = true;
        emitState(room);
        if (room.phase === 'chat' && allAliveReady(room)) resolveAndShowResult(room);
        if (room.phase === 'result' && allResultReady(room)) advanceFromResult(room);
      }
    }, RECONNECT_GRACE_SECONDS * 1000);
  });
});

// 終了済み・古い空ロビーを掃除して、長期運用時のメモリ増加を防ぐ。
const cleanupInterval = setInterval(() => {
  const t = now();
  for (const room of [...rooms.values()]) {
    if (room.status === 'finished' && room.finishedAt && t - room.finishedAt > FINISHED_ROOM_TTL_MS) {
      deleteRoom(room);
      continue;
    }
    if (room.status === 'lobby' && room.players.length === 0 && t - room.createdAt > 5 * 60 * 1000) {
      deleteRoom(room);
    }
  }
}, 5 * 60 * 1000);
cleanupInterval.unref?.();

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: shutting down`);
  clearInterval(cleanupInterval);
  for (const room of rooms.values()) clearRoomTimer(room);
  // Socket.IO側でHTTPサーバーも閉じる。二重closeによるERR_SERVER_NOT_RUNNINGを避ける。
  io.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8_000).unref();
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`五疑戦 / GOGI: http://localhost:${PORT}`);
});
