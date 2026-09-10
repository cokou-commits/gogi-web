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
function objectiveLabel(key) { return state?.objectives?.find(o => o.key === key)?.label || key || '—'; }
function phaseName(phase) { return ({chat:'会話', action:'選択', result:'処理中', finished:'終了'})[phase] || phase || '—'; }

function saveJoinResult(res) {
  if (res?.ok && res.sessionToken) setSession(res.sessionToken, { forceShared: true });
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
$$('[data-scroll-target]').forEach(btn => btn.addEventListener('click', () => {
  const el = document.getElementById(btn.dataset.scrollTarget);
  el?.scrollIntoView({ behavior:'smooth', block:'start' });
}));

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
$('#lockAction')?.addEventListener('click', async () => {
  if (!state?.me?.alive || state.phase !== 'action') return;
  await waitForDraftUpdates();
  if (!state?.me?.alive || state.phase !== 'action') return;
  const res = await emitAck('lockAction', { phaseSeq: state.phaseSeq });
  if (!res.ok) toast(res.message);
});

socket.on('connect', () => { sessionReadyPromise = tryResume(); });
socket.on('connect', () => { setConnectionState('online'); });
socket.on('state', next => {
  if (!next || typeof next !== 'object' || Array.isArray(next)) return;
  if (next.resumeToken) setSession(next.resumeToken, { forceShared: manualJoinInFlight });
  if (Number.isFinite(next.serverNow)) clockOffsetMs = next.serverNow - Date.now();
  const sameRoom = !!(state?.roomId && next?.roomId && state.roomId === next.roomId);
  if (!sameRoom) { renderedChatKey = ''; renderedLogsKey = ''; lastMessageIds.clear(); lastPhaseNavigationSeq = null; }
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
  const count = state.players.length;
  $('#lobbyTitle').textContent = state.isPublic ? '対戦相手を探しています' : 'プライベートルームで待機中';
  $('#lobbyNote').textContent = `${count}/5人参加中。5人揃うと自動で開始します。`;
  const copy = $('#copyCode');
  if (state.isPublic) {
    copy.classList.add('hidden');
  } else {
    copy.classList.remove('hidden');
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
  renderInfoStatementControls();
  navigateToActivePhaseOnMobile();
}

function navigateToActivePhaseOnMobile() {
  if (lastPhaseNavigationSeq === state?.phaseSeq) return;
  lastPhaseNavigationSeq = state?.phaseSeq ?? null;
  // 10秒の選択開始時にルールモーダルやソフトキーボードが前面を塞がないようにする。
  if (state?.phase === 'action') {
    closeRules();
    const active = document.activeElement;
    if (active && typeof active.blur === 'function' && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName)) active.blur();
  }
  if (!globalThis.matchMedia?.('(max-width: 900px)').matches) return;
  const target = state.phase === 'chat' ? $('#chatPanel') : state.phase === 'action' ? $('#actionPanel') : state.phase === 'result' ? $('#resultPanel') : null;
  if (target && !target.classList.contains('hidden')) requestAnimationFrame(() => target.scrollIntoView({ behavior:'auto', block:'start' }));
}

function renderTimer() {
  stopTimer();
  const tick = () => {
    const seconds = state?.phaseEndsAt ? Math.max(0, Math.ceil((state.phaseEndsAt - (Date.now() + clockOffsetMs)) / 1000)) : 0;
    const timer = $('#timer');
    if (timer) timer.textContent = String(seconds);
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
  $('#myObjective').textContent = me.objective?.label || '—';
  $('#objectiveDesc').textContent = me.objective?.description || '';
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
  const isAction = state.phase === 'action';
  const isResult = state.phase === 'result';
  $('#chatPanel').classList.toggle('hidden', !isChat);
  $('#actionPanel').classList.toggle('hidden', !isAction);
  $('#resultPanel').classList.toggle('hidden', !isResult);
  $('#draftPanel').classList.toggle('hidden', !isChat);

  const aliveCount = Number(state.phaseProgress?.alive ?? alivePlayers().length);
  const ready = Number(state.phaseProgress?.ready ?? 0);
  const locked = Number(state.phaseProgress?.locked ?? 0);
  $('#readyCount').textContent = `準備OK ${ready}/${aliveCount}`;
  $('#lockCount').textContent = `行動確定 ${locked}/${aliveCount}`;

  if (isChat) {
    const btn = $('#readyBtn');
    btn.disabled = !state.me?.alive;
    btn.classList.toggle('on', !!state.me?.ready);
    btn.textContent = state.me?.ready ? '準備OK ✓（解除）' : '準備OK';
    renderActionComposer($('#draftComposer'), false);
  }
  if (isAction) {
    renderActionComposer($('#actionComposer'), true);
    $('#lockAction').disabled = !state.me?.alive || !!state.me?.actionLocked;
    $('#lockAction').textContent = state.me?.actionLocked ? '確定済み ✓' : '行動確定';
  }
  if (isResult) renderResultSummary();
}

function renderResultSummary() {
  const box = $('#resultSummary');
  if (!box) return;
  box.replaceChildren();
  const r = state.lastResult;
  $('#resultTitle').textContent = r ? `第${r.turn}ターン 結果` : 'ターン結果';
  const items = [];
  for (const text of r?.publicItems || []) items.push({ text, own:false });
  for (const text of r?.privateItems || []) items.push({ text, own:true });
  for (const score of r?.scoreItems || []) items.push({ text:`${score.reason}：${score.actual >= 0 ? '+' : ''}${score.actual}P`, own:true });
  if (!items.length) items.push({ text:'公開される大きな変化はありませんでした。', own:false });
  for (const item of items) {
    const row = document.createElement('div');
    row.className = `resultItem${item.own ? ' own' : ''}`;
    row.textContent = item.text;
    box.appendChild(row);
  }
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
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `cardBtn${draft.normal === key ? ' selected' : ''}`;
    button.disabled = disabled || me.forcedUnavailable || me.forcedConflict || (me.hand[key] || 0) <= 0 || (!!forcedKey && forcedKey !== key);
    const strong = document.createElement('b'); strong.textContent = def.label;
    const count = document.createElement('span'); count.textContent = `×${me.hand[key] || 0}`;
    button.append(strong, count);
    button.addEventListener('click', () => updateDraft({ normal: draft.normal === key && !forcedKey ? null : key }));
    normalGrid.appendChild(button);
  }
  const noAction = document.createElement('button');
  noAction.type = 'button';
  noAction.className = `cardBtn noAction${!draft.normal ? ' selected' : ''}`;
  noAction.disabled = disabled || !!forcedKey || me.forcedConflict;
  noAction.innerHTML = '<b>行動なし</b><span>通常カードを使わない</span>';
  noAction.addEventListener('click', () => updateDraft({ normal: null, normalTargetId: null, secondNormalTargetId: null, accusationGuess: null, secondAccusationGuess: null }));
  normalGrid.appendChild(noAction);
  section1.appendChild(normalGrid);
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
  const noneSpecial = document.createElement('button');
  noneSpecial.type = 'button';
  noneSpecial.className = `cardBtn${!draft.special ? ' selected' : ''}`;
  noneSpecial.disabled = disabled || me.forcedUnavailable || me.forcedConflict;
  noneSpecial.innerHTML = '<b>使わない</b><span>特殊なし</span>';
  noneSpecial.addEventListener('click', () => updateDraft({ special: null, specialTargetId: null, specifiedType: null }));
  specialGrid.appendChild(noneSpecial);
  for (const [key, def] of Object.entries(state.specialCards || {})) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `cardBtn${draft.special === key ? ' selected' : ''}`;
    button.disabled = disabled || me.forcedUnavailable || me.forcedConflict || (me.specials[key] || 0) <= 0 || (key === 'double' && !draft.normal);
    const strong = document.createElement('b'); strong.textContent = def.label;
    const count = document.createElement('span'); count.textContent = `×${me.specials[key] || 0}`;
    button.append(strong, count);
    button.addEventListener('click', () => updateDraft({ special: draft.special === key ? null : key }));
    specialGrid.appendChild(button);
  }
  section2.appendChild(specialGrid);
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

  if (draft.special === 'double' && ['scout','accusation'].includes(draft.normal)) {
    const second = document.createElement('div');
    second.className = 'fieldGrid doubleFields';
    const target = document.createElement('label');
    target.innerHTML = `<span>${draft.normal === 'scout' ? '2人目の偵察対象' : '2回目の告発対象'}（任意）</span>`;
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
  summary.textContent = `仮選択：${normalText}${specialText}`;
  container.appendChild(summary);
}

function updateDraft(patch) {
  const requestedPhaseSeq = state?.phaseSeq;
  // 10秒フェーズで素早く複数項目を触っても、古いdraftを基準にした後発リクエストが
  // 先の選択を上書きしないよう、draft更新だけは直列化する。
  // 予期しないUI例外が1回起きても、以後の選択キュー全体が永続的にreject状態へ
  // 固定されないよう前回エラーを吸収してから次の更新を続ける。
  draftUpdateChain = draftUpdateChain.catch(() => {}).then(async () => {
    if (!state?.me?.alive || !['chat','action'].includes(state.phase)) return;
    if (state.phaseSeq !== requestedPhaseSeq) return;
    if (state.phase === 'action' && state.me.actionLocked) return;
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
      else if (state.phase === 'action') renderActionComposer($('#actionComposer'), true);
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
    const text = document.createElement('span'); text.textContent = `${def.label} ×${me.hand[key] || 0}`;
    const buy = document.createElement('button'); buy.type = 'button'; buy.textContent = `${def.price}P`;
    buy.disabled = state.phase !== 'chat' || !me.alive || me.ready || me.normalPurchasedThisTurn || me.points < def.price;
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
    const count = document.createElement('b'); count.textContent = `×${me.specials[key] || 0}`;
    row.append(text, count); box.appendChild(row);
  }
  const specialBuy = document.createElement('div'); specialBuy.className = 'shopRow';
  const text = document.createElement('span'); text.textContent = '特殊カード（ランダム）';
  const buy = document.createElement('button'); buy.type = 'button'; buy.textContent = '50P';
  buy.disabled = state.phase !== 'chat' || !me.alive || me.ready || me.specialPurchased || me.points < 50;
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
    .map(([k,d]) => [k, `${d.label} ×${me.hand[k]}`]);
  const specialCards = Object.entries(state.specialCards || {}).filter(([k]) => (me.specials[k] || 0) > 0).map(([k,d]) => [k, `${d.label} ×${me.specials[k]}`]);
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
      const o = document.createElement('option'); o.value = ''; o.textContent = '譲渡できるカードなし'; cardType.appendChild(o);
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
  pointAmount.placeholder = me.points >= 5 ? '5P単位' : '送れるポイントなし';
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

function renderScoutReports() {
  const box = $('#scoutReports');
  box.replaceChildren();
  const reports = [...(state.me?.scoutReports || [])].reverse();
  if (!reports.length) {
    const empty = document.createElement('div'); empty.className = 'microNote'; empty.textContent = 'まだ偵察結果はありません。'; box.appendChild(empty); return;
  }
  for (const report of reports) {
    const item = document.createElement('details'); item.className = 'scoutReport';
    const summary = document.createElement('summary'); summary.textContent = `第${report.turn}ターン ${report.color} / HP${report.hp} / キル${report.kills}`;
    const normal = Object.entries(report.hand || {}).map(([k,n]) => `${cardLabel(k)}×${n}`).join(' / ');
    const body = document.createElement('div'); body.className = 'reportBody';
    body.textContent = `通常：${normal}`;
    item.append(summary, body); box.appendChild(item);
  }
}

function renderInfoStatementControls() {
  const box = $('#infoStatementControls');
  box.replaceChildren();
  if (!state.me?.alive || state.phase !== 'chat' || state.me?.ready) {
    box.textContent = state.me?.ready ? '準備OKを解除すると情報発言できます。' : '会話フェーズ中のみ使用できます。';
    return;
  }

  const hasValue = (options, value) => options.some(([v]) => v === value);
  const subjects = state.players.filter(p => p.color).map(p => [p.playerId, colorLabel(p)]);
  const recipients = [['', '全体へ'], ...otherAlivePlayers().map(p => [p.playerId, `${colorLabel(p)}へ個別`])];
  const recipientValue = hasValue(recipients, infoUi.recipient) ? infoUi.recipient : ($('#chatTarget')?.value || '');
  const subjectValue = hasValue(subjects, infoUi.subject) ? infoUi.subject : state.me.playerId;
  const recipient = makeSelect(recipients, recipientValue, value => { infoUi.recipient = value; });
  const subject = makeSelect(subjects, subjectValue, value => { infoUi.subject = value; });
  const kindOptions = [
    ['hp','HP'], ['points','ポイント'], ['kills','キル数'], ['cardCount','通常カード枚数'],
    ['hasSpecial','特殊カード所持'], ['objective','秘密目標'], ['lastAction','前ターンの通常カード'], ['nextAction','次の通常カード'],
    ['normalPurchase','このターンの通常カード購入'], ['specialPurchase','特殊カード購入済み']
  ];
  const kindValue = hasValue(kindOptions, infoUi.kind) ? infoUi.kind : 'hp';
  const kind = makeSelect(kindOptions, kindValue, value => { storeValues(); infoUi.kind = value; rebuildValue(); });
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
    } else if (k === 'normalPurchase') {
      const a = makeSelect([['none','購入していない'], ...normalOptions(false)], 'none', () => {}); valueArea.appendChild(remember(a, 'normalType', 'none'));
    } else if (k === 'specialPurchase') {
      const yesno = makeSelect([['true','購入済み'],['false','未購入']], 'false', () => {}); valueArea.appendChild(remember(yesno, 'value', 'false'));
    }
  }
  rebuildValue();

  send.addEventListener('click', async () => {
    storeValues();
    infoUi.recipient = recipient.value; infoUi.subject = subject.value; infoUi.kind = kind.value;
    const payload = { subjectId: subject.value, kind: kind.value, toId: recipient.value || null };
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

  box.append(recipient, subject, kind, valueArea, send);
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

// 復帰トークンがある時だけ初期接続する。ホームを眺めているだけの訪問者は
// WebSocket接続枠を消費しない。手動参加時はemitAck→ensureSocketConnectedで接続する。
if (resumeTokenCandidate()) socket.connect();

// 復帰トークンはブラウザ共通で保持し、タブを閉じた後も再接続できる。
// 同じブラウザからの二重参加はbrowserIdをサーバー側で拒否する。
