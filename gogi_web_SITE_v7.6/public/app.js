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
const tradeUi = { cardTarget:'', kind:'normal', cardType:'', pointTarget:'', pointAmount:'5' };
const infoUi = { recipient:'', subject:'', kind:'hp', values:{} };
let draftUpdateChain = Promise.resolve();
let operationCounter = 0;
let sessionReadyPromise = Promise.resolve();
let chatSending = false;
let infoSending = false;
let renderedChatKey = '';
let renderedLogsKey = '';
let renderedScoutKey = '';
let cardArtPreloaded = false;
let lastPhaseNavigationSeq = null;
function stopTimer() { if (timerHandle) clearInterval(timerHandle); timerHandle = null; }
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
function cardLabel(key) { return state?.normalCards?.[key]?.label || key || 'なし'; }
function specialLabel(key) { return state?.specialCards?.[key]?.label || key || 'なし'; }

const ASSET_REV = '20260911cardsExact';
const CARD_VISUALS = {
  attack: { image: `/cards/attack.webp?v=${ASSET_REV}`, effect: '相手1人に1ダメージ' },
  defense: { image: `/cards/defense.webp?v=${ASSET_REV}`, effect: '受ける攻撃を1ダメージ防ぐ' },
  scout: { image: `/cards/scout.webp?v=${ASSET_REV}`, effect: '相手1人のHP・キル数・通常カードを確認' },
  accusation: { image: `/cards/accusation.webp?v=${ASSET_REV}`, effect: '相手1人の秘密目標を予想して告発' },
  heal: { image: `/cards/heal.webp?v=${ASSET_REV}`, effect: 'HPを2回復する' },
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
$$('[data-tool-target]').forEach(btn => btn.addEventListener('click', () => {
  const drawer = $('#toolDrawer');
  if (!drawer) return;
  for (const child of drawer.querySelectorAll('.inventory,.transfer,.scoutBox,.previousResult')) child.classList.add('toolHidden');
  drawer.querySelector('.' + btn.dataset.toolTarget)?.classList.remove('toolHidden');
  drawer.classList.add('open');
}));
$('#toolClose')?.addEventListener('click', closeToolDrawer);
$('#openInfoStatement')?.addEventListener('click', () => {
  const box = document.querySelector('.infoBox');
  if (!box) return;
  box.open = true;
  box.classList.add('infoOverlay');
});
document.querySelector('.infoBox')?.addEventListener('toggle', e => {
  if (!e.currentTarget.open) e.currentTarget.classList.remove('infoOverlay');
});

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
  $('#chatModeLabel').textContent = $('#chatTarget').value ? '個別' : '全体';
});
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
  if (next.resumeToken) setSession(next.resumeToken, { forceShared: manualJoinInFlight });
  if (Number.isFinite(next.serverNow)) clockOffsetMs = next.serverNow - Date.now();
  const sameRoom = !!(state?.roomId && next?.roomId && state.roomId === next.roomId);
  if (!sameRoom) { renderedChatKey = ''; renderedLogsKey = ''; renderedScoutKey = ''; lastMessageIds.clear(); lastPhaseNavigationSeq = null; }
  // 定義カタログはSocket初回stateだけ届く。以後の軽量stateでは既存値を保持する。
  for (const key of ['normalCards','specialCards','objectives','rules']) {
    if (!Object.prototype.hasOwnProperty.call(next, key) && state?.[key] != null) next[key] = state[key];
  }
  // 通常stateは軽量化のため履歴を含めない。既存履歴を保持し、再接続時の
  // includeHistory snapshotだけを完全な正として置き換える。
  if (!Object.prototype.hasOwnProperty.call(next || {}, 'chat')) next.chat = sameRoom ? (state?.chat || []) : [];
  if (!Object.prototype.hasOwnProperty.call(next || {}, 'logs')) next.logs = sameRoom ? (state?.logs || []) : [];
  state = next;
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
  appendMessage(message);
  lastMessageIds.add(message.id);
  renderedChatKey = historyKey(state?.chat || []);
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
  renderScoutReports();
  renderPreviousResult();
  renderInfoStatementControls();
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
    if (!p.connected) flags.push('切断');
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

function renderChat() {
  renderChatTarget();
  const box = $('#messages');
  const messages = state.chat || [];
  const nextKey = historyKey(messages);
  if (nextKey !== renderedChatKey) {
    const distanceFromBottom = box.scrollHeight - box.scrollTop - box.clientHeight;
    const keepAtBottom = distanceFromBottom < 48;
    const previousTop = box.scrollTop;
    box.replaceChildren();
    lastMessageIds = new Set();
    for (const message of messages) {
      appendMessage(message, false);
      if (message.id) lastMessageIds.add(message.id);
    }
    renderedChatKey = nextKey;
    if (keepAtBottom) box.scrollTop = box.scrollHeight;
    else box.scrollTop = Math.min(previousTop, Math.max(0, box.scrollHeight - box.clientHeight));
  }
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
    option.textContent = `${colorLabel(p)}へ個別`;
    select.appendChild(option);
  }
  if ([...select.options].some(o => o.value === previous)) select.value = previous;
  $('#chatModeLabel').textContent = select.value ? '個別' : '全体';
}

function appendMessage(message, autoScroll = true) {
  const box = $('#messages');
  if (!box) return;
  // 追加後ではなく追加前の位置で判定する。長文1件でscrollHeightが大きく増えても、
  // もともと最下部を読んでいた利用者は新着へ追従できる。
  const distanceBefore = box.scrollHeight - box.scrollTop - box.clientHeight;
  const shouldStickToBottom = autoScroll && distanceBefore < 120;
  const row = document.createElement('div');
  row.className = `msg${message.toId ? ' private' : ''}${message.structured ? ' structured' : ''}`;
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = message.fromColor || '？';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  const prefix = message.toId ? `→${message.toColor || '個別'} ` : '';
  bubble.textContent = `${prefix}${message.text || ''}`;
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
  }
}

function renderResultSummary() {
  const box = $('#resultSummary');
  if (!box) return;
  box.replaceChildren();
  const r = state.lastResult;
  $('#resultTitle').textContent = r ? `第${r.turn}ターン 結果発表` : 'ターン結果発表';

  const publicItems = (r?.publicItems || []).map(text => ({ text, own:false, score:false }));
  const privateItems = (r?.privateItems || []).map(text => ({ text, own:true, score:false }));
  const scoreItems = (r?.scoreItems || []).map(score => ({
    text: `${score.reason}：${score.actual >= 0 ? '+' : ''}${score.actual}P`,
    own: true,
    score: true
  }));

  box.append(
    createResultSection('公開結果', 'public', publicItems),
    createResultSection('自分だけの結果', 'private', privateItems),
    createResultSection('ポイント増減', 'score', scoreItems)
  );
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
        : `カード指定：このターンの通常カードは「${cardLabel(me.forcedNormalType.type)}」固定`;
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

  if (['attack','scout','accusation'].includes(draft.normal)) {
    const targetBlock = document.createElement('div');
    targetBlock.className = 'fieldGrid';
    const label = document.createElement('label');
    label.innerHTML = '<span>通常カードの対象</span>';
    label.appendChild(makeSelect(playerOptions(), draft.normalTargetId, value => updateDraft({ normalTargetId: value || null }), disabled));
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
      if (!['attack','scout','accusation'].includes(next.normal)) next.normalTargetId = null;
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
  const buy = document.createElement('button'); buy.type = 'button'; buy.textContent = '50P';
  const specialInsufficient = me.points < 50;
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

  const targetOptions = [['', '相手を選択'], ...others.map(p => [p.playerId, colorLabel(p)])];
  const protectedForcedType = me.forcedNormalType?.turn === state.turn && !me.forcedNormalType?.conflict ? me.forcedNormalType.type : null;
  const normalCards = Object.entries(state.normalCards || {})
    .filter(([k]) => (me.hand[k] || 0) > 0 && !(k === protectedForcedType && (me.hand[k] || 0) <= 1))
    .map(([k,d]) => [k, d.label]);
  const specialCards = Object.entries(state.specialCards || {}).filter(([k]) => (me.specials[k] || 0) > 0).map(([k,d]) => [k, d.label]);
  const hasValue = (options, value) => options.some(([v]) => v === value);

  const cardBlock = document.createElement('div'); cardBlock.className = 'tradeBlock';
  const cardTargetInitial = hasValue(targetOptions, tradeUi.cardTarget) ? tradeUi.cardTarget : '';
  const cardTarget = makeSelect(targetOptions, cardTargetInitial, value => { tradeUi.cardTarget = value; }, disabled);
  const kindInitial = tradeUi.kind === 'special' ? 'special' : 'normal';
  const kind = makeSelect([['normal','通常カード'],['special','特殊カード']], kindInitial, value => { tradeUi.kind = value; rebuildCardOptions(); }, disabled);
  const cardType = document.createElement('select'); cardType.disabled = disabled;
  const sendCard = document.createElement('button'); sendCard.type = 'button'; sendCard.className = 'ghost'; sendCard.textContent = 'カードを1枚譲渡'; sendCard.disabled = disabled;
  function rebuildCardOptions() {
    cardType.replaceChildren();
    const source = kind.value === 'special' ? specialCards : normalCards;
    if (!source.length) {
      const o = document.createElement('option'); o.value = ''; o.textContent = 'カードが足りません'; cardType.appendChild(o);
      tradeUi.cardType = '';
      sendCard.disabled = true;
    } else {
      for (const [v,l] of source) { const o = document.createElement('option'); o.value=v; o.textContent=l; cardType.appendChild(o); }
      cardType.value = source.some(([v]) => v === tradeUi.cardType) ? tradeUi.cardType : source[0][0];
      tradeUi.cardType = cardType.value;
      sendCard.disabled = disabled;
    }
  }
  cardType.addEventListener('change', () => { tradeUi.cardType = cardType.value; });
  rebuildCardOptions();
  sendCard.addEventListener('click', async () => {
    if (!cardTarget.value || !cardType.value) return toast('相手とカードを選択してください。');
    tradeUi.cardTarget = cardTarget.value; tradeUi.kind = kind.value; tradeUi.cardType = cardType.value;
    sendCard.disabled = true;
    const res = await emitMutation('transferCard', { toId: cardTarget.value, type: cardType.value, special: kind.value === 'special', phaseSeq: state.phaseSeq });
    if (!res.ok) { toast(res.message); sendCard.disabled = disabled; }
  });
  cardBlock.append(cardTarget, kind, cardType, sendCard);
  if (protectedForcedType && (me.hand[protectedForcedType] || 0) === 1) {
    const forcedNote = document.createElement('div');
    forcedNote.className = 'microNote';
    forcedNote.textContent = `「${cardLabel(protectedForcedType)}」はカード指定中の最後の1枚なので譲渡できません。`;
    cardBlock.appendChild(forcedNote);
  }
  box.appendChild(cardBlock);

  const pointBlock = document.createElement('div'); pointBlock.className = 'tradeBlock pointBlock';
  const pointTargetInitial = hasValue(targetOptions, tradeUi.pointTarget) ? tradeUi.pointTarget : '';
  const pointTarget = makeSelect(targetOptions, pointTargetInitial, value => { tradeUi.pointTarget = value; }, disabled || !state.transferAllowed);
  // 所持Pが増えても5P刻みのoptionを数百〜数千個生成しない。数値入力+server検証で軽量化する。
  const pointAmount = document.createElement('input');
  pointAmount.type = 'number'; pointAmount.inputMode = 'numeric'; pointAmount.min = '5'; pointAmount.step = '5'; pointAmount.max = String(Math.max(5, me.points));
  const rememberedAmount = Number(tradeUi.pointAmount);
  pointAmount.value = me.points >= 5 && Number.isInteger(rememberedAmount) && rememberedAmount >= 5 && rememberedAmount <= me.points && rememberedAmount % 5 === 0
    ? String(rememberedAmount) : (me.points >= 5 ? '5' : '');
  pointAmount.placeholder = me.points >= 5 ? '5P単位' : 'ポイントが足りません';
  pointAmount.disabled = disabled || !state.transferAllowed || me.points < 5;
  pointAmount.addEventListener('input', () => { tradeUi.pointAmount = pointAmount.value; });
  tradeUi.pointAmount = pointAmount.value;
  const sendPoints = document.createElement('button'); sendPoints.type = 'button'; sendPoints.className = 'ghost';
  sendPoints.textContent = state.transferAllowed ? 'ポイント譲渡' : 'ポイント譲渡（5・10・15ターン）';
  sendPoints.disabled = disabled || !state.transferAllowed || me.points < 5;
  sendPoints.addEventListener('click', async () => {
    const amount = Number(pointAmount.value);
    if (!pointTarget.value || !Number.isInteger(amount) || amount < 5 || amount % 5 !== 0 || amount > state.me.points) return toast('相手と5P単位のポイント数を正しく入力してください。');
    tradeUi.pointTarget = pointTarget.value; tradeUi.pointAmount = pointAmount.value;
    sendPoints.disabled = true;
    const res = await emitMutation('transferPoints', { toId: pointTarget.value, amount, phaseSeq: state.phaseSeq });
    if (!res.ok) { toast(res.message); sendPoints.disabled = disabled || !state.transferAllowed || state.me.points < 5; }
  });
  pointBlock.append(pointTarget, pointAmount, sendPoints);
  box.appendChild(pointBlock);
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
    ['公開', (r.publicItems || []).map(text => ({ text, tone:'public' }))],
    ['自分', (r.privateItems || []).map(text => ({ text, tone:'private' }))],
    ['ポイント', (r.scoreItems || []).map(score => ({ text:`${score.reason}：${score.actual >= 0 ? '+' : ''}${score.actual}P`, tone:'score' }))]
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

function renderInfoStatementControls() {
  const box = $('#infoStatementControls');
  box.replaceChildren();
  if (!state.me?.alive || state.phase !== 'chat' || state.me?.ready) {
    box.textContent = state.me?.ready ? '準備OKを解除すると情報発言できます。' : '会話フェーズ中のみ使用できます。';
    return;
  }

  const hasValue = (options, value) => options.some(([v]) => v === value);
  const selectableSubjectKinds = new Set(['hp', 'kills', 'cardCount', 'objective']);
  const allSubjects = state.players.filter(p => p.color).map(p => [p.playerId, colorLabel(p)]);
  const selfOnlySubjects = [[state.me.playerId, '自分']];
  const recipients = [['', '全体へ'], ...otherAlivePlayers().map(p => [p.playerId, `${colorLabel(p)}へ個別`])];
  const recipientValue = hasValue(recipients, infoUi.recipient) ? infoUi.recipient : ($('#chatTarget')?.value || '');
  const recipient = makeSelect(recipients, recipientValue, value => { infoUi.recipient = value; });
  const kindOptions = [
    ['hp','HP'], ['points','ポイント'], ['kills','キル数'], ['cardCount','通常カード枚数'],
    ['hasSpecial','特殊カード所持'], ['objective','秘密目標'], ['lastAction','前ターンの通常カード'], ['nextAction','次の通常カード']
  ];
  const kindValue = hasValue(kindOptions, infoUi.kind) ? infoUi.kind : 'hp';
  const kind = makeSelect(kindOptions, kindValue, value => { storeValues(); infoUi.kind = value; syncSubjectControl(); rebuildValue(); });
  const subjectWrap = document.createElement('div'); subjectWrap.className = 'infoSubjectWrap';
  const valueArea = document.createElement('div'); valueArea.className = 'infoValueArea';
  const send = document.createElement('button'); send.type = 'button'; send.className = 'ghost'; send.textContent = '情報発言として送信';

  function currentMemory() { infoUi.values[infoUi.kind] ||= {}; return infoUi.values[infoUi.kind]; }
  function storeValues() {
    const mem = currentMemory();
    for (const el of valueArea.querySelectorAll('[data-role]')) mem[el.dataset.role] = el.value;
  }
  function remember(el, role, fallback) {
    const mem = currentMemory();
    el.dataset.role = role;
    if (mem[role] != null) el.value = mem[role];
    if (el.value === '' && fallback != null) el.value = String(fallback);
    el.addEventListener('change', () => { currentMemory()[role] = el.value; });
    el.addEventListener('input', () => { currentMemory()[role] = el.value; });
    return el;
  }
  function subjectSelectable(kindKey) {
    return selectableSubjectKinds.has(kindKey);
  }
  function syncSubjectControl() {
    const k = kind.value;
    const options = subjectSelectable(k) ? allSubjects : selfOnlySubjects;
    const fallback = subjectSelectable(k) ? state.me.playerId : state.me.playerId;
    const nextValue = hasValue(options, infoUi.subject) ? infoUi.subject : fallback;
    infoUi.subject = nextValue;
    subjectWrap.replaceChildren(makeSelect(options, nextValue, value => { infoUi.subject = value; }, !subjectSelectable(k)));
  }
  function rebuildValue() {
    valueArea.replaceChildren();
    const k = kind.value;
    infoUi.kind = k;
    if (['hp','points','kills'].includes(k)) {
      const input = document.createElement('input'); input.type = 'number'; input.min = k === 'points' ? '-99999' : '0'; input.value = k === 'hp' ? '5' : '0'; valueArea.appendChild(remember(input, 'value', input.value));
    } else if (k === 'cardCount') {
      const sel = makeSelect(normalOptions(false), 'attack', () => {}); valueArea.appendChild(remember(sel, 'cardType', 'attack'));
      const input = document.createElement('input'); input.type='number'; input.min='0'; input.value='0'; valueArea.appendChild(remember(input, 'value', '0'));
    } else if (k === 'hasSpecial') {
      const sp = makeSelect(Object.entries(state.specialCards || {}).map(([x,d]) => [x,d.label]), Object.keys(state.specialCards || {})[0], () => {});
      const yesno = makeSelect([['true','持っている'],['false','持っていない']], 'true', () => {});
      valueArea.append(remember(sp, 'specialType', sp.value), remember(yesno, 'value', 'true'));
    } else if (k === 'objective') {
      const obj = makeSelect(objectiveOptions(false), state.objectives?.[0]?.key, () => {}); valueArea.appendChild(remember(obj, 'objectiveKey', obj.value));
    } else if (['lastAction','nextAction'].includes(k)) {
      const a = makeSelect([['none','なし'], ...normalOptions(false)], 'none', () => {}); valueArea.appendChild(remember(a, 'normalType', 'none'));
    }
  }
  syncSubjectControl();
  rebuildValue();

  send.addEventListener('click', async () => {
    storeValues();
    infoUi.recipient = recipient.value;
    infoUi.subject = subjectSelectable(kind.value) ? infoUi.subject : state.me.playerId;
    infoUi.kind = kind.value;
    const payload = { subjectId: infoUi.subject, kind: kind.value, toId: recipient.value || null };
    for (const el of valueArea.querySelectorAll('[data-role]')) {
      const role = el.dataset.role;
      payload[role] = role === 'value' && el.type === 'number' ? Number(el.value) : el.value;
    }
    payload.phaseSeq = state.phaseSeq;
    if (payload.kind === 'lastAction' && state.turn <= 1) return toast('第1ターンには前ターンの行動がありません。');
    if (payload.kind === 'nextAction' && !state.players.find(x => x.playerId === payload.subjectId)?.alive) {
      return toast('脱落済みプレイヤーの次の行動は宣言できません。');
    }
    if (infoSending) return;
    infoSending = true;
    send.disabled = true;
    try {
      const res = await emitMutation('infoStatement', payload);
      if (!res.ok) toast(res.message);
    } finally {
      infoSending = false;
      if (send.isConnected) send.disabled = false;
    }
  });

  box.append(recipient, subjectWrap, kind, valueArea, send);
}

function renderRanking() {
  stopTimer();
  const box = $('#ranking');
  box.replaceChildren();
  for (const row of state.finishedRanking || []) {
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
    item.append(rank, who, kill, hp, points);
    box.appendChild(item);
  }
}

// 招待URL（#room=XXXXXXXX。旧?room=も互換対応）で開いた場合は、接続を始めず参加欄だけ事前入力する。
prepareInviteFromUrl();

// 復帰トークンがある時だけ初期接続する。ホームを眺めているだけの訪問者は
// WebSocket接続枠を消費しない。手動参加時はemitAck→ensureSocketConnectedで接続する。
if (resumeTokenCandidate()) socket.connect();

// 復帰トークンはブラウザ共通で保持し、タブを閉じた後も再接続できる。
// 同じブラウザからの二重参加はbrowserIdをサーバー側で拒否する。
