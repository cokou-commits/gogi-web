'use strict';

const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const {
  MAX_PLAYERS, MAX_TURNS, CHAT_SECONDS, ACTION_SECONDS, RESULT_SECONDS,
  RECONNECT_GRACE_SECONDS, LOBBY_RECONNECT_GRACE_SECONDS, FINISHED_ROOM_TTL_MS, ROOM_CODE_LENGTH, ROOM_CODE_ALPHABET,
  NORMAL_CARDS, SPECIAL_CARDS, OBJECTIVES, POINT_TRANSFER_TURNS,
  SCORING, STEAL_AMOUNTS, SECRET_REWARD
} = require('./src/rules');
const {
  createRoom, createPlayer, getPlayer, startGame, validateDraft, resolveTurn,
  awardSurvivalBonus, buildRanking, recordStructuredStatement, canTransferPoints,
  randomId, randomRoomCode, invalidatePendingStructuredStatements, canTransferNormalCard
} = require('./src/engine');

const app = express();
const server = http.createServer(app);

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
app.use((req, res, next) => {
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
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// カード画像はURLにASSET_REVを付けるため長期キャッシュしても更新時に安全に切り替わる。
// 1試合目の待機中に先読みし、以後のカード表示・偵察表示で再転送を避ける。
app.use('/cards', express.static(path.join(__dirname, 'public', 'cards'), {
  maxAge: '365d', immutable: true, etag: true, index: false,
  setHeaders: res => res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
}));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: true, index: false, setHeaders: res => res.setHeader('Cache-Control', 'no-cache') }));
const EXPOSE_HEALTH_DETAILS = process.env.NODE_ENV !== 'production' || process.env.EXPOSE_HEALTH_DETAILS === 'true';
app.get('/health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!EXPOSE_HEALTH_DETAILS) return res.json({ ok: true });
  const activeRooms = [...rooms.values()].filter(r => r.status !== 'finished').length;
  res.json({ ok: true, game: '五疑戦', activeRooms, storedRooms: rooms.size, sockets: activeSocketConnections, uptime: Math.floor(process.uptime()) });
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
  const entry = { id: randomId('log'), turn: room.turn, text: cleanText(text, 500), at: now(), targets };
  room.logs.push(entry);
  if (room.logs.length > LOG_HISTORY_LIMIT) room.logs.shift();
  // 通常state更新のたびにログ履歴全体を再送しない。新規ログだけ差分配信し、
  // 再接続時のみsnapshotから履歴を復元する。
  if (Array.isArray(targets) && targets.length > 0) {
    for (const playerId of targets) {
      const target = getPlayer(room, playerId);
      if (target?.connected && target.socketId) io.to(target.socketId).emit('logEntry', entry);
    }
  } else {
    io.to(room.id).emit('logEntry', entry);
  }
  return entry;
}
function visibleLogs(room, playerId) {
  return room.logs.filter(x => !x.targets || x.targets.includes(playerId)).slice(-LOG_HISTORY_LIMIT);
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
function allAliveLocked(room) {
  const alive = getAlive(room);
  return alive.length > 0 && alive.every(p => p.actionLocked);
}

function uniqueRoomCode() {
  for (let i = 0; i < 40; i++) {
    const code = randomRoomCode();
    if (![...rooms.values()].some(r => r.code === code)) return code;
  }
  throw new Error('ルームコードの生成に失敗しました。');
}
function makeRoom({ isPublic = false } = {}) {
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
  const room = createRoom({ isPublic, code: uniqueRoomCode() });
  rooms.set(room.id, room);
  return room;
}
function findPublicWaitingRoom() {
  return [...rooms.values()]
    .filter(r => r.isPublic && r.status === 'lobby' && r.players.length < MAX_PLAYERS && r.players.every(p => p.connected))
    .sort((a, b) => b.players.length - a.players.length || a.createdAt - b.createdAt)[0] || null;
}

function publicPlayerView(p) {
  // 同時行動の心理戦を壊さないよう、他人が準備/確定した個人情報は公開しない。
  return {
    playerId: p.playerId,
    color: p.color,
    alive: p.alive,
    connected: p.connected
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
    alive: p.alive,
    connected: p.connected,
    ready: p.ready,
    actionLocked: p.actionLocked,
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
    forcedNormalType: p.forcedNormalType,
    forcedUnavailable,
    forcedConflict,
    scoutReports: p.scoutReports.slice(-30),
    stats: {
      kills: p.stats.soloKills + p.stats.jointKills,
      accusations: p.stats.successfulAccusations,
      survivedTurns: p.stats.survivedTurns
    }
  };
}
function resultView(room, playerId) {
  const r = room.lastResult;
  if (!r) return null;
  const privateItems = r.privateEvents.filter(e => e.to === playerId).map(e => {
    if (e.text) return e.text;
    if (e.type === 'scout' && e.report) return `偵察：${e.report.color} / HP${e.report.hp} / キル${e.report.kills}`;
    return '個別結果があります。';
  });
  const scoreItems = r.scoreEvents.filter(e => e.playerId === playerId).map(e => ({ reason: e.reason, actual: e.actual }));
  return { turn: r.turn, publicItems: r.publicEvents.map(e => e.text), privateItems, scoreItems };
}

function snapshot(room, playerId, { includeHistory = false, includeCatalog = true } = {}) {
  const p = getPlayer(room, playerId);
  const data = {
    gameName: '五疑戦',
    serverNow: now(),
    roomId: room.id,
    code: room.code,
    isPublic: room.isPublic,
    status: room.status,
    turn: room.turn,
    maxTurns: MAX_TURNS,
    phase: room.phase,
    phaseEndsAt: room.phaseEndsAt,
    phaseSeq: room.phaseSeq,
    chatSeconds: CHAT_SECONDS,
    actionSeconds: ACTION_SECONDS,
    resultSeconds: RESULT_SECONDS,
    players: room.players.map(publicPlayerView),
    phaseProgress: {
      alive: getAlive(room).length,
      ready: getAlive(room).filter(x => x.ready).length,
      locked: getAlive(room).filter(x => x.actionLocked).length
    },
    me: p ? selfView(p, room) : null,
    resumeToken: p?.sessionToken || null,
    transferAllowed: canTransferPoints(room),
    transferTurns: POINT_TRANSFER_TURNS,
    finishedRanking: room.finishedRanking,
    lastResult: p ? resultView(room, p.playerId) : null
  };
  // カード定義・秘密目標一覧・得点表は対戦中に変化しないため、同じSocketへ毎回再送しない。
  // 初回stateだけ送ってクライアント側で保持し、準備/確定など高頻度stateの帯域を削減する。
  if (includeCatalog) {
    data.normalCards = NORMAL_CARDS;
    data.specialCards = SPECIAL_CARDS;
    data.objectives = OBJECTIVES;
    data.rules = { scoring: SCORING, stealAmounts: STEAL_AMOUNTS, secretReward: SECRET_REWARD };
  }
  if (includeHistory) {
    data.logs = p ? visibleLogs(room, p.playerId) : [];
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
function emitState(room, { includeHistoryFor = null } = {}) {
  for (const p of room.players) {
    if (p.connected && p.socketId) {
      const includeHistory = !!includeHistoryFor?.has?.(p.playerId);
      emitSnapshot(room, p, { includeHistory });
    }
  }
}
function emitPlayerState(room, p, { includeHistory = false } = {}) {
  emitSnapshot(room, p, { includeHistory });
}
function emitPrivateEvent(room, playerId, event) {
  const p = getPlayer(room, playerId);
  if (p?.connected && p.socketId) io.to(p.socketId).emit('privateEvent', event);
}
function phaseSeqMatches(room, p, supplied) {
  if (Number(supplied) === room.phaseSeq) return true;
  emitPlayerState(room, p);
  return false;
}
function advanceExpiredPhase(room) {
  if (!room || room.status !== 'playing' || !Number.isFinite(room.phaseEndsAt) || now() < room.phaseEndsAt) return false;
  if (room.phase === 'chat') {
    beginAction(room);
    return true;
  }
  if (room.phase === 'action') {
    resolveAndShowResult(room);
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
function beginChat(room) {
  if (room.status !== 'playing') return;
  // 全員脱落済みなら操作できる人がいないため即終了する。
  // ターン番号を人工的に15へ進めると、第15ターン限定目標や2倍得点を誤発火させるため行わない。
  if (getAlive(room).length === 0) {
    log(room, '全プレイヤーが脱落したため試合を終了します。');
    finishGame(room);
    return;
  }
  for (const p of room.players) {
    p.ready = !p.alive || p.autoAdvance;
    p.actionLocked = !p.alive || p.autoAdvance;
    p.autoReadySeq = null;
    p.autoLockSeq = null;
    p.draft = {
      normal: null, special: null,
      normalTargetId: null, secondNormalTargetId: null, specialTargetId: null,
      accusationGuess: null, secondAccusationGuess: null,
      stealAmount: 5, specifiedType: null
    };
  }
  log(room, `ターン${room.turn}：会話フェーズ開始（最大${CHAT_SECONDS}秒）`);
  setPhase(room, 'chat', CHAT_SECONDS, () => beginAction(room));
  for (const p of room.players) if (p.alive && p.autoAdvance && p.ready) p.autoReadySeq = room.phaseSeq;
  if (allAliveReady(room)) beginAction(room);
}
function captureTurnState(room) {
  const fields = ['hp','maxHp','points','alive','hand','specials','specialPurchased','normalPurchasedTurn','secretState','draft','ready','actionLocked','forcedNormalType','scoutReports','stats'];
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

function beginAction(room) {
  if (room.status !== 'playing' || room.phase !== 'chat') return;
  for (const p of room.players) {
    p.ready = false;
    p.actionLocked = !p.alive || p.autoAdvance;
    p.autoReadySeq = null;
    p.autoLockSeq = null;
  }
  log(room, `ターン${room.turn}：行動確定（最大${ACTION_SECONDS}秒）`);
  setPhase(room, 'action', ACTION_SECONDS, () => resolveAndShowResult(room));
  for (const p of room.players) if (p.alive && p.autoAdvance && p.actionLocked) p.autoLockSeq = room.phaseSeq;
  if (allAliveLocked(room)) resolveAndShowResult(room);
}
function resolveAndShowResult(room) {
  if (room.status !== 'playing' || room.phase !== 'action') return;
  clearRoomTimer(room);
  const turnSnapshot = captureTurnState(room);
  let result;
  try {
    result = resolveTurn(room);
  } catch (error) {
    console.error('resolveTurn failed', error);
    restoreTurnState(room, turnSnapshot);
    invalidatePendingStructuredStatements(room);
    const text = 'システムエラーにより、このターンの行動はすべて無効として処理しました。';
    log(room, text);
    result = { privateEvents: [], publicEvents: [{ type: 'system', text }], scoreEvents: [] };
  }
  // 第15ターンの結果画面時点で生存+50Pも反映し、結果画面と最終順位のポイント差をなくす。
  if (room.turn >= MAX_TURNS) {
    const survivalEvents = awardSurvivalBonus(room);
    result.scoreEvents.push(...survivalEvents);
  }
  room.lastResult = { turn: room.turn, publicEvents: result.publicEvents, privateEvents: result.privateEvents, scoreEvents: result.scoreEvents };
  for (const e of result.publicEvents) log(room, e.text);
  for (const e of result.privateEvents) {
    // 偵察はscoutReportsと結果サマリーに残るため、意味のない「個別結果」ログを作らない。
    if (e.text) log(room, e.text, [e.to]);
    emitPrivateEvent(room, e.to, e);
  }
  room.phase = 'result';
  room.phaseSeq++;
  const seq = room.phaseSeq;
  room.phaseEndsAt = now() + RESULT_SECONDS * 1000;
  emitState(room);
  room.timer = setTimeout(() => {
    if (room.phaseSeq !== seq || room.status !== 'playing') return;
    if (room.turn >= MAX_TURNS || getAlive(room).length === 0) return finishGame(room);
    room.turn++;
    beginChat(room);
  }, RESULT_SECONDS * 1000 + 40);
}
function finishGame(room) {
  if (room.status !== 'playing') return;
  clearRoomTimer(room);
  awardSurvivalBonus(room);
  room.finishedRanking = buildRanking(room);
  room.status = 'finished';
  room.phase = 'finished';
  room.phaseEndsAt = null;
  room.phaseSeq++;
  room.finishedAt = now();
  log(room, 'ゲーム終了。最終結果を公開します。');
  emitState(room);
}
function maybeStart(room) {
  if (room.status !== 'lobby') return;
  if (room.players.length !== MAX_PLAYERS) return;
  if (!room.players.every(p => p.connected)) return;
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
function browserIdInUse(browserId, exceptPlayerId = null) {
  if (!browserId) return false;
  for (const room of rooms.values()) {
    if (!['lobby', 'playing'].includes(room.status)) continue;
    if (room.players.some(p => p.playerId !== exceptPlayerId && p.browserId === browserId)) return true;
  }
  return false;
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
  if (p.autoLockSeq === room.phaseSeq && room.phase === 'action') p.actionLocked = false;
  p.autoReadySeq = null;
  p.autoLockSeq = null;
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
function registerPlayer(room, socket, clientInstanceId, browserId, pageInstanceId) {
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
function validTarget(room, p, id, { aliveOnly = true } = {}) {
  const target = getPlayer(room, id);
  if (!target || target.playerId === p.playerId) return null;
  if (aliveOnly && !target.alive) return null;
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
    const { clientInstanceId, browserId, pageInstanceId } = objectPayload(rawPayload);
    if (!allow(socket, 'join', 4, 10_000)) return safeCb(cb, { ok: false, message: '操作が多すぎます。' });
    if (!normalizeClientInstanceId(clientInstanceId) || !normalizeBrowserId(browserId) || !normalizePageInstanceId(pageInstanceId)) return safeCb(cb, { ok: false, message: '参加情報が不正です。画面を更新してください。' });
    const recovered = recoverClientJoin(socket, clientInstanceId, browserId, pageInstanceId);
    if (recovered?.error) return safeCb(cb, recoveryErrorPayload(recovered.error));
    if (recovered) {
      emitPlayerState(recovered.room, recovered.p, { includeHistory: true });
      return safeCb(cb, { ok: true, recovered: true, code: recovered.room.code, sessionToken: recovered.p.sessionToken });
    }
    if (socket.data.roomId) return safeCb(cb, { ok: false, message: 'すでに参加中です。' });
    if (browserIdInUse(normalizeBrowserId(browserId))) return safeCb(cb, { ok: false, code: 'BROWSER_IN_USE', message: 'このブラウザはすでに別の対戦に参加中です。' });
    let room = findPublicWaitingRoom();
    if (!room) room = makeRoom({ isPublic: true });
    if (!room) return safeCb(cb, { ok: false, message: '現在満室です。少し待ってから再試行してください。' });
    let p;
    try { p = registerPlayer(room, socket, clientInstanceId, browserId, pageInstanceId); }
    catch (error) {
      if (room.players.length === 0) deleteRoom(room);
      return safeCb(cb, registrationErrorPayload(error));
    }
    emitState(room);
    safeCb(cb, { ok: true, sessionToken: p.sessionToken });
    maybeStart(room);
  });

  socket.on('createPrivate', (rawPayload = {}, cb) => {
    const { clientInstanceId, browserId, pageInstanceId } = objectPayload(rawPayload);
    if (!allow(socket, 'join', 4, 10_000)) return safeCb(cb, { ok: false, message: '操作が多すぎます。' });
    if (!normalizeClientInstanceId(clientInstanceId) || !normalizeBrowserId(browserId) || !normalizePageInstanceId(pageInstanceId)) return safeCb(cb, { ok: false, message: '参加情報が不正です。画面を更新してください。' });
    const recovered = recoverClientJoin(socket, clientInstanceId, browserId, pageInstanceId);
    if (recovered?.error) return safeCb(cb, recoveryErrorPayload(recovered.error));
    if (recovered) {
      emitPlayerState(recovered.room, recovered.p, { includeHistory: true });
      return safeCb(cb, { ok: true, recovered: true, code: recovered.room.code, sessionToken: recovered.p.sessionToken });
    }
    if (socket.data.roomId) return safeCb(cb, { ok: false, message: 'すでに参加中です。' });
    if (browserIdInUse(normalizeBrowserId(browserId))) return safeCb(cb, { ok: false, code: 'BROWSER_IN_USE', message: 'このブラウザはすでに別の対戦に参加中です。' });
    const room = makeRoom({ isPublic: false });
    if (!room) return safeCb(cb, { ok: false, message: '現在部屋を作成できません。少し待ってから再試行してください。' });
    let p;
    try { p = registerPlayer(room, socket, clientInstanceId, browserId, pageInstanceId); }
    catch (error) {
      if (room.players.length === 0) deleteRoom(room);
      return safeCb(cb, registrationErrorPayload(error));
    }
    emitState(room);
    safeCb(cb, { ok: true, code: room.code, sessionToken: p.sessionToken });
  });

  socket.on('joinPrivate', (rawPayload = {}, cb) => {
    const { code, clientInstanceId, browserId, pageInstanceId } = objectPayload(rawPayload);
    if (!allow(socket, 'join', 4, 10_000)) return safeCb(cb, { ok: false, message: '操作が多すぎます。' });
    if (!normalizeClientInstanceId(clientInstanceId) || !normalizeBrowserId(browserId) || !normalizePageInstanceId(pageInstanceId)) return safeCb(cb, { ok: false, message: '参加情報が不正です。画面を更新してください。' });
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
    let p;
    try { p = registerPlayer(room, socket, clientInstanceId, browserId, pageInstanceId); }
    catch (error) { return safeCb(cb, registrationErrorPayload(error)); }
    emitState(room);
    safeCb(cb, { ok: true, sessionToken: p.sessionToken });
    // プライベート対戦も5人目の参加直後に公開マッチと同じ条件で自動開始する。
    maybeStart(room);
  });

  socket.on('leaveRoom', (_payload = {}, cb) => {
    const { room, p } = socketPlayer(socket);
    if (!room || !p) {
      const staleRoomId = socket.data.roomId;
      if (staleRoomId) socket.leave(staleRoomId);
      socket.data.roomId = null;
      socket.data.playerId = null;
      return safeCb(cb, { ok: true });
    }
    if (!['lobby', 'finished'].includes(room.status)) return safeCb(cb, { ok: false, message: '対戦中は退出できません。' });
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
    p.ready = !!ready;
    safeCb(cb, { ok: true });
    // 最後の1人が準備完了した時はchatの5/5 stateを直後のaction stateの前に
    // 二重配信せず、そのまま次フェーズへ進めて帯域と再描画を1回削減する。
    if (allAliveReady(room)) beginAction(room);
    else emitState(room);
  });

  socket.on('setDraft', (rawPayload = {}, cb) => {
    const { draft, phaseSeq } = objectPayload(rawPayload);
    if (!allow(socket, 'draft', 40, 5_000)) return safeCb(cb, { ok: false, message: '操作が多すぎます。' });
    const { room, p } = socketPlayer(socket);
    if (!room || !p) return safeCb(cb, { ok: false, message: '参加中の試合がありません。' });
    if (!allowPlayer(p, 'draft', 40, 5_000)) return safeCb(cb, { ok: false, message: '操作が多すぎます。' });
    if (!p.alive || !['chat', 'action'].includes(room.phase)) return safeCb(cb, { ok: false, message: '今は行動を選択できません。' });
    if (Number.isFinite(room.phaseEndsAt) && now() >= room.phaseEndsAt) { advanceExpiredPhase(room); return safeCb(cb, { ok: false, message: '選択時間が終了しました。' }); }
    if (room.phase === 'chat' && p.ready) return safeCb(cb, { ok: false, message: '準備OKを解除してから変更してください。' });
    if (!phaseSeqMatches(room, p, phaseSeq)) return safeCb(cb, { ok: false, message: '画面が古いため更新しました。' });
    if (room.phase === 'action' && p.actionLocked) return safeCb(cb, { ok: false, message: 'すでに行動確定済みです。' });
    const result = validateDraft(room, p, draft, { strict: false });
    if (!result.ok) return safeCb(cb, result);
    p.draft = result.draft;
    // draft変更は本人の仮選択だけなので、チャット履歴等を含む全snapshotを毎回再送しない。
    // 高速操作時の帯域・DOM再描画負荷を抑え、サーバーで正規化したdraftをACKで返す。
    safeCb(cb, { ok: true, draft: result.draft });
  });

  socket.on('lockAction', (rawPayload = {}, cb) => {
    const { phaseSeq } = objectPayload(rawPayload);
    if (!allow(socket, 'lock', 8, 5_000)) return safeCb(cb, { ok: false, message: '操作が多すぎます。' });
    const { room, p } = socketPlayer(socket);
    if (!room || !p) return safeCb(cb, { ok: false, message: '参加中の試合がありません。' });
    if (!allowPlayer(p, 'lock', 8, 5_000)) return safeCb(cb, { ok: false, message: '操作が多すぎます。' });
    if (!p.alive || !phaseAcceptsMutation(room, 'action')) return safeCb(cb, { ok: false, message: '行動選択時間が終了しました。' });
    if (!phaseSeqMatches(room, p, phaseSeq)) return safeCb(cb, { ok: false, message: '画面が古いため更新しました。' });
    if (p.actionLocked) return safeCb(cb, { ok: true });
    const result = validateDraft(room, p, p.draft, { strict: true });
    if (!result.ok) return safeCb(cb, result);
    p.draft = result.draft;
    p.actionLocked = true;
    safeCb(cb, { ok: true });
    // 最後の1人が確定した時はactionの5/5 stateを挟まず、結果stateへ直接進む。
    if (allAliveLocked(room)) resolveAndShowResult(room);
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

  socket.on('infoStatement', (rawPayload = {}, cb) => {
    const payload = objectPayload(rawPayload);
    if (!allow(socket, 'info', 6, 10_000)) return safeCb(cb, { ok: false, message: '送信が速すぎます。' });
    const { room, p } = socketPlayer(socket);
    if (!room || !p) return safeCb(cb, { ok: false, message: '参加中の試合がありません。' });
    if (!allowPlayer(p, 'info', 6, 10_000)) return safeCb(cb, { ok: false, message: '送信が速すぎます。' });
    const mutation = checkMutation(p, 'info', payload.opId);
    if (!mutation.ok) return safeCb(cb, mutation);
    if (mutation.duplicate) return safeCb(cb, { ok: true, duplicate: true });
    if (!p.alive || !phaseAcceptsMutation(room, 'chat')) return safeCb(cb, { ok: false, message: '会話時間が終了したため情報発言できません。' });
    if (!phaseSeqMatches(room, p, payload.phaseSeq)) return safeCb(cb, { ok: false, message: '画面が古いため更新しました。' });
    if (p.ready) return safeCb(cb, { ok: false, message: '準備OKを解除してから送信してください。' });
    let chatTarget = null;
    if (payload.toId) {
      chatTarget = validTarget(room, p, payload.toId);
      if (!chatTarget) return safeCb(cb, { ok: false, message: '個別発言の相手が不正です。' });
    }
    const result = recordStructuredStatement(room, p, payload);
    if (!result.ok) return safeCb(cb, result);
    commitMutation(p, mutation.key);
    const message = {
      id: randomId('msg'), fromId: p.playerId, fromColor: p.color.label,
      toId: chatTarget?.playerId || null, toColor: chatTarget?.color?.label || null, text: result.text, at: now(), structured: true
    };
    room.chat.push(message);
    if (room.chat.length > CHAT_HISTORY_LIMIT) room.chat.shift();
    if (chatTarget) {
      io.to(p.socketId).emit('chatMessage', message);
      if (chatTarget.connected) io.to(chatTarget.socketId).emit('chatMessage', message);
    } else {
      io.to(room.id).emit('chatMessage', message);
    }
    // 構造化発言の真偽履歴は本人snapshotに表示しないため、ここで全snapshotを再送する必要はない。
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
      if (p.specialPurchased) return safeCb(cb, { ok: false, message: '特殊カードは1試合1回まで購入できます。' });
      if (p.points < 50) return safeCb(cb, { ok: false, message: 'ポイント不足です。' });
      const keys = Object.keys(SPECIAL_CARDS);
      const special = keys[crypto.randomInt(keys.length)];
      commitMutation(p, mutation.key);
      p.points -= 50;
      p.specials[special] = (p.specials[special] || 0) + 1;
      p.specialPurchased = true;
      p.stats.specialPurchases++;
      p.stats.lastSpecialPurchaseTurn = room.turn;
      log(room, `${p.color.label}が特殊カードを購入しました。`);
      emitPrivateEvent(room, p.playerId, { type: 'notice', text: `「${SPECIAL_CARDS[special].label}」を購入しました。` });
    } else {
      const def = NORMAL_CARDS[key];
      if (!def) return safeCb(cb, { ok: false, message: 'カードが不正です。' });
      if (p.normalPurchasedTurn === room.turn) return safeCb(cb, { ok: false, message: '通常カード購入は1ターン1回までです。' });
      if (p.points < def.price) return safeCb(cb, { ok: false, message: 'ポイント不足です。' });
      commitMutation(p, mutation.key);
      p.points -= def.price;
      p.hand[key] = (p.hand[key] || 0) + 1;
      p.normalPurchasedTurn = room.turn;
      p.stats.normalPurchases++;
      p.stats.lastNormalPurchaseType = key;
      p.stats.lastNormalPurchaseTurn = room.turn;
      log(room, `${p.color.label}が通常カードを購入しました。`);
    }
    emitPlayerState(room, p);
    safeCb(cb, { ok: true });
  });

  socket.on('transferCard', (rawPayload = {}, cb) => {
    const { toId, type, special = false, phaseSeq, opId } = objectPayload(rawPayload);
    if (!allow(socket, 'transferCard', 10, 5_000)) return safeCb(cb, { ok: false, message: '操作が多すぎます。' });
    const { room, p } = socketPlayer(socket);
    if (!room || !p) return safeCb(cb, { ok: false, message: '参加中の試合がありません。' });
    if (!allowPlayer(p, 'transferCard', 10, 5_000)) return safeCb(cb, { ok: false, message: '操作が多すぎます。' });
    const mutation = checkMutation(p, 'transferCard', opId);
    if (!mutation.ok) return safeCb(cb, mutation);
    if (mutation.duplicate) return safeCb(cb, { ok: true, duplicate: true });
    if (!p.alive || !phaseAcceptsMutation(room, 'chat')) return safeCb(cb, { ok: false, message: 'カード譲渡は会話時間内のみです。' });
    if (!phaseSeqMatches(room, p, phaseSeq)) return safeCb(cb, { ok: false, message: '画面が古いため更新しました。' });
    if (p.ready) return safeCb(cb, { ok: false, message: '準備OKを解除してから譲渡してください。' });
    const target = validTarget(room, p, toId);
    if (!target) return safeCb(cb, { ok: false, message: '相手が不正です。' });
    const key = cleanText(type, 32);
    const isSpecial = special === true;
    const bag = isSpecial ? p.specials : p.hand;
    const targetBag = isSpecial ? target.specials : target.hand;
    const defs = isSpecial ? SPECIAL_CARDS : NORMAL_CARDS;
    if (!defs[key] || (bag[key] || 0) <= 0) return safeCb(cb, { ok: false, message: 'そのカードを所持していません。' });
    if (!isSpecial && !canTransferNormalCard(room, p, key)) {
      return safeCb(cb, { ok: false, message: 'カード指定中の最後の指定カードは譲渡できません。' });
    }
    commitMutation(p, mutation.key);
    bag[key]--;
    targetBag[key] = (targetBag[key] || 0) + 1;
    if (!isSpecial && p.draft.normal === key && bag[key] <= 0) {
      p.draft.normal = null; p.draft.normalTargetId = null; p.draft.secondNormalTargetId = null; p.draft.accusationGuess = null; p.draft.secondAccusationGuess = null;
      if (p.draft.special === 'double') p.draft.special = null;
    }
    if (isSpecial && p.draft.special === key && bag[key] <= 0) {
      p.draft.special = null; p.draft.specialTargetId = null; p.draft.specifiedType = null; p.draft.secondNormalTargetId = null; p.draft.secondAccusationGuess = null;
    }
    p.stats.cardTransfers++;
    log(room, `${p.color.label}から${target.color.label}へカードが譲渡されました。`);
    emitPlayerState(room, p);
    emitPlayerState(room, target);
    safeCb(cb, { ok: true });
  });

  socket.on('transferPoints', (rawPayload = {}, cb) => {
    const { toId, amount, phaseSeq, opId } = objectPayload(rawPayload);
    if (!allow(socket, 'transferPoints', 10, 5_000)) return safeCb(cb, { ok: false, message: '操作が多すぎます。' });
    const { room, p } = socketPlayer(socket);
    if (!room || !p) return safeCb(cb, { ok: false, message: '参加中の試合がありません。' });
    if (!allowPlayer(p, 'transferPoints', 10, 5_000)) return safeCb(cb, { ok: false, message: '操作が多すぎます。' });
    const mutation = checkMutation(p, 'transferPoints', opId);
    if (!mutation.ok) return safeCb(cb, mutation);
    if (mutation.duplicate) return safeCb(cb, { ok: true, duplicate: true });
    if (!p.alive || !phaseAcceptsMutation(room, 'chat') || !canTransferPoints(room)) return safeCb(cb, { ok: false, message: 'ポイント譲渡は5・10・15ターンの会話時間内のみです。' });
    if (!phaseSeqMatches(room, p, phaseSeq)) return safeCb(cb, { ok: false, message: '画面が古いため更新しました。' });
    if (p.ready) return safeCb(cb, { ok: false, message: '準備OKを解除してから譲渡してください。' });
    const target = validTarget(room, p, toId);
    const n = Number(amount);
    if (!target || !Number.isInteger(n) || n < 5 || n % 5 !== 0 || p.points < n) return safeCb(cb, { ok: false, message: '譲渡内容が不正です。' });
    commitMutation(p, mutation.key);
    p.points -= n;
    target.points += n;
    p.stats.pointTransfers++;
    log(room, `${p.color.label}から${target.color.label}へ${n}Pが譲渡されました。`);
    emitPlayerState(room, p);
    emitPlayerState(room, target);
    safeCb(cb, { ok: true });
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

    const graceSeconds = room.status === 'lobby' ? LOBBY_RECONNECT_GRACE_SECONDS : RECONNECT_GRACE_SECONDS;
    p.disconnectTimer = setTimeout(() => {
      p.disconnectTimer = null;
      if (p.connected) return;
      if (room.status === 'lobby') {
        removeLobbyPlayer(room, p.playerId);
        return;
      }
      if (room.status === 'playing') {
        p.autoAdvance = true;
        if (room.phase === 'chat') { p.ready = true; p.autoReadySeq = room.phaseSeq; }
        if (room.phase === 'action') { p.actionLocked = true; p.autoLockSeq = room.phaseSeq; }
        emitState(room);
        if (room.phase === 'chat' && allAliveReady(room)) beginAction(room);
        if (room.phase === 'action' && allAliveLocked(room)) resolveAndShowResult(room);
      }
    }, graceSeconds * 1000);
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
