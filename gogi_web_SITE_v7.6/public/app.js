'use strict';

const socket = io({ transports: ['websocket', 'polling'], autoConnect: false });
const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const SESSION_KEY = 'gogi.sessionToken.v2';
const TAB_SESSION_KEY = 'gogi.tabSessionToken.v1';
const INSTANCE_KEY = 'gogi.clientInstance.v1';
const BROWSER_KEY = 'gogi.browserId.v1';
function getStorage(name) { try { return globalThis?.[name] || null; } catch { return null; } }
const sessionStore = getStorage('sessionStorage');
const localStore = getStorage('localStorage');
function storageGet(storage, key) { try { return storage?.getItem(key) ?? null; } catch { return null; } }
function storageSet(storage, key, value) { try { if (!storage) return false; storage.setItem(key, value); return true; } catch { return false; } }
function storageRemove(storage, key) { try { storage?.removeItem(key); } catch {} }
function randomClientId() {
  if (globalThis.crypto?.randomUUID) return `tab_${crypto.randomUUID().replaceAll('-', '_')}`;
  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return `tab_${[...bytes].map(x => x.toString(16).padStart(2,'0')).join('')}`;
  }
  return `tab_${Date.now().toString(36)}_${Math.floor(performance.now() * 1000).toString(36)}`;
}
let clientInstanceId = storageGet(sessionStore, INSTANCE_KEY);
if (!clientInstanceId) {
  clientInstanceId = randomClientId();
  storageSet(sessionStore, INSTANCE_KEY, clientInstanceId);
}
const pageInstanceId = `page_${randomClientId()}`;
let browserId = storageGet(localStore, BROWSER_KEY);
if (!browserId) {
  browserId = `browser_${randomClientId()}`;
  storageSet(localStore, BROWSER_KEY, browserId);
}
let state = null;
let timerHandle = null;
let toastHandle = null;
let lastMessageIds = new Set();
let joining = false;
let manualJoinInFlight = false;
let clockOffsetMs = 0;
const tradeUi = { exchangeTarget:'', offerPoints:'0', offerKind:'none', offerType:'', requestPoints:'0', requestKind:'none', requestType:'' };
const contractUi = { conditionType:'attackTarget', subjectId:'', reward:'25' };
const winnerBetUi = { targetId:'', amount:'5' };
let draftUpdateChain = Promise.resolve();
let operationCounter = 0;
let sessionReadyPromise = Promise.resolve();
let chatSending = false;
let gameNoticeHandle = null;
let gameNoticeTarget = '';
let chatNoticeState = { global:0, privateById:{}, privateColorById:{}, latestKind:'', latestPeerId:'', latestFrom:'' };
const AUDIO_SFX_KEY = 'gogi.audio.sfx.v1';
const audioPrefs = {
  sfx: storageGet(localStore, AUDIO_SFX_KEY) !== 'off'
};
let audioContext = null;
let sfxGain = null;
let audioUnlocked = false;
let lastAudioSnapshot = null;
let lastResultSoundSeq = null;
let renderedChatKey = '';
let renderedLogsKey = '';
let renderedScoutKey = '';
let cardArtPreloaded = false;
let lastPhaseNavigationSeq = null;
let finalRevealAdvanced = false;

function createAudioContext() {
  if (audioContext) return audioContext;
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctx) return null;
  audioContext = new Ctx();
  sfxGain = audioContext.createGain();
  sfxGain.gain.value = 0.72;
  sfxGain.connect(audioContext.destination);
  return audioContext;
}
async function unlockAudio() {
  try { if (navigator?.audioSession && 'type' in navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  const ctx = createAudioContext();
  if (!ctx) return false;
  try {
    const one = ctx.createBuffer(1, 1, Math.max(8000, ctx.sampleRate));
    const source = ctx.createBufferSource();
    const silent = ctx.createGain();
    silent.gain.value = 0.00001;
    source.buffer = one; source.connect(silent); silent.connect(ctx.destination);
    source.start(0);
    if (ctx.state === 'suspended') await ctx.resume();
    audioUnlocked = ctx.state === 'running';
  } catch { audioUnlocked = false; }
  return audioUnlocked;
}
function setSfxPref(enabled) {
  audioPrefs.sfx = !!enabled;
  storageSet(localStore, AUDIO_SFX_KEY, enabled ? 'on' : 'off');
  renderAudioControls();
  if (enabled) playSfx('toggle');
}
function renderAudioControls() {
  const sfx = $('#sfxToggle');
  if (sfx) {
    sfx.textContent = audioPrefs.sfx ? 'SE ON' : 'SE OFF';
    sfx.setAttribute('aria-pressed', String(audioPrefs.sfx));
  }
}
function tone(freq, duration = 0.12, { gain = 0.08, type = 'sine', when = 0, detune = 0 } = {}) {
  if (!audioUnlocked || !audioContext || !sfxGain) return;
  const t = audioContext.currentTime + Math.max(0, when);
  const osc = audioContext.createOscillator();
  const env = audioContext.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(Math.max(20, freq), t);
  osc.detune.setValueAtTime(detune, t);
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.03, duration));
  osc.connect(env); env.connect(sfxGain);
  osc.start(t); osc.stop(t + Math.max(0.04, duration) + 0.03);
}
function noiseBurst(duration = 0.08, gain = 0.035) {
  if (!audioUnlocked || !audioContext || !sfxGain) return;
  const length = Math.max(1, Math.floor(audioContext.sampleRate * duration));
  const buffer = audioContext.createBuffer(1, length, audioContext.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
  const source = audioContext.createBufferSource();
  const env = audioContext.createGain();
  source.buffer = buffer;
  env.gain.value = gain;
  source.connect(env); env.connect(sfxGain);
  source.start();
}
function playSfx(kind) {
  if (!audioPrefs.sfx || !audioUnlocked) return;
  switch (kind) {
    case 'click': tone(620,.055,{gain:.035,type:'square'}); break;
    case 'toggle': tone(820,.08,{gain:.045,type:'sine'}); tone(1040,.08,{gain:.03,when:.055}); break;
    case 'chatGlobal': tone(740,.09,{gain:.055,type:'sine'}); tone(930,.10,{gain:.045,when:.07}); break;
    case 'chatPrivate': tone(880,.10,{gain:.065,type:'triangle'}); tone(1180,.13,{gain:.055,when:.07}); break;
    case 'noticeExchange': tone(660,.08,{gain:.055,type:'triangle'}); tone(920,.11,{gain:.055,when:.06}); tone(1120,.09,{gain:.04,when:.14}); break;
    case 'noticeContract': tone(520,.10,{gain:.055,type:'sine'}); tone(780,.12,{gain:.055,when:.07}); tone(1040,.12,{gain:.045,when:.15}); break;
    case 'card': tone(360,.06,{gain:.04,type:'triangle'}); tone(520,.07,{gain:.035,when:.04}); break;
    case 'pointsUp': tone(660,.08,{gain:.05}); tone(990,.13,{gain:.055,when:.06}); break;
    case 'pointsDown': tone(420,.09,{gain:.05,type:'triangle'}); tone(260,.15,{gain:.05,when:.06}); break;
    case 'heal': tone(520,.12,{gain:.05}); tone(780,.16,{gain:.055,when:.08}); break;
    case 'damage': noiseBurst(.075,.03); tone(110,.16,{gain:.08,type:'sawtooth'}); break;
    case 'success': tone(523.25,.10,{gain:.055}); tone(659.25,.10,{gain:.05,when:.07}); tone(783.99,.16,{gain:.05,when:.14}); break;
    case 'fail': tone(330,.11,{gain:.055,type:'triangle'}); tone(220,.18,{gain:.065,when:.08,type:'sawtooth'}); break;
    case 'turn': tone(392,.10,{gain:.045}); tone(523.25,.15,{gain:.05,when:.08}); break;
    case 'result': tone(196,.13,{gain:.055,type:'triangle'}); tone(293.66,.18,{gain:.05,when:.08}); break;
    case 'eliminate': noiseBurst(.12,.035); tone(82.4,.34,{gain:.085,type:'sawtooth'}); break;
    case 'objective': tone(523.25,.08,{gain:.05}); tone(659.25,.08,{gain:.05,when:.06}); tone(880,.22,{gain:.065,when:.13}); break;
    case 'finish': tone(261.63,.16,{gain:.055}); tone(329.63,.16,{gain:.05,when:.12}); tone(392,.16,{gain:.05,when:.24}); tone(523.25,.34,{gain:.06,when:.36}); break;
  }
}

function audioSnapshotFrom(next) {
  return next?.me ? {
    roomId: next.roomId || '', turn: next.turn || 0, phase: next.phase || '', status: next.status || '',
    hp: Number(next.me.hp || 0), points: Number(next.me.points || 0), alive: !!next.me.alive,
    objectiveAchieved: !!next.me.objectiveState?.achieved
  } : null;
}
function handleStateAudio(previousSnapshot, next) {
  const current = audioSnapshotFrom(next);
  if (!current) { lastAudioSnapshot = current; return; }
  if (previousSnapshot && previousSnapshot.roomId === current.roomId) {
    if (previousSnapshot.alive && !current.alive) playSfx('eliminate');
    else if (current.hp < previousSnapshot.hp) playSfx('damage');
    else if (current.hp > previousSnapshot.hp) playSfx('heal');
    if (current.points > previousSnapshot.points) playSfx('pointsUp');
    else if (current.points < previousSnapshot.points) playSfx('pointsDown');
    if (!previousSnapshot.objectiveAchieved && current.objectiveAchieved) playSfx('objective');
    if (current.turn !== previousSnapshot.turn && current.phase === 'chat') playSfx('turn');
    else if (current.phase !== previousSnapshot.phase && current.phase === 'result') playSfx('result');
    if (previousSnapshot.status !== 'finished' && current.status === 'finished') playSfx('finish');
  }
  lastAudioSnapshot = current;
}
function playResultOutcomeSound() {
  if (!state?.lastResult || lastResultSoundSeq === state.phaseSeq) return;
  lastResultSoundSeq = state.phaseSeq;
  const lines = Array.isArray(state.lastResult.items) ? state.lastResult.items.join(' ') : '';
  if (/失敗|無効|できません|0ダメージ/.test(lines)) playSfx('fail');
  else if (/成功|偵察|回復|防御/.test(lines)) playSfx('success');
}

function stopTimer() { if (timerHandle) clearInterval(timerHandle); timerHandle = null; }

function myPlayerId() {
  return state?.me?.playerId || null;
}
function isOwnMessage(message) {
  const mine = myPlayerId();
  return !!(message?.fromId && mine && message.fromId === mine);
}
function resetChatNotice() {
  chatNoticeState = { global:0, privateById:{}, privateColorById:{}, latestKind:'', latestPeerId:'', latestFrom:'' };
  renderChatNotice();
}
function registerIncomingChatNotice(message) {
  if (!message || isOwnMessage(message)) return;
  if (message.toId) {
    const peerId = message.fromId || '';
    if (!peerId) return;
    chatNoticeState.privateById[peerId] = Number(chatNoticeState.privateById[peerId] || 0) + 1;
    chatNoticeState.privateColorById[peerId] = message.fromColor || '個別';
    chatNoticeState.latestKind = 'private';
    chatNoticeState.latestPeerId = peerId;
    chatNoticeState.latestFrom = message.fromColor || '';
  } else {
    chatNoticeState.global = Number(chatNoticeState.global || 0) + 1;
    chatNoticeState.latestKind = 'global';
    chatNoticeState.latestPeerId = '';
    chatNoticeState.latestFrom = '';
  }
  renderChatNotice();
}
function renderChatNotice() {
  const el = $('#chatNotice');
  if (!el) return;
  const globalCount = Number(chatNoticeState.global || 0);
  const privateEntries = Object.entries(chatNoticeState.privateById || {}).filter(([,count]) => Number(count) > 0);
  const privateCount = privateEntries.reduce((sum,[,count]) => sum + Number(count || 0), 0);
  const total = globalCount + privateCount;
  const hidden = total <= 0 || state?.phase !== 'chat';
  el.classList.toggle('hidden', hidden);
  if (hidden) return;
  let kind = 'mixed';
  if (globalCount && !privateCount) kind = 'global';
  else if (privateCount && !globalCount) kind = 'private';
  el.dataset.kind = kind;
  const labels = [];
  if (globalCount) labels.push(`全体${globalCount}件`);
  for (const [peerId,count] of privateEntries) {
    const color = chatNoticeState.privateColorById?.[peerId] || '個別';
    labels.push(`${color}個別${Number(count)}件`);
  }
  el.textContent = `新着：${labels.join(' / ')}`;
}
function clearActiveChatNotice() {
  const targetId = activeChatTargetId();
  if (targetId) {
    delete chatNoticeState.privateById[targetId];
    delete chatNoticeState.privateColorById[targetId];
  } else {
    chatNoticeState.global = 0;
  }
  renderChatNotice();
}
function showGameNotice(event) {
  const el = $('#gameNotice');
  if (!el || !event?.text) return;
  clearTimeout(gameNoticeHandle);
  gameNoticeTarget = event.toolTarget || '';
  el.dataset.kind = event.kind || 'notice';
  el.textContent = event.text;
  el.classList.remove('hidden');
  playSfx(event.kind === 'contract' ? 'noticeContract' : 'noticeExchange');
  gameNoticeHandle = setTimeout(() => el.classList.add('hidden'), 6500);
}
function clearChatNoticeIfAtBottom() {
  const box = $('#messages');
  if (!box) return;
  const distance = box.scrollHeight - box.scrollTop - box.clientHeight;
  if (distance < 24) clearActiveChatNotice();
}

function disconnectIdleSocket() {
  if (!state && socket.connected) socket.disconnect();
}
function setConnectionState(mode) {
  const labels = { online:'接続中', reconnecting:'再接続中', offline:'接続待ち' };
  $$('[data-connection-state]').forEach(el => {
    el.dataset.state = mode;
    el.textContent = labels[mode] || labels.offline;
  });
  const banner = $('#reconnectBanner');
  if (banner) banner.classList.toggle('hidden', mode !== 'reconnecting');
}

function show(id) {
  $$('.screen').forEach(el => el.classList.remove('active'));
  $(id)?.classList.add('active');
}
function toast(text) {
  const el = $('#toast');
  if (!el) return;
  clearTimeout(toastHandle);
  el.textContent = String(text || '');
  el.classList.add('show');
  toastHandle = setTimeout(() => el.classList.remove('show'), 2200);
}
let tabSessionToken = storageGet(sessionStore, TAB_SESSION_KEY);
function setSession(token, { forceShared = false } = {}) {
  const previousTabToken = tabSessionToken;
  if (token) {
    tabSessionToken = token;
    storageSet(sessionStore, TAB_SESSION_KEY, token);
    const shared = storageGet(localStore, SESSION_KEY);
    // 終了済みの古いタブが、新しい対戦中タブの復帰トークンを上書きしない。
    if (forceShared || !shared || shared === previousTabToken || shared === token) storageSet(localStore, SESSION_KEY, token);
    return;
  }
  const shared = storageGet(localStore, SESSION_KEY);
  if (previousTabToken && shared === previousTabToken) storageRemove(localStore, SESSION_KEY);
  storageRemove(sessionStore, TAB_SESSION_KEY);
  tabSessionToken = null;
}
function clearSessionToken(token) {
  const shared = storageGet(localStore, SESSION_KEY);
  if (token && shared === token) storageRemove(localStore, SESSION_KEY);
  if (!token || tabSessionToken === token) {
    storageRemove(sessionStore, TAB_SESSION_KEY);
    tabSessionToken = null;
  }
}
function resumeTokenCandidate() {
  return tabSessionToken || storageGet(localStore, SESSION_KEY);
}
function ensureSocketConnected(timeoutMs = 3500) {
  if (socket.connected) return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('connect_error', onError);
      resolve(ok);
    };
    const onConnect = () => finish(true);
    const onError = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', onConnect);
    socket.once('connect_error', onError);
    socket.connect();
  });
}
async function emitAck(event, payload = {}, timeoutMs = 7000) {
  if (!(await ensureSocketConnected())) return { ok:false, transient:true, message:'サーバーに接続できません。通信状況を確認してください。' };
  // 再接続直後はSocket接続だけ先に復旧し、サーバー側のプレイヤー紐付けが
  // まだ終わっていない短い区間がある。通常操作はresume完了後に送る。
  if (event !== 'resume') {
    try { await sessionReadyPromise; } catch {}
  }
  return new Promise(resolve => {
    socket.timeout(timeoutMs).emit(event, payload, (err, res) => {
      if (err) return resolve({ ok:false, transient:true, message:'通信が不安定です。再試行してください。' });
      resolve(res || { ok:false, message:'応答がありません。' });
    });
  });
}
function operationId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID().replaceAll('-', '_');
  operationCounter = (operationCounter + 1) % 0x7fffffff;
  return `op_${Date.now().toString(36)}_${operationCounter.toString(36)}_${clientInstanceId.slice(-16)}`;
}
async function emitMutation(event, payload = {}) {
  const opId = operationId();
  let res = await emitAck(event, { ...payload, opId });
  // ACKだけ落ちたケースでは同じ操作IDで1度だけ再送し、二重処理をサーバー側で防ぐ。
  if (res?.transient) res = await emitAck(event, { ...payload, opId });
  return res;
}
function alivePlayers() { return state?.players?.filter(p => p.alive) || []; }
function otherAlivePlayers() { return alivePlayers().filter(p => p.playerId !== state?.me?.playerId); }
function colorLabel(player) { return player?.color?.label || '待機'; }
function playerToneClass(label) {
  const value = String(label || '');
  if (value.includes('赤')) return 'tone-red';
  if (value.includes('青')) return 'tone-blue';
  if (value.includes('緑')) return 'tone-green';
  if (value.includes('黄')) return 'tone-yellow';
  if (value.includes('紫')) return 'tone-purple';
  return 'tone-neutral';
}
function privateChatColorLabel(message) {
  if (!message?.toId) return '';
  const mine = myPlayerId();
  if (mine && message.fromId === mine) return message.toColor || '';
  return message.fromColor || message.toColor || '';
}
function privateChatLabel(message) {
  const label = privateChatColorLabel(message);
  return label ? `${label}個別チャット` : '個別チャット';
}
function syncChatModeLabel() {
  const select = $('#chatTarget');
  const option = select?.options?.[select.selectedIndex];
  $('#chatModeLabel').textContent = option?.textContent || '全体チャット';
}
function cardLabel(key) { return state?.normalCards?.[key]?.label || key || 'なし'; }
function specialLabel(key) { return state?.specialCards?.[key]?.label || key || 'なし'; }

const ASSET_REV = '20260911economy1';
const CARD_VISUALS = {
  attack: { image: `/cards/attack.webp?v=${ASSET_REV}`, effect: '相手1人に1ダメージ' },
  defense: { image: `/cards/defense.webp?v=${ASSET_REV}`, effect: '自分または生存者1人への攻撃を1ダメージ防ぐ' },
  scout: { image: `/cards/scout.webp?v=${ASSET_REV}`, effect: '相手1人のHP・キル数・通常カードを確認' },
  accusation: { image: `/cards/accusation.webp?v=${ASSET_REV}`, effect: '秘密目標を告発。成功+25P / 失敗-10P' },
  heal: { image: `/cards/heal.webp?v=${ASSET_REV}`, effect: '自分か相手1人のHPを2回復する' },
  fullDefense: { image: `/cards/fullDefense.webp?v=${ASSET_REV}`, effect: '受ける攻撃をすべて防ぐ' },
  cancel: { image: `/cards/cancel.webp?v=${ASSET_REV}`, effect: '相手1人の通常・特殊行動を無効化' },
  specify: { image: `/cards/specify.webp?v=${ASSET_REV}`, effect: '相手の次ターン通常カードを指定' },
  steal: { image: `/cards/steal.webp?v=${ASSET_REV}`, effect: '5・10・15・20・25Pから選んで奪う' },
  double: { image: `/cards/double.webp?v=${ASSET_REV}`, effect: '通常カードを2回分使う' }
};

const SCOUT_VISIBLE_NORMAL_KEYS = ['attack', 'defense', 'scout', 'accusation', 'heal'];

function preloadCardArt() {
  if (cardArtPreloaded) return;
  cardArtPreloaded = true;
  for (const visual of Object.values(CARD_VISUALS)) {
    const image = new Image();
    image.decoding = 'async';
    image.src = visual.image;
  }
}

function createScoutCardThumb(key, count) {
  const wrap = document.createElement('div');
  wrap.className = `scoutThumb card-${key}`;

  const imageWrap = document.createElement('div');
  imageWrap.className = 'scoutThumbImageWrap';
  const image = document.createElement('img');
  image.className = 'scoutThumbImage';
  image.src = CARD_VISUALS[key]?.image || '';
  image.alt = '';
  image.decoding = 'async';
  image.loading = 'lazy';
  image.draggable = false;
  imageWrap.appendChild(image);

  const countBadge = document.createElement('span');
  countBadge.className = 'scoutThumbCount';
  countBadge.textContent = `${count}枚`;

  const name = document.createElement('b');
  name.className = 'scoutThumbName';
  name.textContent = cardLabel(key);

  const effect = document.createElement('small');
  effect.className = 'scoutThumbEffect';
  effect.textContent = CARD_VISUALS[key]?.effect || '';

  wrap.append(imageWrap, countBadge, name, effect);
  return wrap;
}

function createResultSection(title, tone, items) {
  const section = document.createElement('section');
  section.className = `resultSection ${tone}`;

  const head = document.createElement('div');
  head.className = 'resultSectionHead';
  const heading = document.createElement('b');
  heading.textContent = title;
  const counter = document.createElement('span');
  counter.textContent = `${items.length}件`;
  head.append(heading, counter);
  section.appendChild(head);

  const list = document.createElement('div');
  list.className = 'resultSectionList';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'resultItem empty';
    empty.textContent = '変化なし';
    list.appendChild(empty);
  } else {
    for (const entry of items) {
      const row = document.createElement('div');
      row.className = `resultItem${entry.own ? ' own' : ''}${entry.score ? ' score' : ''}`;
      const marker = document.createElement('span');
      marker.className = 'resultMarker';
      marker.textContent = entry.score ? 'P' : entry.own ? '◆' : '•';
      const txt = document.createElement('div');
      txt.className = 'resultText';
      txt.textContent = entry.text;
      row.append(marker, txt);
      list.appendChild(row);
    }
  }
  section.appendChild(list);
  return section;
}

function createVisualCardButton({ key, def, count, selected = false, disabled = false }) {
  const visual = CARD_VISUALS[key] || { image: '', effect: '' };
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `cardBtn gameCard card-${key}${selected ? ' selected' : ''}`;
  button.disabled = disabled;
  button.setAttribute('aria-label', `${def.label}、残り${count}枚${visual.effect ? `、${visual.effect}` : ''}`);

  const badge = document.createElement('span');
  badge.className = 'cardCountBadge';
  badge.textContent = `${count}枚`;

  const fallback = document.createElement('span');
  fallback.className = 'gameCardFallback';
  fallback.textContent = def.label;

  const image = document.createElement('img');
  image.className = 'gameCardImage';
  image.src = visual.image;
  image.alt = '';
  image.draggable = false;
  image.decoding = 'async';
  image.addEventListener('error', () => button.classList.add('imageFailed'), { once:true });

  // 画像内の効果文はデザイン素材なので、実ルールと将来ズレないよう
  // 正式な効果文をHTMLで重ねる。特に「無効」は通常・特殊の両方を無効化する。
  const effect = document.createElement('span');
  effect.className = 'gameCardEffectOverlay';
  effect.textContent = visual.effect;

  button.append(badge, fallback, image, effect);
  return button;
}

function objectiveLabel(key) { return state?.objectives?.find(o => o.key === key)?.label || key || '—'; }
function phaseName(phase) { return ({chat:'会話制限時間', result:'結果発表', finished:'終了'})[phase] || phase || '—'; }

function saveJoinResult(res) {
  if (res?.ok && res.sessionToken) setSession(res.sessionToken, { forceShared: true });
}

function roomCodeFromUrl() {
  try {
    const url = new URL(location.href);
    const queryCode = url.searchParams.get('room')?.trim().toUpperCase() || '';
    const hashParams = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
    const hashCode = hashParams.get('room')?.trim().toUpperCase() || '';
    const code = hashCode || queryCode;
    return /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(code) ? code : '';
  } catch { return ''; }
}
function clearInviteQuery() {
  try {
    const url = new URL(location.href);
    let changed = false;
    if (url.searchParams.has('room')) {
      url.searchParams.delete('room');
      changed = true;
    }
    const hashParams = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash);
    if (hashParams.has('room')) {
      hashParams.delete('room');
      url.hash = hashParams.toString() ? `#${hashParams}` : '';
      changed = true;
    }
    if (changed) history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {}
}
function prepareInviteFromUrl() {
  const code = roomCodeFromUrl();
  if (!code) return;
  const input = $('#codeInput');
  if (input) input.value = code;
  $('#joinBox')?.classList.remove('hidden');
}
async function sharePrivateRoom() {
  if (!state?.code || state.isPublic) return;
  const url = new URL(location.origin + location.pathname);
  // ルームコードはURLフラグメントへ入れ、HTTP Refererやサーバーログへ送らない。
  url.hash = `room=${state.code}`;
  const text = `五疑戦に参加：部屋コード ${state.code}`;
  if (navigator.share) {
    try {
      await navigator.share({ title:'五疑戦', text, url:url.toString() });
      return;
    } catch (error) {
      if (error?.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(`${text}
${url}`);
    toast('招待リンクをコピーしました。');
  } catch {
    toast(`部屋コード：${state.code}`);
  }
}

async function tryResume() {
  const token = resumeTokenCandidate();
  if (!token || joining) return { ok:true, skipped:true };
  joining = true;
  try {
    let res = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      res = await emitAck('resume', { sessionToken: token, clientInstanceId, browserId, pageInstanceId });
      if (res.ok) return res;
      // リロード直後は旧ページのSocket切断通知より新ページのresumeが数百ms先に届くことがある。
      // 本物の別タブは接続中のままなので、短時間だけ再試行して両者を区別する。
      if (!res.transient && res.code === 'SESSION_IN_USE' && attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
        continue;
      }
      // inbound/ACKの一時欠落もあり得る。resumeはサーバー側で冪等化してあるため、
      // 同じtokenを短時間だけ再送して「サーバー未紐付けのままUIだけ残る」状態を減らす。
      if (res.transient && attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        continue;
      }
      // それでも一時エラーなら画面や復帰トークンは破棄しない。次の再接続で再試行する。
      if (res.transient) {
        if (res.message) toast(res.message);
        return res;
      }
      // 別タブで使用中の場合は共有localStorageの復帰トークンを消さない。
      if (res.code !== 'SESSION_IN_USE') clearSessionToken(token);
      stopTimer();
      state = null;
      show('#home');
      disconnectIdleSocket();
      if (res.message) toast(res.message);
      return res;
    }
    return res || { ok:false, transient:true, message:'再接続できませんでした。' };
  } finally {
    joining = false;
  }
}

async function startPublic() {
  if (joining) return;
  joining = true;
  manualJoinInFlight = true;
  let res;
  try { res = await emitAck('publicMatch', { clientInstanceId, browserId, pageInstanceId }); }
  finally { joining = false; manualJoinInFlight = false; }
  if (!res.ok) { toast(res.message); disconnectIdleSocket(); return; }
  saveJoinResult(res);
  if (state) render(); else show('#lobby');
}
async function createPrivate() {
  if (joining) return;
  joining = true;
  manualJoinInFlight = true;
  let res;
  try { res = await emitAck('createPrivate', { clientInstanceId, browserId, pageInstanceId }); }
  finally { joining = false; manualJoinInFlight = false; }
  if (!res.ok) { toast(res.message); disconnectIdleSocket(); return; }
  saveJoinResult(res);
  if (state) render(); else show('#lobby');
}
async function joinPrivate() {
  const code = ($('#codeInput')?.value || '').trim().toUpperCase();
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(code)) return toast('8文字のルームコードを入力してください。');
  if (joining) return;
  joining = true;
  manualJoinInFlight = true;
  let res;
  try { res = await emitAck('joinPrivate', { code, clientInstanceId, browserId, pageInstanceId }); }
  finally { joining = false; manualJoinInFlight = false; }
  if (!res.ok) { toast(res.message); disconnectIdleSocket(); return; }
  saveJoinResult(res);
  clearInviteQuery();
  if (state) render(); else show('#lobby');
}

async function fillWithCpu() {
  if (!state || state.status !== 'lobby') return;
  const res = await emitAck('fillWithCpu', {});
  if (!res.ok) return toast(res.message || 'CP補充に失敗しました。');
  toast(`CPを${res.added}人補充しました。`);
}

async function leaveCurrentRoom() {
  const leavingToken = tabSessionToken || state?.resumeToken || null;
  // 終了画面では既にSocketを解放しているため、再接続してleaveRoomする必要はない。
  // サーバー側の終了ルームはTTL清掃される。
  if (state?.status !== 'finished') {
    const res = await emitAck('leaveRoom', {});
    if (!res.ok) return toast(res.message);
  }
  clearSessionToken(leavingToken);
  stopTimer();
  state = null;
  lastMessageIds.clear();
  renderedChatKey = '';
  renderedLogsKey = '';
  renderedScoutKey = '';
  lastPhaseNavigationSeq = null;
  show('#home');
  disconnectIdleSocket();
}

$('#showJoin')?.addEventListener('click', () => $('#joinBox')?.classList.toggle('hidden'));
$('#publicMatch')?.addEventListener('click', startPublic);
$('#createPrivate')?.addEventListener('click', createPrivate);
$('#joinPrivate')?.addEventListener('click', joinPrivate);
$('#codeInput')?.addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^ABCDEFGHJKLMNPQRSTUVWXYZ23456789]/g, '').slice(0, 8); });
$('#codeInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') joinPrivate(); });
$('#fillCpu')?.addEventListener('click', fillWithCpu);
$('#leaveLobby')?.addEventListener('click', leaveCurrentRoom);
$('#backHome')?.addEventListener('click', leaveCurrentRoom);
$('#copyCode')?.addEventListener('click', async () => {
  if (!state?.code) return;
  try { await navigator.clipboard.writeText(state.code); toast('ルームコードをコピーしました。'); }
  catch { toast(`ルームコード：${state.code}`); }
});
$('#shareRoom')?.addEventListener('click', sharePrivateRoom);

function openRules() {
  const dialog = $('#rulesDialog');
  if (!dialog) return;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}
function closeRules() { const d = $('#rulesDialog'); if (d?.open && typeof d.close === 'function') d.close(); else d?.removeAttribute('open'); }
$('#openRules')?.addEventListener('click', openRules);
$('#openRulesGame')?.addEventListener('click', openRules);
$('#closeRules')?.addEventListener('click', closeRules);
$('#rulesDialog')?.addEventListener('click', e => { if (e.target === e.currentTarget) closeRules(); });
function closeToolDrawer() { $('#toolDrawer')?.classList.remove('open'); }
function openToolDrawerTarget(targetClass) {
  const drawer = $('#toolDrawer');
  if (!drawer || !targetClass) return;
  for (const child of drawer.querySelectorAll('.inventory,.transfer,.contractBox,.winnerBetBox,.scoutBox,.previousResult')) child.classList.add('toolHidden');
  drawer.querySelector('.' + targetClass)?.classList.remove('toolHidden');
  drawer.classList.add('open');
}
$$('[data-tool-target]').forEach(btn => btn.addEventListener('click', () => openToolDrawerTarget(btn.dataset.toolTarget)));
$('#toolClose')?.addEventListener('click', closeToolDrawer);

$('#chatForm')?.addEventListener('submit', async e => {
  e.preventDefault();
  if (chatSending || !state?.me?.alive || state.phase !== 'chat') return;
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;
  chatSending = true;
  try {
    const res = await emitMutation('chat', { text, toId: $('#chatTarget').value || null, phaseSeq: state.phaseSeq });
    if (!res.ok) return toast(res.message);
    // 送信待ち中に利用者が本文を書き換えていた場合は、その新しい本文を消さない。
    if (input.value.trim() === text) input.value = '';
  } finally {
    chatSending = false;
  }
});
$('#chatTarget')?.addEventListener('change', () => {
  syncChatModeLabel();
  renderedChatKey = '';
  renderChat();
});
$('#chatNotice')?.addEventListener('click', () => {
  const select = $('#chatTarget');
  if (select) {
    const desired = chatNoticeState.latestKind === 'private' ? chatNoticeState.latestPeerId : '';
    if ([...select.options].some(option => option.value === desired)) select.value = desired;
    syncChatModeLabel();
    renderedChatKey = '';
    renderChat();
  }
  const box = $('#messages');
  if (box) box.scrollTop = box.scrollHeight;
  clearActiveChatNotice();
  $('#chatInput')?.focus();
});
$('#gameNotice')?.addEventListener('click', () => {
  $('#gameNotice')?.classList.add('hidden');
  if (gameNoticeTarget) openToolDrawerTarget(gameNoticeTarget);
});
$('#messages')?.addEventListener('scroll', clearChatNoticeIfAtBottom);
$('#sfxToggle')?.addEventListener('click', async e => {
  e.stopPropagation();
  await unlockAudio();
  setSfxPref(!audioPrefs.sfx);
});
const audioUnlockGesture = () => { if (!audioUnlocked || audioContext?.state !== 'running') unlockAudio(); };
document.addEventListener('pointerdown', audioUnlockGesture, { passive:true });
document.addEventListener('touchend', audioUnlockGesture, { passive:true });
document.addEventListener('click', audioUnlockGesture, { passive:true });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && audioContext?.state === 'suspended') audioContext.resume().catch(() => {});
});
window.addEventListener('pageshow', () => { if (audioContext?.state === 'suspended') audioContext.resume().catch(() => {}); });
document.addEventListener('click', e => {
  if (!audioPrefs.sfx || !audioUnlocked) return;
  const target = e.target?.closest?.('button,.gameCard,.cardChoice,.cardTile');
  if (!target || target.id === 'sfxToggle') return;
  playSfx(target.classList?.contains('gameCard') ? 'card' : 'click');
}, true);
async function waitForDraftUpdates() {
  // 待機中に新しいdraft更新がキューへ追加されても取りこぼさない。
  // 単に `await draftUpdateChain` するだけだと、そのawait開始後に追加された更新を
  // 待たずに準備OK/行動確定してしまう可能性がある。
  while (true) {
    const pending = draftUpdateChain;
    await pending;
    if (pending === draftUpdateChain) return;
  }
}
$('#readyBtn')?.addEventListener('click', async () => {
  if (!state?.me?.alive || state.phase !== 'chat') return;
  await waitForDraftUpdates();
  if (!state?.me?.alive || state.phase !== 'chat') return;
  const res = await emitAck('setReady', { ready: !state.me.ready, phaseSeq: state.phaseSeq });
  if (!res.ok) toast(res.message);
});
$('#resultNextBtn')?.addEventListener('click', async () => {
  if (state?.phase !== 'result' || state?.me?.resultReady) return;
  const res = await emitAck('nextResult', { phaseSeq: state.phaseSeq });
  if (!res.ok) toast(res.message);
});

socket.on('connect', () => { sessionReadyPromise = tryResume(); });
socket.on('connect', () => { setConnectionState('online'); });
socket.on('state', next => {
  if (!next || typeof next !== 'object' || Array.isArray(next)) return;
  const previousAudioSnapshot = audioSnapshotFrom(state);
  if (next.resumeToken) setSession(next.resumeToken, { forceShared: manualJoinInFlight });
  if (Number.isFinite(next.serverNow)) clockOffsetMs = next.serverNow - Date.now();
  const sameRoom = !!(state?.roomId && next?.roomId && state.roomId === next.roomId);
  if (!sameRoom) { renderedChatKey = ''; renderedLogsKey = ''; renderedScoutKey = ''; lastMessageIds.clear(); lastPhaseNavigationSeq = null; finalRevealAdvanced = false; resetChatNotice(); }
  // 定義カタログはSocket初回stateだけ届く。以後の軽量stateでは既存値を保持する。
  for (const key of ['normalCards','specialCards','objectives','rules']) {
    if (!Object.prototype.hasOwnProperty.call(next, key) && state?.[key] != null) next[key] = state[key];
  }
  // 通常stateは軽量化のため履歴を含めない。既存履歴を保持し、再接続時の
  // includeHistory snapshotだけを完全な正として置き換える。
  if (!Object.prototype.hasOwnProperty.call(next || {}, 'chat')) next.chat = sameRoom ? (state?.chat || []) : [];
  if (!Object.prototype.hasOwnProperty.call(next || {}, 'logs')) next.logs = sameRoom ? (state?.logs || []) : [];
  state = next;
  handleStateAudio(previousAudioSnapshot, next);
  renderAudioControls();
  render();
});
socket.on('chatMessage', message => {
  if (!message?.id || lastMessageIds.has(message.id)) return;
  if (state) {
    state.chat = Array.isArray(state.chat) ? state.chat : [];
    state.chat.push(message);
    if (state.chat.length > 160) {
      const removed = state.chat.splice(0, state.chat.length - 160);
      for (const old of removed) if (old?.id) lastMessageIds.delete(old.id);
    }
  }
  if (messageBelongsToChannel(message)) appendMessage(message);
  registerIncomingChatNotice(message);
  if (!isOwnMessage(message)) playSfx(message.toId ? 'chatPrivate' : 'chatGlobal');
  lastMessageIds.add(message.id);
  renderedChatKey = '';
});
socket.on('logEntry', entry => {
  if (!entry?.id || !state) return;
  state.logs = Array.isArray(state.logs) ? state.logs : [];
  if (state.logs.some(item => item.id === entry.id)) return;
  state.logs.push(entry);
  if (state.logs.length > 80) state.logs.splice(0, state.logs.length - 80);
  if (state.status === 'playing') renderLogs();
});
socket.on('privateEvent', event => {
  if (event?.text) toast(event.text);
});
socket.on('gameNotice', event => {
  showGameNotice(event);
});
socket.on('disconnect', () => {
  setConnectionState(state ? 'reconnecting' : 'offline');
  if (state?.status === 'playing') toast('通信が切れました。再接続を試みています。');
});
socket.on('connect_error', () => {
  setConnectionState(state ? 'reconnecting' : 'offline');
  toast('サーバーに接続できません。通信状況を確認してください。');
});

function render() {
  if (!state) return;
  if (state.status === 'lobby') {
    show('#lobby');
    renderLobby();
    return;
  }
  if (state.status === 'playing') {
    show('#game');
    renderGame();
    return;
  }
  if (state.status === 'finished') {
    show('#finish');
    renderRanking();
    // 最終結果はクライアントstateに保持済み。終了画面を開きっぱなしでも
    // WebSocket接続枠を占有し続けないよう、自動再接続しない明示切断にする。
    if (socket.connected) socket.disconnect();
  }
}

function renderLobby() {
  // 待機時間を使ってカード画像を先読みし、1ターン目の表示遅延をなくす。
  preloadCardArt();
  const count = state.players.length;
  $('#lobbyTitle').textContent = state.isPublic ? '対戦相手を探しています' : 'プライベートルームで待機中';
  $('#lobbyNote').textContent = `${count}/5人参加中。5人揃うと自動で開始します。`;
  const fillCpuBtn = $('#fillCpu');
  if (fillCpuBtn) { fillCpuBtn.disabled = count >= 5; fillCpuBtn.textContent = count >= 5 ? 'CP補充済み' : `CPで残り${5-count}枠を補充`; }
  const copy = $('#copyCode');
  const share = $('#shareRoom');
  if (state.isPublic) {
    copy.classList.add('hidden');
    share?.classList.add('hidden');
  } else {
    copy.classList.remove('hidden');
    share?.classList.remove('hidden');
    copy.textContent = `ルーム ${state.code}`;
  }
  const box = $('#lobbyPlayers');
  box.replaceChildren();
  for (let i = 0; i < 5; i++) {
    const dot = document.createElement('span');
    dot.textContent = i < count ? '●' : '·';
    dot.classList.toggle('filled', i < count);
    box.appendChild(dot);
  }
}

function renderGame() {
  $('#game').dataset.phase = state.phase || '';
  $('#turnLabel').textContent = `第${state.turn}/${state.maxTurns}ターン`;
  $('#phaseLabel').textContent = phaseName(state.phase);
  renderTimer();
  renderMe();
  renderPlayers();
  renderLogs();
  renderChat();
  renderPhase();
  renderInventory();
  renderTrade();
  renderPublicContracts();
  renderWinnerBet();
  renderScoutReports();
  renderPreviousResult();
  renderAudioControls();
  navigateToActivePhaseOnMobile();
}

function navigateToActivePhaseOnMobile() {
  if (lastPhaseNavigationSeq === state?.phaseSeq) return;
  lastPhaseNavigationSeq = state?.phaseSeq ?? null;
  closeRules();
  closeToolDrawer();
  const active = document.activeElement;
  if (state?.phase === 'result' && active && typeof active.blur === 'function' && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName)) active.blur();
}

function renderTimer() {
  stopTimer();
  const tick = () => {
    const seconds = state?.phaseEndsAt ? Math.max(0, Math.ceil((state.phaseEndsAt - (Date.now() + clockOffsetMs)) / 1000)) : 0;
    const formatClock = total => {
      const safe = Math.max(0, Number(total) || 0);
      const minutes = Math.floor(safe / 60);
      const secs = safe % 60;
      return `${minutes}分${String(secs).padStart(2, '0')}秒`;
    };
    const timer = $('#timer');
    if (timer) timer.textContent = formatClock(seconds);
    const resultTimer = $('#resultTimer');
    if (resultTimer) resultTimer.textContent = formatClock(seconds);
  };
  tick();
  timerHandle = setInterval(tick, 200);
}

function renderMe() {
  const me = state.me;
  if (!me) return;
  const label = me.color?.label || '—';
  const colorKey = me.color?.key || '';
  $('#myColor').textContent = label;
  $('#myColor').className = `myColor ${colorKey ? 'text-' + colorKey : ''}`;
  $('#myHp').textContent = me.hp;
  $('#myPoints').textContent = me.points;
  $('#mobileColor').textContent = label;
  $('#mobileColor').className = colorKey ? `text-${colorKey}` : '';
  $('#mobileHp').textContent = me.hp;
  $('#mobilePoints').textContent = me.points;
  const standing = me.currentStanding;
  const standingText = standing ? `${standing.tied ? '同率' : ''}${standing.rank}位 / ${standing.total}人` : '';
  const standingStat = $('#standingStat');
  const mobileStandingWrap = $('#mobileStandingWrap');
  standingStat?.classList.remove('hidden');
  standingStat?.classList.toggle('preRank', !standing);
  mobileStandingWrap?.classList.toggle('hidden', !standing);
  if (standing) {
    $('#myStanding').textContent = standingText;
    $('#mobileStanding').textContent = standingText.replace('人', '');
    const alive = Number(state.phaseProgress?.alive ?? 0);
    $('#aliveCount').textContent = `生存者${alive}人`;
    $('#mobileAlive').textContent = `生存${alive}人`;
  } else {
    $('#myStanding').textContent = '第10ターンから';
    $('#aliveCount').textContent = '';
  }
  $('#myObjective').textContent = me.objective?.label || '—';
  $('#objectiveDesc').textContent = me.objective?.description || '';
  const afkBanner = $('#afkWarningBanner');
  if (afkBanner) afkBanner.classList.toggle('hidden', !me.alive || Number(me.afkStreak || 0) < 2);
  const stateEl = $('#objectiveState');
  if (me.objectiveState?.invalid) stateEl.textContent = '告発され無効';
  else if (me.objectiveState?.achieved) stateEl.textContent = '達成済み';
  else stateEl.textContent = '未達成';
  stateEl.className = me.objectiveState?.invalid ? 'bad' : me.objectiveState?.achieved ? 'good' : '';
}

function renderPlayers() {
  const box = $('#playersList');
  box.replaceChildren();
  for (const p of state.players) {
    const row = document.createElement('div');
    row.className = `playerRow${p.alive ? '' : ' dead'}`;
    const dot = document.createElement('span');
    dot.className = `dot ${p.color?.key ? 'dot-' + p.color.key : ''}`;
    const name = document.createElement('b');
    name.textContent = colorLabel(p);
    const meta = document.createElement('span');
    meta.className = 'meta';
    const flags = [];
    if (p.isCpu) flags.push('CP');
    else if (!p.connected) flags.push('切断');
    if (!p.alive) flags.push('脱落');
    meta.textContent = flags.join(' / ') || '参加中';
    row.append(dot, name, meta);
    box.appendChild(row);
  }
}

function historyKey(items) {
  if (!items?.length) return '0';
  return `${items.length}:${items[0]?.id || ''}:${items[items.length - 1]?.id || ''}`;
}
function renderLogs() {
  const box = $('#logs');
  const items = state.logs || [];
  const key = historyKey(items);
  if (key === renderedLogsKey) return;
  renderedLogsKey = key;
  box.replaceChildren();
  for (const item of [...items].reverse()) {
    const row = document.createElement('div');
    row.className = 'logItem';
    row.textContent = item.text;
    box.appendChild(row);
  }
}

function activeChatTargetId() {
  return $('#chatTarget')?.value || '';
}
function messageBelongsToChannel(message, targetId = activeChatTargetId()) {
  if (!message) return false;
  if (!targetId) return !message.toId;
  if (!message.toId) return false;
  const mine = myPlayerId();
  if (!mine) return false;
  return (message.fromId === mine && message.toId === targetId) || (message.fromId === targetId && message.toId === mine);
}
function visibleChatMessages() {
  const targetId = activeChatTargetId();
  return (state?.chat || []).filter(message => messageBelongsToChannel(message, targetId));
}

function renderChat() {
  renderChatTarget();
  const box = $('#messages');
  const messages = visibleChatMessages();
  const targetKey = activeChatTargetId() || 'global';
  const nextKey = `${targetKey}:${historyKey(messages)}`;
  if (nextKey !== renderedChatKey) {
    const distanceFromBottom = box.scrollHeight - box.scrollTop - box.clientHeight;
    const keepAtBottom = distanceFromBottom < 48;
    const previousTop = box.scrollTop;
    box.replaceChildren();
    lastMessageIds = new Set((state.chat || []).map(message => message?.id).filter(Boolean));
    for (const message of messages) appendMessage(message, false);
    renderedChatKey = nextKey;
    if (keepAtBottom) box.scrollTop = box.scrollHeight;
    else box.scrollTop = Math.min(previousTop, Math.max(0, box.scrollHeight - box.clientHeight));
  }
  renderChatNotice();
  clearChatNoticeIfAtBottom();
  const disabled = state.phase !== 'chat' || !state.me?.alive || !!state.me?.ready;
  $('#chatInput').disabled = disabled;
  $('#chatTarget').disabled = disabled;
  $('#chatForm').querySelector('button').disabled = disabled;
}

function renderChatTarget() {
  const select = $('#chatTarget');
  const previous = select.value;
  select.replaceChildren();
  const all = document.createElement('option');
  all.value = '';
  all.textContent = '全体チャット';
  select.appendChild(all);
  for (const p of otherAlivePlayers()) {
    const option = document.createElement('option');
    option.value = p.playerId;
    option.textContent = `${colorLabel(p)}個別チャット`;
    option.dataset.tone = playerToneClass(colorLabel(p));
    select.appendChild(option);
  }
  if ([...select.options].some(o => o.value === previous)) select.value = previous;
  syncChatModeLabel();
}

function appendMessage(message, autoScroll = true) {
  const box = $('#messages');
  if (!box) return;
  // 追加後ではなく追加前の位置で判定する。長文1件でscrollHeightが大きく増えても、
  // もともと最下部を読んでいた利用者は新着へ追従できる。
  const distanceBefore = box.scrollHeight - box.scrollTop - box.clientHeight;
  const shouldStickToBottom = autoScroll && distanceBefore < 120;
  const row = document.createElement('div');
  const channelTone = message.toId ? playerToneClass(privateChatColorLabel(message)) : playerToneClass(message.fromColor || '');
  row.className = `msg${message.toId ? ' private' : ''}${message.structured ? ' structured' : ''} ${channelTone}`.trim();
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = message.fromColor || '？';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = message.text || '';
  row.append(who, bubble);
  box.appendChild(row);
  // 差分配信が長時間続いてもDOMだけ無制限に増えないよう、表示履歴と同じ160件に固定する。
  while (box.children.length > 160) box.firstElementChild?.remove();
  if (shouldStickToBottom) box.scrollTop = box.scrollHeight;
}

function renderPhase() {
  const isChat = state.phase === 'chat';
  const isResult = state.phase === 'result';
  $('#game')?.classList.toggle('resultOnly', isResult);
  $('#chatPanel').classList.toggle('hidden', !isChat);
  $('#draftPanel').classList.toggle('hidden', !isChat);
  $('#resultPanel').classList.toggle('hidden', !isResult);

  const aliveCount = Number(state.phaseProgress?.alive ?? alivePlayers().length);
  const ready = Number(state.phaseProgress?.ready ?? 0);
  $('#readyCount').textContent = `次へ ${ready}/${aliveCount}`;

  if (isChat) {
    const btn = $('#readyBtn');
    btn.disabled = !state.me?.alive;
    btn.classList.toggle('on', !!state.me?.ready);
    btn.textContent = state.me?.ready ? '次へ ✓（戻る）' : '次へ';
    renderActionComposer($('#draftComposer'), false);
  }
  if (isResult) {
    const voters = Number(state.phaseProgress?.resultVoters ?? 0);
    const done = Number(state.phaseProgress?.resultReady ?? 0);
    const btn = $('#resultNextBtn');
    btn.disabled = !!state.me?.resultReady;
    btn.textContent = state.me?.resultReady ? '次へ ✓' : '次へ';
    $('#resultReadyCount').textContent = `次へ ${done}/${voters}`;
    renderResultSummary();
    playResultOutcomeSound();
  }
}

function renderResultSummary() {
  const box = $('#resultSummary');
  if (!box) return;
  box.replaceChildren();
  const r = state.lastResult;
  $('#resultTitle').textContent = r ? `第${r.turn}ターン 結果発表` : 'ターン結果発表';
  const items = (r?.items || []).map(text => ({ text, own:true, score:false }));
  box.append(createResultSection('結果', 'private', items));
}

function makeSelect(options, value, onChange, disabled = false) {
  const select = document.createElement('select');
  select.disabled = disabled;
  for (const [v, label] of options) {
    const option = document.createElement('option');
    option.value = v;
    option.textContent = label;
    select.appendChild(option);
  }
  select.value = value ?? '';
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

function playerOptions(includeBlank = true) {
  const arr = includeBlank ? [['', '対象を選択']] : [];
  for (const p of otherAlivePlayers()) arr.push([p.playerId, colorLabel(p)]);
  return arr;
}
function supportPlayerOptions(includeBlank = true, placeholder = '対象を選択') {
  const arr = includeBlank ? [['', placeholder]] : [];
  const me = state?.players?.find(p => p.playerId === state?.me?.playerId);
  if (me?.alive) arr.push([me.playerId, `${colorLabel(me)}（自分）`]);
  for (const p of otherAlivePlayers()) arr.push([p.playerId, colorLabel(p)]);
  return arr;
}
function healPlayerOptions(includeBlank = true) { return supportPlayerOptions(includeBlank, '回復対象を選択'); }
function defensePlayerOptions(includeBlank = true) { return supportPlayerOptions(includeBlank, '防御対象を選択'); }
function objectiveOptions(includeBlank = true) {
  const arr = includeBlank ? [['', '秘密目標を選択']] : [];
  for (const o of state.objectives || []) arr.push([o.key, o.label]);
  return arr;
}
function normalOptions(includeBlank = true) {
  const arr = includeBlank ? [['', 'カードを選択']] : [];
  for (const [k, def] of Object.entries(state.normalCards || {})) arr.push([k, def.label]);
  return arr;
}

function renderActionComposer(container, finalMode) {
  if (!container || !state.me) return;
  container.replaceChildren();
  const me = state.me;
  const draft = { ...me.draft };
  const disabled = !me.alive || (finalMode && me.actionLocked) || (!finalMode && me.ready);

  if (me.forcedNormalType?.turn === state.turn) {
    const banner = document.createElement('div');
    banner.className = `forcedBanner${me.forcedUnavailable || me.forcedConflict ? ' danger' : ''}`;
    banner.textContent = me.forcedConflict
      ? 'カード指定：複数の異なる指定が競合したため、このターンは行動なし'
      : me.forcedUnavailable
        ? `カード指定：${cardLabel(me.forcedNormalType.type)}を持っていないため、このターンは行動なし`
        : `カード指定中：「${cardLabel(me.forcedNormalType.type)}」が指定されているため、このカードしか使えません。`;
    container.appendChild(banner);
  }

  const section1 = document.createElement('div');
  section1.className = 'composerSection';
  section1.innerHTML = '<div class="composerTitle">通常カード</div>';
  const normalGrid = document.createElement('div');
  normalGrid.className = 'cardGrid';
  const forcedKey = me.forcedNormalType?.turn === state.turn && !me.forcedConflict ? me.forcedNormalType.type : null;
  for (const [key, def] of Object.entries(state.normalCards || {})) {
    const count = me.hand[key] || 0;
    const button = createVisualCardButton({
      key, def, count,
      selected: draft.normal === key,
      disabled: disabled || me.forcedUnavailable || me.forcedConflict || count <= 0 || (!!forcedKey && forcedKey !== key)
    });
    button.addEventListener('click', () => updateDraft({ normal: draft.normal === key && !forcedKey ? null : key }));
    normalGrid.appendChild(button);
  }
  section1.appendChild(normalGrid);
  const clearNormal = document.createElement('button');
  clearNormal.type = 'button';
  clearNormal.className = 'clearChoice';
  clearNormal.textContent = draft.normal ? '通常カードの選択を解除' : '通常カード：未選択';
  clearNormal.disabled = disabled || !!forcedKey || me.forcedConflict || !draft.normal;
  clearNormal.addEventListener('click', () => updateDraft({ normal: null, normalTargetId: null, secondNormalTargetId: null, accusationGuess: null, secondAccusationGuess: null }));
  section1.appendChild(clearNormal);
  container.appendChild(section1);

  if (['attack','defense','scout','accusation','heal'].includes(draft.normal)) {
    const targetBlock = document.createElement('div');
    targetBlock.className = 'fieldGrid';
    const label = document.createElement('label');
    const targetLabel = draft.normal === 'heal' ? '回復する対象' : draft.normal === 'defense' ? '防御する対象' : '通常カードの対象';
    label.innerHTML = `<span>${targetLabel}</span>`;
    const targetOptions = draft.normal === 'heal' ? healPlayerOptions() : draft.normal === 'defense' ? defensePlayerOptions() : playerOptions();
    label.appendChild(makeSelect(targetOptions, draft.normalTargetId, value => updateDraft({ normalTargetId: value || null }), disabled));
    targetBlock.appendChild(label);

    if (draft.normal === 'accusation') {
      const guess = document.createElement('label');
      guess.innerHTML = '<span>告発する秘密目標</span>';
      guess.appendChild(makeSelect(objectiveOptions(), draft.accusationGuess, value => updateDraft({ accusationGuess: value || null }), disabled));
      targetBlock.appendChild(guess);
    }
    container.appendChild(targetBlock);
  }

  const section2 = document.createElement('div');
  section2.className = 'composerSection';
  section2.innerHTML = '<div class="composerTitle">特殊カード <small>任意・通常カード枠とは別</small></div>';
  const specialGrid = document.createElement('div');
  specialGrid.className = 'cardGrid specialGrid';
  for (const [key, def] of Object.entries(state.specialCards || {})) {
    const count = me.specials[key] || 0;
    const button = createVisualCardButton({
      key, def, count,
      selected: draft.special === key,
      disabled: disabled || me.forcedUnavailable || me.forcedConflict || count <= 0 || (key === 'double' && !draft.normal)
    });
    button.addEventListener('click', () => updateDraft({ special: draft.special === key ? null : key }));
    specialGrid.appendChild(button);
  }
  section2.appendChild(specialGrid);
  const clearSpecial = document.createElement('button');
  clearSpecial.type = 'button';
  clearSpecial.className = 'clearChoice';
  clearSpecial.textContent = draft.special ? '特殊カードの選択を解除' : '特殊カード：未選択';
  clearSpecial.disabled = disabled || me.forcedUnavailable || me.forcedConflict || !draft.special;
  clearSpecial.addEventListener('click', () => updateDraft({ special: null, specialTargetId: null, specifiedType: null }));
  section2.appendChild(clearSpecial);
  container.appendChild(section2);

  if (['cancel','specify','steal'].includes(draft.special)) {
    const specialFields = document.createElement('div');
    specialFields.className = 'fieldGrid';
    const target = document.createElement('label');
    target.innerHTML = '<span>特殊カードの対象</span>';
    target.appendChild(makeSelect(playerOptions(), draft.specialTargetId, value => updateDraft({ specialTargetId: value || null }), disabled));
    specialFields.appendChild(target);
    if (draft.special === 'specify') {
      const type = document.createElement('label');
      type.innerHTML = '<span>次ターンに指定するカード</span>';
      type.appendChild(makeSelect(normalOptions(), draft.specifiedType, value => updateDraft({ specifiedType: value || null }), disabled));
      specialFields.appendChild(type);
    }
    if (draft.special === 'steal') {
      const amount = document.createElement('label');
      amount.innerHTML = '<span>奪うポイント</span>';
      amount.appendChild(makeSelect((state.rules?.stealAmounts || [5,10,15,20,25]).map(n => [String(n), `${n}P`]), String(draft.stealAmount || 5), value => updateDraft({ stealAmount: Number(value) }), disabled));
      specialFields.appendChild(amount);
    }
    container.appendChild(specialFields);
  }

  if (draft.special === 'double' && ['attack','scout','accusation'].includes(draft.normal)) {
    const second = document.createElement('div');
    second.className = 'fieldGrid doubleFields';
    const target = document.createElement('label');
    target.innerHTML = `<span>${draft.normal === 'attack' ? '2回目の攻撃対象' : draft.normal === 'scout' ? '2人目の偵察対象' : '2回目の告発対象'}（任意）</span>`;
    target.appendChild(makeSelect(playerOptions(), draft.secondNormalTargetId, value => updateDraft({ secondNormalTargetId: value || null }), disabled));
    second.appendChild(target);
    if (draft.normal === 'accusation') {
      const guess = document.createElement('label');
      guess.innerHTML = '<span>2回目の告発内容</span>';
      guess.appendChild(makeSelect(objectiveOptions(), draft.secondAccusationGuess, value => updateDraft({ secondAccusationGuess: value || null }), disabled));
      second.appendChild(guess);
    }
    container.appendChild(second);
  }

  const summary = document.createElement('div');
  summary.className = 'draftSummary';
  const normalText = draft.normal ? cardLabel(draft.normal) : '行動なし';
  const specialText = draft.special ? ` + ${specialLabel(draft.special)}` : '';
  summary.textContent = `選択：${normalText}${specialText}`;
  container.appendChild(summary);
}

function updateDraft(patch) {
  const requestedPhaseSeq = state?.phaseSeq;
  // 会話中に素早く複数項目を触っても、古いdraftを基準にした後発リクエストが
  // 先の選択を上書きしないよう、draft更新だけは直列化する。
  // 予期しないUI例外が1回起きても、以後の選択キュー全体が永続的にreject状態へ
  // 固定されないよう前回エラーを吸収してから次の更新を続ける。
  draftUpdateChain = draftUpdateChain.catch(() => {}).then(async () => {
    if (!state?.me?.alive || state.phase !== 'chat') return;
    if (state.phaseSeq !== requestedPhaseSeq) return;
    const current = { ...state.me.draft };
    const next = { ...current, ...patch };

    // カード変更時に不要な付随選択を掃除する。
    if ('normal' in patch) {
      if (!['attack','defense','scout','accusation','heal'].includes(next.normal)) next.normalTargetId = null;
      if (next.normal !== 'accusation') {
        next.accusationGuess = null;
        next.secondAccusationGuess = null;
      }
      if (!['scout','accusation'].includes(next.normal)) {
        next.secondNormalTargetId = null;
        next.secondAccusationGuess = null;
      }
    }
    if (!next.normal && next.special === 'double') next.special = null;
    if ('special' in patch) {
      if (!['cancel','specify','steal'].includes(next.special)) next.specialTargetId = null;
      if (next.special !== 'specify') next.specifiedType = null;
      if (next.special !== 'double') {
        next.secondNormalTargetId = null;
        next.secondAccusationGuess = null;
      }
    }

    const request = { draft: next, phaseSeq: state.phaseSeq };
    let res = await emitAck('setDraft', request);
    // setDraftは同じdraftを代入する冪等操作。ACKだけ落ちた場合は同一内容を1度再送し、
    // サーバーだけ選択が進んでクライアントが古いdraftのままになるズレを減らす。
    if (res?.transient && state?.phaseSeq === requestedPhaseSeq) res = await emitAck('setDraft', request);
    if (!res.ok) {
      toast(res.message);
      return;
    }
    if (res.draft && state?.me && state.phaseSeq === requestedPhaseSeq) {
      state.me.draft = { ...res.draft };
      // setDraftごとの巨大snapshot再送をやめたため、本人の仮選択UIだけを局所更新する。
      if (state.phase === 'chat') renderActionComposer($('#draftComposer'), false);
    }
  });
  return draftUpdateChain;
}

function renderInventory() {
  const box = $('#inventory');
  const me = state.me;
  box.replaceChildren();
  if (!me) return;

  const title1 = document.createElement('h4'); title1.textContent = '通常カード'; box.appendChild(title1);
  for (const [key, def] of Object.entries(state.normalCards || {})) {
    const row = document.createElement('div'); row.className = 'shopRow';
    const text = document.createElement('span'); text.textContent = `${def.label}　${me.hand[key] || 0}枚`;
    const buy = document.createElement('button'); buy.type = 'button'; buy.textContent = `${def.price}P`;
    const normalInsufficient = me.points < def.price;
    buy.disabled = state.phase !== 'chat' || !me.alive || me.ready || me.normalPurchasedThisTurn || normalInsufficient;
    if (normalInsufficient) buy.textContent = 'ポイント不足';
    buy.addEventListener('click', async () => {
      buy.disabled = true;
      const res = await emitMutation('buy', { type: key, phaseSeq: state.phaseSeq });
      if (!res.ok) { toast(res.message); buy.disabled = false; }
    });
    row.append(text, buy); box.appendChild(row);
  }

  const title2 = document.createElement('h4'); title2.textContent = '特殊カード'; box.appendChild(title2);
  for (const [key, def] of Object.entries(state.specialCards || {})) {
    const row = document.createElement('div'); row.className = 'invRow';
    const text = document.createElement('span'); text.textContent = def.label;
    const count = document.createElement('b'); count.textContent = `${me.specials[key] || 0}枚`;
    row.append(text, count); box.appendChild(row);
  }
  const specialBuy = document.createElement('div'); specialBuy.className = 'shopRow';
  const text = document.createElement('span'); text.textContent = '特殊カード（ランダム）';
  const specialPrice = Number(state.rules?.specialPurchasePrice ?? 45);
  const buy = document.createElement('button'); buy.type = 'button'; buy.textContent = `${specialPrice}P`;
  const specialInsufficient = me.points < specialPrice;
  buy.disabled = state.phase !== 'chat' || !me.alive || me.ready || me.specialPurchased || specialInsufficient;
  if (specialInsufficient) buy.textContent = 'ポイント不足';
  buy.addEventListener('click', async () => {
    buy.disabled = true;
    const res = await emitMutation('buy', { type: 'special', phaseSeq: state.phaseSeq });
    if (!res.ok) { toast(res.message); buy.disabled = false; }
  });
  specialBuy.append(text, buy); box.appendChild(specialBuy);
  const note = document.createElement('div'); note.className = 'microNote';
  note.textContent = me.specialPurchased ? '特殊カード：購入済み（追加購入不可）' : '特殊カード購入：1試合1回まで';
  box.appendChild(note);
}

function renderTrade() {
  const box = $('#tradeBox');
  const me = state.me;
  box.replaceChildren();
  if (!me) return;
  const others = otherAlivePlayers();
  const disabled = state.phase !== 'chat' || !me.alive || me.ready || others.length === 0;
  const exchanges = me.exchanges || { incoming: [], outgoing: [] };
  const targetOptions = [['', '相手を選択'], ...others.map(p => [p.playerId, colorLabel(p)])];
  const hasValue = (options, value) => options.some(([v]) => v === value);
  const bundleText = bundle => {
    const parts = [];
    if (Number(bundle?.points || 0) > 0) parts.push(`${Number(bundle.points)}P`);
    if (bundle?.card) parts.push(`「${bundle.card.cardLabel || (bundle.card.special ? specialLabel(bundle.card.type) : cardLabel(bundle.card.type))}」1枚`);
    return parts.join('＋') || 'なし';
  };

  const pending = document.createElement('div');
  pending.className = 'transferRequests';
  if (exchanges.incoming?.length) {
    const title = document.createElement('h4'); title.textContent = '受信した交換提案'; pending.appendChild(title);
    for (const req of exchanges.incoming) {
      const row = document.createElement('div'); row.className = 'transferRequest incoming exchangeRequest';
      const text = document.createElement('span'); text.textContent = `${req.fromColor}：${bundleText(req.offer)} ⇔ あなた：${bundleText(req.request)}`;
      const actions = document.createElement('div'); actions.className = 'transferRequestActions';
      const accept = document.createElement('button'); accept.type='button'; accept.className='ghost'; accept.textContent='交換する'; accept.disabled = state.phase !== 'chat' || me.ready;
      const reject = document.createElement('button'); reject.type='button'; reject.className='ghost'; reject.textContent='拒否'; reject.disabled = state.phase !== 'chat' || me.ready;
      accept.addEventListener('click', async () => {
        accept.disabled = reject.disabled = true;
        const res = await emitMutation('respondExchange', { requestId:req.requestId, accept:true, phaseSeq:state.phaseSeq });
        if (!res.ok) { toast(res.message); accept.disabled = reject.disabled = false; }
      });
      reject.addEventListener('click', async () => {
        accept.disabled = reject.disabled = true;
        const res = await emitMutation('respondExchange', { requestId:req.requestId, accept:false, phaseSeq:state.phaseSeq });
        if (!res.ok) { toast(res.message); accept.disabled = reject.disabled = false; }
      });
      actions.append(accept, reject); row.append(text, actions); pending.appendChild(row);
    }
  }
  if (exchanges.outgoing?.length) {
    const title = document.createElement('h4'); title.textContent = '交換提案中'; pending.appendChild(title);
    for (const req of exchanges.outgoing) {
      const row = document.createElement('div'); row.className = 'transferRequest outgoing exchangeRequest';
      const text = document.createElement('span'); text.textContent = `${req.toColor}へ：${bundleText(req.offer)} ⇔ ${bundleText(req.request)}（承認待ち）`;
      const cancel = document.createElement('button'); cancel.type='button'; cancel.className='ghost'; cancel.textContent='取消'; cancel.disabled = state.phase !== 'chat';
      cancel.addEventListener('click', async () => {
        cancel.disabled = true;
        const res = await emitMutation('cancelExchange', { requestId:req.requestId, phaseSeq:state.phaseSeq });
        if (!res.ok) { toast(res.message); cancel.disabled = false; }
      });
      row.append(text, cancel); pending.appendChild(row);
    }
  }
  if (pending.childElementCount) {
    const note = document.createElement('div'); note.className = 'microNote'; note.textContent = '未処理の交換提案がある間は「次へ」に進めません。ターン終了時は自動キャンセルされます。';
    pending.appendChild(note); box.appendChild(pending);
  }

  const exchangeBlock = document.createElement('div'); exchangeBlock.className = 'tradeBlock exchangeBlock';
  const exchangeTitle = document.createElement('h4'); exchangeTitle.textContent = '交換'; exchangeBlock.appendChild(exchangeTitle);
  const exchangeTargetInitial = hasValue(targetOptions, tradeUi.exchangeTarget) ? tradeUi.exchangeTarget : '';
  const exchangeTarget = makeSelect(targetOptions, exchangeTargetInitial, value => { tradeUi.exchangeTarget = value; }, disabled || exchanges.outgoing?.length > 0);

  const protectedForcedType = me.forcedNormalType?.turn === state.turn && !me.forcedNormalType?.conflict ? me.forcedNormalType.type : null;
  const ownedNormal = Object.entries(state.normalCards || {}).filter(([k]) => (me.hand[k] || 0) > 0 && !(k === protectedForcedType && (me.hand[k] || 0) <= 1)).map(([k,d]) => [k,d.label]);
  const ownedSpecial = Object.entries(state.specialCards || {}).filter(([k]) => (me.specials[k] || 0) > 0).map(([k,d]) => [k,d.label]);
  const allNormal = Object.entries(state.normalCards || {}).map(([k,d]) => [k,d.label]);
  const allSpecial = Object.entries(state.specialCards || {}).map(([k,d]) => [k,d.label]);

  function makeCardBundleControls(prefix, ownedOnly) {
    const wrap = document.createElement('div'); wrap.className='exchangeSide';
    const label = document.createElement('b'); label.textContent = prefix === 'offer' ? '自分が出す' : '相手に求める'; wrap.appendChild(label);
    const points = document.createElement('input'); points.type='number'; points.inputMode='numeric'; points.min='0'; points.step='5';
    if (ownedOnly) points.max = String(Math.max(0, me.points));
    const currentPoints = Number(tradeUi[`${prefix}Points`]);
    points.value = Number.isInteger(currentPoints) && currentPoints >= 0 && currentPoints % 5 === 0 ? String(currentPoints) : '0';
    points.placeholder='ポイント 0P〜（5P刻み）'; points.disabled = disabled || exchanges.outgoing?.length > 0;
    points.addEventListener('input', () => { tradeUi[`${prefix}Points`] = points.value; });
    const kindKey = `${prefix}Kind`, typeKey = `${prefix}Type`;
    const kind = makeSelect([['none','0枚（カードなし）'],['normal','通常カード1枚'],['special','特殊カード1枚']], ['none','normal','special'].includes(tradeUi[kindKey]) ? tradeUi[kindKey] : 'none', value => { tradeUi[kindKey]=value; rebuild(); }, disabled || exchanges.outgoing?.length > 0);
    const type = document.createElement('select'); type.disabled = disabled || exchanges.outgoing?.length > 0;
    function rebuild() {
      type.replaceChildren();
      const source = kind.value === 'normal' ? (ownedOnly ? ownedNormal : allNormal) : kind.value === 'special' ? (ownedOnly ? ownedSpecial : allSpecial) : [];
      if (kind.value === 'none') {
        const o=document.createElement('option'); o.value=''; o.textContent='0枚（カードなし）'; type.appendChild(o); type.disabled=true; tradeUi[typeKey]=''; return;
      }
      if (!source.length) {
        const o=document.createElement('option'); o.value=''; o.textContent=ownedOnly ? '出せるカードなし' : '0枚（カードなし）'; type.appendChild(o); type.disabled=true; tradeUi[typeKey]=''; return;
      }
      for (const [v,l] of source) { const o=document.createElement('option'); o.value=v; o.textContent=l; type.appendChild(o); }
      type.value = source.some(([v]) => v === tradeUi[typeKey]) ? tradeUi[typeKey] : source[0][0];
      tradeUi[typeKey]=type.value; type.disabled = disabled || exchanges.outgoing?.length > 0;
    }
    type.addEventListener('change', () => { tradeUi[typeKey]=type.value; });
    rebuild(); wrap.append(points, kind, type); return { wrap, points, kind, type };
  }
  const offerControls = makeCardBundleControls('offer', true);
  const requestControls = makeCardBundleControls('request', false);
  const sendExchange = document.createElement('button'); sendExchange.type='button'; sendExchange.className='ghost'; sendExchange.textContent = exchanges.outgoing?.length ? '交換提案中' : '交換を提案'; sendExchange.disabled = disabled || exchanges.outgoing?.length > 0;
  sendExchange.addEventListener('click', async () => {
    const offerPoints = Number(offerControls.points.value || 0), requestPoints = Number(requestControls.points.value || 0);
    const offerCardType = offerControls.kind.value === 'none' ? '' : offerControls.type.value;
    const requestCardType = requestControls.kind.value === 'none' ? '' : requestControls.type.value;
    if (!exchangeTarget.value) return toast('交換相手を選択してください。');
    if (![offerPoints, requestPoints].every(n => Number.isInteger(n) && n >= 0 && n % 5 === 0)) return toast('ポイントは0Pまたは5P刻みで指定してください。');
    if (offerPoints > state.me.points) return toast('交換に出すポイントが不足しています。');
    if (!(offerPoints > 0 || offerCardType || requestPoints > 0 || requestCardType)) return toast('交換内容が空です。少なくともどちらか一方にポイントまたはカードを指定してください。');
    tradeUi.exchangeTarget=exchangeTarget.value; tradeUi.offerPoints=offerControls.points.value; tradeUi.requestPoints=requestControls.points.value;
    sendExchange.disabled=true;
    const res = await emitMutation('createExchange', {
      toId:exchangeTarget.value,
      offerPoints,
      offerCardType,
      offerCardSpecial:offerControls.kind.value === 'special',
      requestPoints,
      requestCardType,
      requestCardSpecial:requestControls.kind.value === 'special',
      phaseSeq:state.phaseSeq
    });
    if (!res.ok) { toast(res.message); sendExchange.disabled=false; }
    else toast('交換を提案しました。');
  });
  exchangeBlock.append(exchangeTarget, offerControls.wrap, requestControls.wrap, sendExchange);
  const exchangeNote = document.createElement('div'); exchangeNote.className='microNote'; exchangeNote.textContent='双方ともポイント0P・カード0枚を選択可能。片側だけ資産を出す提案もでき、相手が承認すれば無償提供として成立します。両側とも0P・0枚だけの空交換は不可。ターン消費なし。'; exchangeBlock.appendChild(exchangeNote);
  box.appendChild(exchangeBlock);
}

function renderPublicContracts() {
  const box = $('#contractControls');
  if (!box || !state?.me) return;
  box.replaceChildren();
  const me = state.me;
  const contracts = Array.isArray(state.publicContracts) ? state.publicContracts : [];
  const list = document.createElement('div'); list.className='contractList';
  if (!contracts.length) {
    const empty=document.createElement('div'); empty.className='microNote'; empty.textContent='現在の公開契約はありません。'; list.appendChild(empty);
  } else {
    for (const c of contracts) {
      const row=document.createElement('div'); row.className=`contractRow ${c.status}`;
      const condition = c.conditionType === 'attackTarget'
        ? `第${c.dueTurn}Tに${c.subjectColor}を攻撃`
        : c.conditionType === 'dontAttackIssuer'
          ? `第${c.dueTurn}Tに${c.issuerColor}を攻撃しない`
          : c.conditionType === 'defendIssuer'
            ? `第${c.dueTurn}Tに${c.issuerColor}を防御`
            : `第${c.dueTurn}Tに${c.subjectColor}を告発（成否不問）`;
      const participants = Array.isArray(c.acceptorColors) && c.acceptorColors.length ? ` / 参加：${c.acceptorColors.join('・')}` : ' / 参加：なし';
      const text=document.createElement('span'); text.textContent=`${c.issuerColor}：${condition} / 契約${c.reward}P / 達成1人${c.rewardPerPlayer || Math.floor(c.reward/5)}P${participants}`;
      row.appendChild(text);
      const joined = Array.isArray(c.acceptorIds) && c.acceptorIds.includes(me.playerId);
      if (c.status === 'open' && c.issuerId !== me.playerId && !joined) {
        const accept=document.createElement('button'); accept.type='button'; accept.className='ghost'; accept.textContent='参加'; accept.disabled=state.phase!=='chat' || me.ready || !me.alive || c.createdTurn!==state.turn;
        accept.addEventListener('click', async()=>{ accept.disabled=true; const res=await emitMutation('acceptPublicContract',{contractId:c.contractId,phaseSeq:state.phaseSeq}); if(!res.ok){toast(res.message);accept.disabled=false;} });
        row.appendChild(accept);
      } else if (c.status === 'open' && joined) {
        const joinedTag=document.createElement('b'); joinedTag.className='contractJoined'; joinedTag.textContent='参加済み'; row.appendChild(joinedTag);
      } else if (c.status === 'open' && c.issuerId === me.playerId) {
        const cancel=document.createElement('button'); cancel.type='button'; cancel.className='ghost'; cancel.textContent='取消'; cancel.disabled=state.phase!=='chat' || (Array.isArray(c.acceptorIds) && c.acceptorIds.length>0);
        cancel.addEventListener('click', async()=>{ cancel.disabled=true; const res=await emitMutation('cancelPublicContract',{contractId:c.contractId,phaseSeq:state.phaseSeq}); if(!res.ok){toast(res.message);cancel.disabled=false;} });
        row.appendChild(cancel);
      }
      list.appendChild(row);
    }
  }
  box.appendChild(list);

  const canPost = state.status==='playing' && state.phase==='chat' && me.alive && !me.ready && state.turn < state.maxTurns && !contracts.some(c => c.issuerId===me.playerId && ['open','accepted'].includes(c.status));
  const creator=document.createElement('div'); creator.className='contractCreator';
  const myColor = colorLabel(state.players.find(p=>p.playerId===me.playerId));
  const type=makeSelect([
    ['attackTarget','次ターン、指定した色を攻撃したら報酬'],
    ['dontAttackIssuer',`次ターン、${myColor}を攻撃しなければ報酬`],
    ['defendIssuer',`次ターン、${myColor}を防御したら報酬`],
    ['accuseTarget','次ターン、指定した色を告発したら報酬（成功・失敗どちらでも可）']
  ], contractUi.conditionType, value=>{contractUi.conditionType=value; renderPublicContracts();}, !canPost);
  const needsSubject = ['attackTarget','accuseTarget'].includes(type.value);
  const targetOptions=[['',type.value==='accuseTarget'?'告発する色を選択':'攻撃する色を選択'],...otherAlivePlayers().map(p=>[p.playerId,colorLabel(p)])];
  const subject=makeSelect(targetOptions, targetOptions.some(([v])=>v===contractUi.subjectId)?contractUi.subjectId:'', value=>{contractUi.subjectId=value;}, !canPost || !needsSubject);
  if (!needsSubject) subject.classList.add('hidden');
  const reward=document.createElement('input'); reward.type='number'; reward.inputMode='numeric'; reward.min='25'; reward.step='25'; reward.max=String(Math.max(25,me.points)); reward.value=(Number(contractUi.reward)>=25 && Number(contractUi.reward)%25===0)?String(contractUi.reward):(me.points>=25?'25':''); reward.placeholder='契約ポイント 25P刻み'; reward.disabled=!canPost || me.points<25; reward.addEventListener('input',()=>{contractUi.reward=reward.value;});
  const post=document.createElement('button'); post.type='button'; post.className='ghost'; post.textContent='公開契約を出す'; post.disabled=!canPost || me.points<25;
  post.addEventListener('click', async()=>{
    const n=Number(reward.value); if(!Number.isInteger(n)||n<25||n%25!==0||n>state.me.points) return toast('契約ポイントは所持P以内の25P刻みで指定してください。');
    if(type.value==='attackTarget' && !subject.value) return toast('攻撃する色を選択してください。');
    if(type.value==='accuseTarget' && !subject.value) return toast('告発する色を選択してください。');
    post.disabled=true; const res=await emitMutation('postPublicContract',{conditionType:type.value,subjectId:subject.value||null,reward:n,phaseSeq:state.phaseSeq});
    if(!res.ok){toast(res.message);post.disabled=false;} else toast('公開契約を提示しました。');
  });
  creator.append(type, subject, reward, post);
  const note=document.createElement('div'); note.className='microNote'; note.textContent='25P刻みで預けます。25Pなら達成者1人5P、50Pなら1人10P。複数人参加可。未参加・未達成分など余ったポイントは契約を出した色へ返却。ターン消費なし。'; creator.appendChild(note);
  box.appendChild(creator);
}

function renderWinnerBet() {
  const box = $('#winnerBetControls');
  if (!box || !state?.me) return;
  box.replaceChildren();
  const me = state.me;
  const bet = me.winnerBet;
  if (bet) {
    const target = state.players.find(p => p.playerId === bet.targetId);
    const card = document.createElement('div'); card.className = 'winnerBetStatus';
    const title = document.createElement('b'); title.textContent = `予想：${target ? colorLabel(target) : '不明'}`;
    const meta = document.createElement('span'); meta.textContent = `第${bet.placedTurn}ターン / ${bet.amount}P / 的中時 ${bet.multiplier}倍`;
    const note = document.createElement('small'); note.textContent = '予想は確定済みです。ゲーム終了時に払戻し前順位で判定します。';
    card.append(title, meta, note); box.appendChild(card); return;
  }
  const rules = state.rules?.winnerBet || { allowedTurns:[3,6,9], multipliers:{ 3:10, 6:5, 9:2.5 }, step:5 };
  const allowedTurns = Array.isArray(rules.allowedTurns) ? rules.allowedTurns.map(Number) : [3,6,9];
  const multiplier = Number(rules.multipliers?.[state.turn]);
  const open = state.status === 'playing' && state.phase === 'chat' && me.alive && allowedTurns.includes(state.turn) && !me.ready;
  const intro = document.createElement('div'); intro.className = 'winnerBetIntro';
  intro.textContent = open ? `第${state.turn}ターン：的中時 ${multiplier}倍` : state.turn < 3 ? '第3・6・9ターンに1回だけ賭けられます。' : state.turn > 9 ? '受付は第9ターンで終了しました。' : 'このターンは1位予想を受け付けていません。';
  box.appendChild(intro);
  const targetOptions = state.players.filter(p => p.color).map(p => [p.playerId, colorLabel(p)]);
  const validTarget = targetOptions.some(([id]) => id === winnerBetUi.targetId) ? winnerBetUi.targetId : (me.playerId || targetOptions[0]?.[0] || '');
  winnerBetUi.targetId = validTarget;
  const target = makeSelect(targetOptions, validTarget, value => { winnerBetUi.targetId = value; }, !open);
  const amount = document.createElement('input'); amount.type='number'; amount.inputMode='numeric'; amount.min=String(rules.step || 5); amount.step=String(rules.step || 5); amount.max=String(Math.max(rules.step || 5, me.points));
  const remembered = Number(winnerBetUi.amount);
  amount.value = me.points >= (rules.step || 5) && Number.isInteger(remembered) && remembered >= (rules.step || 5) && remembered <= me.points && remembered % (rules.step || 5) === 0 ? String(remembered) : (me.points >= (rules.step || 5) ? String(rules.step || 5) : '');
  amount.placeholder = me.points >= (rules.step || 5) ? '5P刻み・所持Pまで' : 'ポイント不足';
  amount.disabled = !open || me.points < (rules.step || 5);
  amount.addEventListener('input', () => { winnerBetUi.amount = amount.value; });
  const send = document.createElement('button'); send.type='button'; send.className='ghost winnerBetButton'; send.textContent='この予想で賭ける'; send.disabled = !open || me.points < (rules.step || 5);
  send.addEventListener('click', async () => {
    const n = Number(amount.value);
    if (!winnerBetUi.targetId || !Number.isInteger(n) || n < (rules.step || 5) || n % (rules.step || 5) !== 0 || n > state.me.points) return toast('予想相手と5P刻みの賭けポイントを正しく指定してください。');
    send.disabled = true;
    const res = await emitMutation('placeWinnerBet', { targetId:winnerBetUi.targetId, amount:n, phaseSeq:state.phaseSeq });
    if (!res.ok) { toast(res.message); send.disabled = false; return; }
    toast(`1位予想を確定しました。`);
  });
  const note = document.createElement('small'); note.className='microNote'; note.textContent='1試合1回。賭けPは即時差引。3Tは10倍、6Tは5倍、9Tは2.5倍。';
  box.append(target, amount, send, note);
}

function renderPreviousResult() {
  const card = $('#previousResultCard');
  const box = $('#previousResultSummary');
  const turnEl = $('#previousResultTurn');
  if (!card || !box || !turnEl) return;
  const r = state?.lastResult;
  const visible = !!r && state?.status === 'playing' && state?.phase !== 'result';
  card.classList.toggle('hidden', !visible);
  if (!visible) { box.replaceChildren(); return; }

  turnEl.textContent = `第${r.turn}ターン`;
  box.replaceChildren();
  const groups = [
    ['結果', (r.items || []).map(text => ({ text, tone:'private' }))]
  ];
  for (const [label, entries] of groups) {
    if (!entries.length) continue;
    const group = document.createElement('div');
    group.className = 'previousResultGroup';
    const head = document.createElement('b');
    head.textContent = label;
    group.appendChild(head);
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = `previousResultItem ${entry.tone}`;
      row.textContent = entry.text;
      group.appendChild(row);
    }
    box.appendChild(group);
  }
  if (!box.childElementCount) {
    const empty = document.createElement('div');
    empty.className = 'microNote';
    empty.textContent = '大きな変化はありませんでした。';
    box.appendChild(empty);
  }
}

function renderScoutReports() {
  const box = $('#scoutReports');
  const reports = [...(state.me?.scoutReports || [])].reverse();
  const key = reports.map(report => {
    const hand = SCOUT_VISIBLE_NORMAL_KEYS.map(k => `${k}:${report.hand?.[k] || 0}`).join(',');
    return `${report.turn}:${report.color}:${report.hp}:${report.kills}:${hand}`;
  }).join('|');
  if (key === renderedScoutKey) return;
  renderedScoutKey = key;
  box.replaceChildren();

  if (!reports.length) {
    const empty = document.createElement('div');
    empty.className = 'microNote';
    empty.textContent = 'まだ偵察結果はありません。偵察では、相手のHP・キル数・通常カードだけ確認できます。特殊カード・ポイント・秘密目標は見えません。';
    box.appendChild(empty);
    return;
  }

  reports.forEach((report, index) => {
    const item = document.createElement('details');
    item.className = 'scoutReport scoutIntelCard';
    item.open = index === 0;

    const summary = document.createElement('summary');
    summary.className = 'scoutSummary';
    const summaryMeta = document.createElement('div');
    summaryMeta.className = 'scoutSummaryMeta';
    const tag = document.createElement('span');
    tag.className = 'scoutTurnTag';
    tag.textContent = `第${report.turn}ターン`;
    const color = document.createElement('b');
    color.textContent = report.color;
    summaryMeta.append(tag, color);
    const intel = document.createElement('span');
    intel.className = 'scoutIntelLabel';
    intel.textContent = '偵察結果';
    summary.append(summaryMeta, intel);

    const body = document.createElement('div');
    body.className = 'reportBody scoutBoard';

    const stats = document.createElement('div');
    stats.className = 'scoutStatStrip';
    const hp = document.createElement('div');
    hp.className = 'scoutStat';
    const hpLabel = document.createElement('span');
    hpLabel.textContent = 'HP';
    const hpValue = document.createElement('b');
    hpValue.textContent = String(report.hp);
    hp.append(hpLabel, hpValue);

    const kills = document.createElement('div');
    kills.className = 'scoutStat';
    const killsLabel = document.createElement('span');
    killsLabel.textContent = 'キル数';
    const killsValue = document.createElement('b');
    killsValue.textContent = String(report.kills);
    kills.append(killsLabel, killsValue);

    const note = document.createElement('div');
    note.className = 'scoutStat scoutNote';
    const noteLabel = document.createElement('span');
    noteLabel.textContent = '確認できる情報';
    const noteValue = document.createElement('b');
    noteValue.textContent = 'HP・キル・通常カード';
    note.append(noteLabel, noteValue);
    stats.append(hp, kills, note);

    const handWrap = document.createElement('div');
    handWrap.className = 'scoutHandWrap';
    const handTitle = document.createElement('div');
    handTitle.className = 'scoutBoardTitle';
    handTitle.textContent = '通常カード';
    const handGrid = document.createElement('div');
    handGrid.className = 'scoutMiniGrid';
    for (const cardKey of SCOUT_VISIBLE_NORMAL_KEYS) {
      handGrid.appendChild(createScoutCardThumb(cardKey, report.hand?.[cardKey] || 0));
    }
    handWrap.append(handTitle, handGrid);

    const hiddenWrap = document.createElement('div');
    hiddenWrap.className = 'scoutHiddenWrap';
    const hiddenTitle = document.createElement('div');
    hiddenTitle.className = 'scoutBoardTitle';
    hiddenTitle.textContent = '特殊カード';
    const hiddenPanel = document.createElement('div');
    hiddenPanel.className = 'scoutHiddenPanel';
    const hiddenTop = document.createElement('div');
    hiddenTop.className = 'scoutHiddenTop';
    const hiddenTag = document.createElement('span');
    hiddenTag.textContent = '非公開情報';
    const hiddenState = document.createElement('b');
    hiddenState.textContent = '閲覧不可';
    hiddenTop.append(hiddenTag, hiddenState);
    const slots = document.createElement('div');
    slots.className = 'scoutHiddenSlots';
    for (let i = 0; i < 5; i++) slots.appendChild(document.createElement('span'));
    const hiddenNote = document.createElement('p');
    hiddenNote.textContent = '特殊カード・ポイント・秘密目標は偵察では確認できません。';
    hiddenPanel.append(hiddenTop, slots, hiddenNote);
    hiddenWrap.append(hiddenTitle, hiddenPanel);

    body.append(stats, handWrap, hiddenWrap);
    item.append(summary, body);
    box.appendChild(item);
  });
}

function appendRankingRows(box, rows) {
  box.replaceChildren();
  for (const row of rows || []) {
    const item = document.createElement('div');
    item.className = `rankRow${row.playerId === state.me?.playerId ? ' me' : ''}`;
    const rank = document.createElement('b'); rank.textContent = `#${row.rank}`;
    const who = document.createElement('div');
    const title = document.createElement('b'); title.textContent = row.color;
    const objective = document.createElement('div'); objective.className='muted'; objective.textContent = `秘密目標：${row.objective}${row.objectiveInvalid ? '（無効）' : row.objectiveAchieved ? '（達成）' : '（未達成）'}`;
    who.append(title, objective);
    const kill = document.createElement('div'); kill.className='hideMobile'; kill.textContent = `キル ${row.kills}`;
    const hp = document.createElement('div'); hp.className='hideMobile'; hp.textContent = `HP ${row.hp}`;
    const points = document.createElement('b'); points.textContent = `${row.points}P`;
    item.append(rank, who, kill, hp, points); box.appendChild(item);
  }
}

function renderRanking() {
  stopTimer();
  const preRows = state.preBetRanking || state.finishedRanking || [];
  const finalRows = state.finishedRanking || preRows;
  appendRankingRows($('#preBetRanking'), preRows);
  appendRankingRows($('#ranking'), finalRows);
  if (!finalRows.length) {
    const box=$('#ranking'); if (box) { const empty=document.createElement('div'); empty.className='microNote'; empty.textContent='最終順位を読み込めませんでした。再接続すると復元されます。'; box.appendChild(empty); }
  }
  window.scrollTo?.({ top:0, behavior:'instant' });
  $('#postBetStage')?.classList.remove('hidden');
  const bets = $('#winnerBetResults');
  bets.replaceChildren();
  const results = state.winnerBetResults || [];
  if (!results.length) {
    const empty = document.createElement('div'); empty.className='microNote'; empty.textContent='1位予想の参加者はいません。'; bets.appendChild(empty);
  } else {
    for (const result of results) {
      const row = document.createElement('div'); row.className = `betResultRow ${result.hit ? 'hit' : 'miss'}`;
      const who = document.createElement('b'); who.textContent = result.color || '—';
      const prediction = document.createElement('span'); prediction.textContent = `→ ${result.targetColor}  ${result.amount}P × ${result.multiplier}`;
      const outcome = document.createElement('strong'); outcome.textContent = result.hit ? `的中 +${result.payout}P` : '不的中 +0P';
      row.append(who, prediction, outcome); bets.appendChild(row);
    }
  }
}

// 招待URL（#room=XXXXXXXX。旧?room=も互換対応）で開いた場合は、接続を始めず参加欄だけ事前入力する。
prepareInviteFromUrl();

// 復帰トークンがある時だけ初期接続する。ホームを眺めているだけの訪問者は
// WebSocket接続枠を消費しない。手動参加時はemitAck→ensureSocketConnectedで接続する。
if (resumeTokenCandidate()) socket.connect();

// 復帰トークンはブラウザ共通で保持し、タブを閉じた後も再接続できる。
// 同じブラウザからの二重参加はbrowserIdをサーバー側で拒否する。
