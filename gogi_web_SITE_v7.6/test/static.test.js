'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/styles.css'), 'utf8');

function uniq(xs) { return [...new Set(xs)]; }

test('app.js が参照する固定IDは index.html に存在する', () => {
  const ids = uniq([...app.matchAll(/\$\(['"]#([A-Za-z0-9_-]+)['"]\)/g)].map(m => m[1]));
  const htmlIds = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map(m => m[1]));
  const missing = ids.filter(id => !htmlIds.has(id));
  assert.deepEqual(missing, []);
});

test('クライアントがemitAckするイベントはサーバーにハンドラがある', () => {
  const emitted = uniq([...app.matchAll(/emitAck\(['"]([A-Za-z0-9_-]+)['"]/g)].map(m => m[1]));
  const handled = new Set([...server.matchAll(/socket\.on\(['"]([A-Za-z0-9_-]+)['"]/g)].map(m => m[1]));
  const missing = emitted.filter(name => !handled.has(name));
  assert.deepEqual(missing, []);
});

test('スマホCSSでTRADEを丸ごと非表示にしない', () => {
  assert.equal(css.includes('.meCard,.logsCard,.transfer{display:none}'), false);
});

test('チャット本文はinnerHTMLへ直接挿入しない', () => {
  assert.equal(/innerHTML\s*=\s*[^;]*(message\.text|payload\.text|state\.chat)/.test(app), false);
  assert.match(app, /bubble\.textContent/);
});

test('CSPは外部スクリプトを許可していない', () => {
  assert.match(server, /script-src 'self'/);
  assert.match(server, /object-src 'none'/);
  assert.doesNotMatch(server, /script-src[^;]*\*/);
});

test('ルール画面に15種類すべての秘密目標名が載っている', () => {
  const { OBJECTIVES } = require('../src/rules');
  for (const obj of OBJECTIVES) assert.ok(html.includes(obj.label), `${obj.label}がルール画面に必要`);
});

test('resumeは既に別ルームへ参加中の同一Socketからの乗っ取りを拒否する', () => {
  assert.match(server, /socket\.on\('resume'[\s\S]*?if \(socket\.data\.roomId\) return safeCb\(cb, \{ ok: false, message: 'すでに参加中です。' \}\)/);
});

test('購入・カード譲渡・ポイント譲渡は操作IDでACK再送時の二重処理を防ぐ', () => {
  assert.match(server, /function checkMutation\(p, scope, opId\)/);
  assert.match(server, /function commitMutation\(p, key\)/);
  assert.match(server, /checkMutation\(p, 'buy', opId\)/);
  assert.match(server, /checkMutation\(p, 'transferCard', opId\)/);
  assert.match(server, /checkMutation\(p, 'transferPoints', opId\)/);
  assert.match(app, /emitMutation\('buy'/);
  assert.match(app, /emitMutation\('transferCard'/);
  assert.match(app, /emitMutation\('transferPoints'/);
});

test('同じ復帰トークンを別タブが接続中に奪えない', () => {
  assert.match(server, /p\.connected && p\.clientInstanceId && p\.clientInstanceId !== instanceId/);
  assert.match(server, /error\.code = 'SESSION_IN_USE'/);
  assert.match(app, /storageGet\(sessionStore, INSTANCE_KEY\)/);
  assert.match(app, /res\.code !== 'SESSION_IN_USE'/);
});

test('本番はALLOWED_ORIGINSを既定で必須にしSocket総接続上限を持つ', () => {
  assert.match(server, /REQUIRE_ALLOWED_ORIGINS/);
  assert.match(server, /本番環境では ALLOWED_ORIGINS を設定してください/);
  assert.match(server, /MAX_SOCKET_CONNECTIONS/);
  assert.match(server, /activeSocketConnections < MAX_SOCKET_CONNECTIONS/);
});

test('第15ターン結果表示前に生存ボーナスを反映する', () => {
  assert.match(server, /if \(room\.turn >= MAX_TURNS\) \{[\s\S]*?awardSurvivalBonus\(room\)[\s\S]*?result\.scoreEvents\.push/);
});


test('他プレイヤー個人の次へ状態は公開せず集計だけ返す', () => {
  const viewBlock = server.match(/function publicPlayerView\(p\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.doesNotMatch(viewBlock, /ready:\s*p\.ready/);
  assert.doesNotMatch(viewBlock, /actionLocked:\s*p\.actionLocked/);
  assert.match(server, /phaseProgress:\s*\{/);
  assert.match(app, /state\.phaseProgress\?\.ready/);
  assert.match(app, /state\.phaseProgress\?\.resultReady/);
});

test('8文字の強化ルームコードをクライアントとサーバーで一致して検証する', () => {
  assert.match(html, /maxlength="8"/);
  assert.match(html, /placeholder="8文字コード"/);
  assert.match(app, /ABCDEFGHJKLMNPQRSTUVWXYZ23456789/);
  assert.match(server, /ROOM_CODE_LENGTH/);
  assert.match(server, /ROOM_CODE_ALPHABET/);
});

test('再接続ハンドオフは新Socketを正にしてから旧Socketを切断する', () => {
  const block = server.match(/function bindSocketToPlayer\([\s\S]*?\n\}/)?.[0] || '';
  const assign = block.indexOf('p.socketId = socket.id');
  const disconnect = block.indexOf('oldSocket.disconnect(true)');
  assert.ok(assign >= 0 && disconnect > assign, '旧Socket切断より先に新Socketを正にする必要がある');
});

test('全員脱落時にターン15へ偽装せず即終了する', () => {
  const block = server.match(/function beginChat\([\s\S]*?\n\}/)?.[0] || '';
  assert.match(block, /getAlive\(room\)\.length === 0/);
  assert.match(block, /finishGame\(room\)/);
  assert.doesNotMatch(block, /room\.turn\s*=\s*MAX_TURNS/);
});

test('譲渡UIと情報発言UIは再描画で選択値を失いにくい状態保持を持つ', () => {
  assert.match(app, /const tradeUi =/);
  assert.match(app, /const infoUi =/);
  assert.match(app, /tradeUi\.cardTarget/);
  assert.match(app, /infoUi\.values/);
});


test('同一ブラウザの二重参加をbrowserIdで基本防止し、復帰トークンは保持する', () => {
  assert.match(app, /const BROWSER_KEY = 'gogi\.browserId\.v1'/);
  assert.match(app, /storageGet\(localStore, BROWSER_KEY\)/);
  assert.match(app, /storageSet\(localStore, SESSION_KEY, token\)/);
  assert.match(server, /function browserIdInUse\(/);
  assert.match(server, /error\.code = 'BROWSER_IN_USE'/);
  assert.match(server, /browserIdInUse\(normalizeBrowserId\(browserId\)\)/);
});

test('結果表示後、全員脱落ならターン番号を増やさず終了する', () => {
  const block = server.match(/function advanceFromResult\(room\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(block, /getAlive\(room\)\.length === 0/);
  const finishAt = block.indexOf('return finishGame(room)');
  const incrementAt = block.indexOf('room.turn++');
  assert.ok(finishAt >= 0 && incrementAt > finishAt);
});

test('日本語専用UIで主要表示に不要なPOINT/KILL/ROOM表記を残さない', () => {
  assert.doesNotMatch(html, />POINT</);
  assert.doesNotMatch(app, /`ROOM \$\{state\.code\}`/);
  assert.doesNotMatch(app, /KILL \$\{report\.kills\}/);
  assert.doesNotMatch(app, /kill\.textContent = `K /);
  assert.doesNotMatch(app, /summary\.textContent = `T\$\{report\.turn\}/);
});

test('高速な複数選択でdraftを上書きしないよう更新を直列化し、確定前に待つ', () => {
  assert.match(app, /let draftUpdateChain = Promise\.resolve\(\)/);
  assert.match(app, /draftUpdateChain = draftUpdateChain(?:\.catch\(\(\) => \{\}\))?\.then/);
  assert.match(app, /readyBtn[\s\S]*?await waitForDraftUpdates\(\)/);
});

test('本番ランタイムと主要依存は2026-09監査版へ更新されている', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const docker = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  assert.equal(pkg.engines.node, '>=24.21.0 <25');
  assert.equal(pkg.dependencies.express, '5.2.1');
  assert.equal(pkg.dependencies['socket.io'], '4.8.3');
  assert.match(docker, /FROM node:24\.21\.0-alpine/);
});

test('次へは待機開始後に追加されたdraft更新まで完全にflushする', () => {
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(app, /async function waitForDraftUpdates\(\)/);
  assert.match(app, /const pending = draftUpdateChain;[\s\S]*await pending;[\s\S]*pending === draftUpdateChain/);
  assert.match(app, /readyBtn[\s\S]*await waitForDraftUpdates\(\)/);
  assert.match(app, /draftUpdateChain = draftUpdateChain\.catch\(\(\) => \{\}\)\.then/);
});

test('Socketイベントはnull/primitive payloadでもデストラクチャ例外でプロセスを落とさない', () => {
  assert.match(server, /function objectPayload\(value\)/);
  const directDestructure = [...server.matchAll(/socket\.on\([^\n]+\n?\s*\(\{/g)];
  assert.equal(directDestructure.length, 0, 'socket.onで受信payloadを直接デストラクチャしない');
  for (const name of ['resume','publicMatch','createPrivate','joinPrivate','setReady','setDraft','nextResult','chat','infoStatement','buy','transferCard','transferPoints']) {
    assert.match(server, new RegExp(`socket\\.on\\('${name}'[\\s\\S]*?objectPayload\\(rawPayload\\)`), `${name}はobjectPayloadを通す`);
  }
});

test('同一ブラウザの古い終了タブが新しい対戦の復帰トークンを上書き・削除しない', () => {
  assert.match(app, /const TAB_SESSION_KEY = 'gogi\.tabSessionToken\.v1'/);
  assert.match(app, /shared === previousTabToken/);
  assert.match(app, /if \(previousTabToken && shared === previousTabToken\) storageRemove\(localStore, SESSION_KEY\)/);
  assert.match(app, /setSession\(res\.sessionToken, \{ forceShared: true \}\)/);
  assert.match(app, /clearSessionToken\(leavingToken\)/);
});

test('ブラウザStorageが利用不可でも初期化時にSecurityErrorで停止しない', () => {
  assert.match(app, /function storageGet\(storage, key\) \{ try/);
  assert.match(app, /function storageSet\(storage, key, value\) \{ try/);
  assert.match(app, /function storageRemove\(storage, key\) \{ try/);
  assert.doesNotMatch(app, /\blocalStorage\.getItem\(/);
  assert.doesNotMatch(app, /\bsessionStorage\.getItem\(/);
});

test('参加ACKが落ちても先行stateから共有復帰トークンを更新できる', () => {
  assert.match(app, /socket\.on\('state'[\s\S]*setSession\(next\.resumeToken, \{ forceShared: manualJoinInFlight \}\)/);
});

test('Web Crypto非対応時の操作IDフォールバックも同一ms衝突を避ける', () => {
  assert.match(app, /let operationCounter = 0/);
  assert.match(app, /operationCounter = \(operationCounter \+ 1\)/);
  assert.match(app, /clientInstanceId\.slice\(-16\)/);
});


test('高頻度draft更新は全snapshotを再送せずACKの正規化draftだけで本人UIを更新する', () => {
  const block = server.match(/socket\.on\('setDraft'[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.match(block, /safeCb\(cb, \{ ok: true, draft: result\.draft \}\)/);
  assert.doesNotMatch(block, /emitPlayerState\(/);
  assert.match(app, /if \(res\.draft && state\?\.me/);
  assert.match(app, /state\.me\.draft = \{ \.\.\.res\.draft \}/);
});

test('構造化情報発言は表示不要な全snapshot再送を行わない', () => {
  const block = server.match(/socket\.on\('infoStatement'[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.doesNotMatch(block, /emitPlayerState\(/);
});

test('終了ルーム削除時はSocket.IO room membershipとsocket.dataも掃除する', () => {
  const block = server.match(/function deleteRoom\(room\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(block, /liveSocket\.leave\(room\.id\)/);
  assert.match(block, /liveSocket\.data\.roomId = null/);
  assert.match(block, /liveSocket\.data\.playerId = null/);
});

test('復帰失敗などでホームへ戻る時に古い200msタイマーを停止する', () => {
  assert.match(app, /function stopTimer\(\)/);
  assert.match(app, /tryResume[\s\S]*?stopTimer\(\);[\s\S]*?state = null/);
  assert.match(app, /leaveCurrentRoom[\s\S]*?stopTimer\(\);[\s\S]*?state = null/);
});


test('再接続直後の通常操作はresume完了を待ってから送信する', () => {
  assert.match(app, /let sessionReadyPromise = Promise\.resolve\(\)/);
  assert.match(app, /if \(event !== 'resume'\)[\s\S]*await sessionReadyPromise/);
  assert.match(app, /socket\.on\('connect', \(\) => \{ sessionReadyPromise = tryResume\(\); \}\)/);
});

test('resumeはACK消失後の同一Socket再送を冪等成功させる', () => {
  const block = server.match(/socket\.on\('resume'[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.match(block, /current\.p\.sessionToken === token/);
  assert.match(block, /duplicate: true/);
  assert.match(block, /includeHistory: true/);
});

test('チャットと構造化情報発言も操作IDでACK再送の二重投稿を防ぐ', () => {
  assert.match(server, /checkMutation\(p, 'chat', opId\)/);
  assert.match(server, /checkMutation\(p, 'info', payload\.opId\)/);
  assert.match(app, /emitMutation\('chat'/);
  assert.match(app, /emitMutation\('infoStatement'/);
});

test('再接続でSocketレート制限をリセットしてもプレイヤー単位制限が残る', () => {
  assert.match(server, /function allowPlayer\(p, key, limit, windowMs\)/);
  for (const key of ['resume','ready','draft','chat','info','buy','transferCard','transferPoints']) {
    assert.match(server, new RegExp(`allowPlayer\\(p, '${key}'`));
  }
});

test('stateイベントが壊れたpayloadでもクライアント描画を落とさない', () => {
  assert.match(app, /socket\.on\('state', next => \{[\s\S]*?typeof next !== 'object'[\s\S]*?Array\.isArray\(next\)/);
});

test('setDraftはACKだけ消失した場合に同一draftを1回再送できる', () => {
  assert.match(app, /let res = await emitAck\('setDraft', request\)/);
  assert.match(app, /res\?\.transient[\s\S]*emitAck\('setDraft', request\)/);
});

test('本番healthは既定で内部ルーム数・接続数を公開しない', () => {
  assert.match(server, /EXPOSE_HEALTH_DETAILS/);
  assert.match(server, /if \(!EXPOSE_HEALTH_DETAILS\) return res\.json\(\{ ok: true \}\)/);
});

test('文字列切り詰めで絵文字のサロゲートペアを途中切断しない', () => {
  assert.match(server, /Array\.from\(clean\)\.slice\(0, max\)\.join\(''\)/);
});

test('差分チャット配信が続いてもstate・重複集合・DOMを160件へ制限する', () => {
  assert.match(app, /if \(state\.chat\.length > 160\)[\s\S]*state\.chat\.splice/);
  assert.match(app, /lastMessageIds\.delete\(old\.id\)/);
  assert.match(app, /while \(box\.children\.length > 160\) box\.firstElementChild\?\.remove\(\)/);
});

test('一画面UIではフェーズ切替時にページスクロールせず結果画面へ切り替える', () => {
  assert.match(app, /function navigateToActivePhaseOnMobile\(\)/);
  assert.doesNotMatch(app, /scrollIntoView\(/);
  assert.match(app, /classList\.toggle\('resultOnly', isResult\)/);
});

test('モバイルの高コスト背景フィルタとノイズを無効化して描画負荷を抑える', () => {
  assert.match(css, /@media\(max-width:900px\)[\s\S]*\.glass\{backdrop-filter:none;-webkit-backdrop-filter:none/);
  assert.match(css, /\.noise\{display:none\}/);
});

test('結果画面への切替時はルールと入力フォーカスを閉じる', () => {
  assert.match(app, /navigateToActivePhaseOnMobile[\s\S]*closeRules\(\)/);
  assert.match(app, /state\?\.phase === 'result'[\s\S]*active\.blur\(\)/);
});


test('古い終了タブの自動resumeは新しい対戦の共有復帰トークンを強制上書きしない', () => {
  assert.match(app, /let manualJoinInFlight = false/);
  assert.match(app, /setSession\(next\.resumeToken, \{ forceShared: manualJoinInFlight \}\)/);
  assert.doesNotMatch(app, /setSession\(next\.resumeToken, \{ forceShared: joining \}\)/);
  assert.match(app, /manualJoinInFlight = true[\s\S]*emitAck\('publicMatch'/);
  assert.match(app, /manualJoinInFlight = true[\s\S]*emitAck\('createPrivate'/);
  assert.match(app, /manualJoinInFlight = true[\s\S]*emitAck\('joinPrivate'/);
});

test('iPhoneのviewport-fit=coverでノッチとホーム領域を避ける', () => {
  assert.match(html, /viewport-fit=cover/);
  assert.match(css, /env\(safe-area-inset-top\)/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
});

test('ポイント譲渡は所持P分の大量optionを生成せず5P刻み数値入力を使う', () => {
  assert.match(app, /pointAmount\.type = 'number'/);
  assert.match(app, /pointAmount\.step = '5'/);
  assert.doesNotMatch(app, /for \(let n = 5; n <= me\.points; n \+= 5\) amounts\.push/);
});

test('一時的なresume通信欠落は冪等再送し、失敗時も画面とtokenを即破棄しない', () => {
  assert.match(app, /res\.transient && attempt < 2/);
  assert.match(app, /if \(res\.transient\)[\s\S]*return res/);
});

test('プライベートルームも5人目の参加直後に自動開始判定する', () => {
  const block = server.match(/socket\.on\('joinPrivate'[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.match(block, /safeCb\(cb, \{ ok: true, sessionToken: p\.sessionToken \}\);[\s\S]*maybeStart\(room\)/);
});

test('ゲーム終了画面ではWebSocketを解放し、トップ復帰で不要な再接続をしない', () => {
  assert.match(app, /state\.status === 'finished'[\s\S]*socket\.connected[\s\S]*socket\.disconnect\(\)/);
  const leaveBlock = app.match(/async function leaveCurrentRoom\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(leaveBlock, /state\?\.status !== 'finished'/);
});


test('配布物のバージョン表記はv7.6へ統一されている', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const audit = fs.readFileSync(path.join(root, 'AUDIT.md'), 'utf8');
  const deploy = fs.readFileSync(path.join(root, 'DEPLOY.md'), 'utf8');
  const rulesDoc = fs.readFileSync(path.join(root, 'RULES.md'), 'utf8');
  const decisions = fs.readFileSync(path.join(root, 'RULE_DECISIONS.md'), 'utf8');
  assert.equal(pkg.version, '7.6.0');
  for (const text of [readme, audit, deploy, rulesDoc, decisions]) assert.match(text.split('\n', 1)[0], /v7\.6/);
});


test('ホーム閲覧だけではWebSocketを自動接続せず接続枠を消費しない', () => {
  assert.match(app, /io\(\{ transports: \['websocket', 'polling'\], autoConnect: false \}\)/);
  assert.match(app, /if \(resumeTokenCandidate\(\)\) socket\.connect\(\)/);
  assert.match(app, /function disconnectIdleSocket\(\)/);
  const leaveBlock = app.match(/async function leaveCurrentRoom\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(leaveBlock, /disconnectIdleSocket\(\)/);
});

test('購入・譲渡の秘匿状態更新は関係者だけへ送って全員再描画を避ける', () => {
  const buyBlock = server.match(/socket\.on\('buy'[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.match(buyBlock, /emitPlayerState\(room, p\)/);
  assert.doesNotMatch(buyBlock, /emitState\(room\)/);

  const cardBlock = server.match(/socket\.on\('transferCard'[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.match(cardBlock, /emitPlayerState\(room, p\)/);
  assert.match(cardBlock, /emitPlayerState\(room, target\)/);
  assert.doesNotMatch(cardBlock, /emitState\(room\)/);

  const pointBlock = server.match(/socket\.on\('transferPoints'[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.match(pointBlock, /emitPlayerState\(room, p\)/);
  assert.match(pointBlock, /emitPlayerState\(room, target\)/);
  assert.doesNotMatch(pointBlock, /emitState\(room\)/);
});

test('終了画面の意図的Socket切断は切断ログと再接続タイマーを増やさない', () => {
  const block = server.match(/socket\.on\('disconnect'[\s\S]*?\n  \}\);/)?.[0] || '';
  const finishedAt = block.indexOf("if (room.status === 'finished') return");
  const logAt = block.indexOf("log(room,");
  const timerAt = block.indexOf("p.disconnectTimer = setTimeout");
  assert.ok(finishedAt >= 0 && logAt > finishedAt && timerAt > finishedAt);
});

test('iOS Safariのフォームフォーカス自動ズームを16pxで防ぐ', () => {
  assert.match(css, /@media\(max-width:900px\)[\s\S]*input,select,textarea\{font-size:16px\}/);
});

test('カード指定の最後の指定カード譲渡をサーバー側で拒否する', () => {
  const block = server.match(/socket\.on\('transferCard'[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.match(block, /canTransferNormalCard\(room, p, key\)/);
  assert.match(block, /最後の指定カードは譲渡できません/);
});

test('構造化発言の明白な時間軸抜け道をクライアントでも事前拒否する', () => {
  assert.match(app, /payload\.kind === 'lastAction' && state\.turn <= 1/);
  assert.match(app, /payload\.kind === 'nextAction'[\s\S]*!state\.players\.find/);
});

test('最後の次へで行動専用フェーズを挟まず直接結果へ進む', () => {
  const readyBlock = server.match(/socket\.on\('setReady'[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.match(readyBlock, /if \(allAliveReady\(room\)\) resolveAndShowResult\(room\);\s*else emitState\(room\)/);
  assert.doesNotMatch(server, /function beginAction\(/);
  assert.doesNotMatch(server, /socket\.on\('lockAction'/);
});

test('偵察イベントは意味のない「個別結果」ログを生成しない', () => {
  const block = server.match(/for \(const e of result\.privateEvents\) \{[\s\S]*?\n  \}/)?.[0] || '';
  assert.match(block, /if \(e\.text\) log\(room, e\.text, \[e\.to\]\)/);
  assert.doesNotMatch(block, /'個別結果'/);
});

test('終了済み試合の最終結果resumeで再接続ログを増やさない', () => {
  const block = server.match(/socket\.on\('resume'[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.match(block, /if \(room\.status !== 'finished'\) log\(room, `\$\{p\.color\?\.label \|\| 'プレイヤー'\}が再接続しました。`\)/);
});

test('validTargetに重複した同一拒否条件を残さない', () => {
  const block = server.match(/function validTarget\(room, p, id[\s\S]*?\n\}/)?.[0] || '';
  const hits = block.match(/target\.playerId === p\.playerId/g) || [];
  assert.equal(hits.length, 1);
});

test('モバイルの主要小型操作は44px以上のタップ領域を確保する', () => {
  assert.match(css, /@media\(max-width:900px\)\{[\s\S]*?\.miniRules,\.rulesHead button\{min-width:44px;min-height:44px\}/);
  assert.match(css, /\.chatTop select,\.shopRow button\{min-height:44px\}/);
  assert.match(css, /\.shopRow button\{min-width:44px\}/);
});

test('統合済み会話・行動UIに旧10秒行動画面のCSS残骸を残さない', () => {
  assert.doesNotMatch(css, /#actionPanel|#lockAction|#actionComposer|#lockCount|\.actionPanel|\.quickOps/);
});

test('通信切断時は再接続状態を画面上でも明示する', () => {
  assert.match(html, /id="reconnectBanner"/);
  assert.match(html, /data-connection-state=/);
  assert.match(app, /function setConnectionState\(mode\)/);
  assert.match(app, /socket\.on\('disconnect'[\s\S]*setConnectionState\(state \? 'reconnecting' : 'offline'\)/);
  assert.match(app, /socket\.on\('connect'[\s\S]*setConnectionState\('online'\)/);
});

test('対戦フェーズ名は会話制限時間と結果発表の2段階を明示する', () => {
  assert.match(app, /chat:'会話制限時間'/);
  assert.doesNotMatch(app, /action:'バトル中'/);
  assert.match(app, /result:'結果発表'/);
  assert.match(html, /id="phaseLabel">会話制限時間/);
});

test('右上タイマーは分秒表示で秘密目標を直下に置く', () => {
  assert.match(html, /id="phaseLabel">会話制限時間<\/span><strong id="timer">10分00秒<\/strong>/);
  assert.match(html, /class="phaseBox"[\s\S]*class="hudObjective"/);
  assert.match(app, /return `\$\{minutes\}分\$\{String\(secs\)\.padStart\(2, '0'\)\}秒`/);
});

test('偵察UIはHP・キル数・通常カードだけを表示対象にし秘匿情報を明示する', () => {
  assert.match(app, /SCOUT_VISIBLE_NORMAL_KEYS = \['attack', 'defense', 'scout', 'accusation', 'heal'\]/);
  assert.match(app, /特殊カード・ポイント・秘密目標は偵察では確認できません/);
  assert.match(app, /noteValue\.textContent = 'HP・キル・通常カード'/);
  assert.doesNotMatch(app, /SCOUT_VISIBLE_NORMAL_KEYS[^;]*fullDefense/);
});

test('公開ディレクトリに旧UIバックアップを残さない', () => {
  for (const name of ['app.before-premium.js','index.before-premium.html','styles.before-premium.css','mock_result.html']) {
    assert.equal(fs.existsSync(path.join(root, 'public', name)), false, `${name}は公開領域から削除する`);
  }
});

test('新規の主要ゲームUIに不要な英語状態ラベルを残さない', () => {
  assert.doesNotMatch(app, /SCOUT INTEL|LOCKED|`TURN \$\{report\.turn\}`/);
  assert.doesNotMatch(css, /content:\s*"POINT"/);
});

test('静的なカード・秘密目標定義はSocket初回stateだけ送って高頻度stateを軽量化する', () => {
  assert.match(server, /includeCatalog = true/);
  assert.match(server, /const includeCatalog = !liveSocket\?\.data\?\.catalogSent/);
  assert.match(server, /liveSocket\.data\.catalogSent = true/);
  assert.match(app, /\['normalCards','specialCards','objectives','rules'\]/);
  assert.match(app, /state\?\.\[key\]/);
});


test('依存関係の既知DoS修正版をoverridesで固定する', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.overrides?.['socket.io-parser'], '4.2.7');
  assert.equal(pkg.overrides?.['engine.io'], '6.6.10');
  assert.equal(pkg.overrides?.ws, '8.21.3');
  assert.equal(pkg.overrides?.['body-parser'], '2.3.0');
});

test('チャット等の文字列正規化で制御文字・不可視偽装・改行スパムを除去する', () => {
  assert.match(server, /\\u061C\\u200B\\u200E\\u200F/);
  assert.match(server, /\\u202A-\\u202E/);
  assert.match(server, /\\u2060\\u2066-\\u2069\\uFEFF/);
  assert.match(server, /replace\(\/\[\\t\\r\\n\]\+\/g, ' '\)/);
});

test('結果発表後も直前ターンの結果を確認できる', () => {
  assert.match(html, /id="previousResultCard"/);
  assert.match(app, /function renderPreviousResult\(\)/);
  assert.match(app, /state\?\.phase !== 'result'/);
});


test('会話中の行動選択は通常・特殊カードを同一画面に5列で揃える', () => {
  assert.match(css, /#game\.portraitGame #draftPanel \.cardGrid,#game\.portraitGame #draftPanel \.specialGrid[\s\S]*grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
  assert.match(html, /id="draftPanel"[\s\S]*?行動選択/);
  assert.doesNotMatch(html, /id="actionPanel"/);
});

test('カード効果文は画像内テキストだけに依存せず正式ルール文をHTMLで重ねる', () => {
  assert.match(app, /gameCardEffectOverlay/);
  assert.match(app, /cancel:[\s\S]*?相手1人の通常・特殊行動を無効化/);
  assert.match(css, /\.gameCardEffectOverlay\{/);
});

test('プライベート部屋は共有リンクを作成でき招待URLからコードを事前入力する', () => {
  assert.match(html, /id="shareRoom"/);
  assert.match(app, /function sharePrivateRoom\(\)/);
  assert.match(app, /url\.hash = `room=\$\{state\.code\}`/);
  assert.match(app, /function prepareInviteFromUrl\(\)/);
  assert.match(app, /searchParams\.get\('room'\)/);
  assert.match(app, /hashParams\.get\('room'\)/);
  assert.match(app, /prepareInviteFromUrl\(\);/);
});

test('会話クイック操作はスクロールせず購入・譲渡・偵察を同一画面オーバーレイで開く', () => {
  assert.match(html, /data-tool-target="scoutBox">偵察履歴<\/button>/);
  assert.match(app, /function closeToolDrawer\(\)/);
  assert.match(css, /#toolDrawer\.open\{/);
});

test('待機中にカード画像を先読みして1ターン目描画遅延を減らす', () => {
  assert.match(app, /function preloadCardArt\(\)/);
  assert.match(app, /function renderLobby\(\)[\s\S]*?preloadCardArt\(\)/);
});

test('カード画像はリビジョン付きURLとimmutable長期キャッシュを使う', () => {
  assert.match(app, /const ASSET_REV = '20260911cardsExact'/);
  assert.match(app, /\/cards\/attack\.webp\?v=\$\{ASSET_REV\}/);
  assert.match(server, /app\.use\('\/cards',[\s\S]*?maxAge:\s*'365d'[\s\S]*?immutable:\s*true/);
});


test('サーバー履歴上限は実際にクライアントへ返す件数と一致し不要メモリを持たない', () => {
  assert.match(server, /const CHAT_HISTORY_LIMIT = 160/);
  assert.match(server, /const LOG_HISTORY_LIMIT = 80/);
  assert.match(server, /room\.chat\.length > CHAT_HISTORY_LIMIT/);
  assert.match(server, /room\.logs\.length > LOG_HISTORY_LIMIT/);
  assert.doesNotMatch(server, /room\.chat\.length > 500/);
  assert.doesNotMatch(server, /room\.logs\.length > 180/);
});

test('招待コードは新規共有URLではフラグメントへ置きRefererへ送らない', () => {
  assert.match(app, /url\.hash = `room=\$\{state\.code\}`/);
  assert.match(app, /hashParams\.get\('room'\)/);
  assert.match(server, /Referrer-Policy', 'no-referrer'/);
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
});

test('カード画像が遅延・失敗してもカード名フォールバックが残る', () => {
  assert.match(app, /gameCardFallback/);
  assert.match(app, /image\.addEventListener\('error',[\s\S]*?imageFailed/);
  assert.match(css, /\.gameCardFallback\{/);
  assert.match(css, /\.gameCard\.imageFailed \.gameCardImage\{visibility:hidden\}/);
});

test('Socket軽量stateでもカード定義カタログをクライアント側で保持する', () => {
  assert.match(app, /for \(const key of \['normalCards','specialCards','objectives','rules'\]\)/);
  assert.match(app, /if \(!Object\.prototype\.hasOwnProperty\.call\(next, key\) && state\?\.\[key\] != null\) next\[key\] = state\[key\]/);
});

test('配布ルートにローカル監査スクリーンショットを混入させない', () => {
  for (const name of ['action_1440.png','action_390.png','action_360.png']) {
    assert.equal(fs.existsSync(path.join(root, name)), false, `${name}は配布物へ含めない`);
  }
});

test('Dockerへローカル監査スクリーンショットをコピーしない', () => {
  const ignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8');
  assert.match(ignore, /action_\*\.png/);
  assert.match(ignore, /mock_\*\.png/);
  assert.match(ignore, /real_\*\.png/);
});


test('AFKは2ターン連続無操作で警告し3ターン連続で自動脱落する', () => {
  assert.match(server, /p\.afkStreak = \(p\.afkStreak \|\| 0\) \+ 1/);
  assert.match(server, /p\.afkStreak === 2/);
  assert.match(server, /次のターンも無操作の場合は脱落します/);
  assert.match(server, /p\.afkStreak >= 3/);
  assert.match(server, /p\.hp = 0/);
  assert.match(server, /p\.alive = false/);
  assert.match(server, /p\.stats\?\.survivedTurns > 0/);
  assert.match(server, /\['nearDeath', 'hermit'\]\.includes/);
  assert.match(html, /id="afkWarningBanner"/);
});

test('有効な手動操作でAFK連続カウント対象から外れ、切断自動進行は手動扱いしない', () => {
  const marks = server.match(/markTurnActivity\(room, p\)/g) || [];
  assert.ok(marks.length >= 8, `manual activity hooks: ${marks.length}`);
  assert.match(server, /p\.turnHadManualInput = false/);
  assert.match(server, /if \(p\.turnHadManualInput\) \{[\s\S]*?p\.afkStreak = 0/);
  assert.doesNotMatch(server, /autoAdvance[\s\S]{0,80}markTurnActivity/);
});

test('カード指定タイムアウトは必要対象を自動補完して指定カード自体を実行する', () => {
  const engine = fs.readFileSync(path.join(root, 'src', 'engine.js'), 'utf8');
  assert.match(engine, /validOthers\[crypto\.randomInt\(validOthers\.length\)\]\.playerId/);
  assert.match(engine, /OBJECTIVES\[crypto\.randomInt\(OBJECTIVES\.length\)\]\.key/);
  assert.match(fs.readFileSync(path.join(root, 'RULES.md'), 'utf8'), /2ターン連続で無操作なら本人へ警告/);
  assert.match(fs.readFileSync(path.join(root, 'RULES.md'), 'utf8'), /3ターン連続で無操作ならHP0として自動脱落/);
});


test('10ターン目以降の本人専用順位表示をUIとstateに持つ', () => {
  assert.match(html, /id=["']standingStat["']/);
  assert.match(html, /id=["']mobileStandingWrap["']/);
  assert.match(app, /me\.currentStanding/);
  assert.match(server, /room\.turn >= 10 \? currentPointsStanding/);
});

test('会話・行動選択は10分、行動専用フェーズなし、結果は1分', () => {
  const rules = fs.readFileSync(path.join(root, 'src', 'rules.js'), 'utf8');
  assert.match(rules, /const CHAT_SECONDS = 600;/);
  assert.match(rules, /const ACTION_SECONDS = 0;/);
  assert.match(rules, /const RESULT_SECONDS = 60;/);
  assert.doesNotMatch(server, /function beginAction\(/);
});

test('会話中の次へは選択を厳格検証して全員完了なら直接結果処理する', () => {
  const block = server.match(/socket\.on\('setReady'[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.match(block, /validateDraft\(room, p, p\.draft, \{ strict: true \}\)/);
  assert.match(block, /p\.actionLocked = p\.ready/);
  assert.match(block, /allAliveReady\(room\)\) resolveAndShowResult\(room\)/);
});

test('結果は1分待機し接続中の人間全員が次へなら早送りできる', () => {
  assert.match(server, /function resultVoters\(room\)/);
  assert.match(server, /room\.players\.filter\(p => !p\.isCpu && p\.connected\)/);
  assert.match(server, /socket\.on\('nextResult'/);
  assert.match(server, /if \(allResultReady\(room\)\) advanceFromResult\(room\)/);
  assert.match(html, /id="resultNextBtn"/);
  assert.match(html, /id="resultTimer">1分00秒</);
});

test('通常画面はページスクロールなしの一画面構成でカード列を固定する', () => {
  assert.match(css, /#game\.active\{height:100dvh;min-height:100dvh;overflow:hidden/);
  assert.match(css, /#game\.portraitGame #draftPanel \.cardGrid,#game\.portraitGame #draftPanel \.specialGrid[\s\S]*grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
  assert.doesNotMatch(app, /scrollIntoView\(/);
  assert.doesNotMatch(html, /id="actionPanel"/);
});

test('結果フェーズは通常ゲームUIを隠して結果だけの画面に切り替える', () => {
  assert.match(app, /classList\.toggle\('resultOnly', isResult\)/);
  assert.match(css, /#game\.portraitGame\.resultOnly \.portraitHud[\s\S]*display:none!important/);
  assert.match(css, /#game\.portraitGame\.resultOnly \.resultPanel\{display:flex!important;height:100%;/);
});

test('Gemini 3.8向け生成設定は非推奨sampling knobsを送らない', () => {
  const ai = fs.readFileSync(path.join(root, 'src/cpu-ai.js'), 'utf8');
  assert.doesNotMatch(ai, /temperature\s*:|topP\s*:|top_p\s*:|topK\s*:|top_k\s*:/);
  assert.match(ai, /thinkingConfig:\s*\{\s*thinkingLevel:\s*'low'\s*\}/);
});

test('最大ストレスは標準で10万試合かつ2倍攻撃の第2対象も探索する', () => {
  const stress = fs.readFileSync(path.join(root, 'scripts/stress.js'), 'utf8');
  assert.match(stress, /GOGI_STRESS_GAMES \|\| '100000'/);
  assert.match(stress, /d\.special === 'double' && d\.normal === 'attack'[\s\S]*secondNormalTargetId/);
});


test('UI修正版はルール見出しの縦線を消し、モバイルの本文幅を拡張する', () => {
  assert.match(css, /USER UI FIX 2026-09-11/);
  assert.match(css, /\.rulesDialog \.rulesBody h3\{[\s\S]*border-left:0!important;[\s\S]*padding-left:0!important;/);
  assert.match(css, /\.rulesDialog \.rulesBody h3::before\{[\s\S]*content:none!important;[\s\S]*display:none!important;/);
  assert.match(css, /width:calc\(100vw - 8px\)!important/);
});

test('UI修正版はカード画像を元比率のまま全表示し、秘密目標説明も表示する', () => {
  assert.match(css, /max-height:none!important;[\s\S]*aspect-ratio:544\/928!important/);
  assert.match(css, /#game\.portraitGame #draftPanel \.gameCardImage\{[\s\S]*object-fit:contain!important/);
  assert.match(css, /#game\.portraitGame \.hudRight>\.hudObjective small\{[\s\S]*display:block!important/);
  assert.match(app, /\$\('#objectiveDesc'\)\.textContent = me\.objective\?\.description \|\| ''/);
});

test('UI修正版はHUDとチャットの間に余白を確保する', () => {
  assert.match(css, /#game\.portraitGame \.portraitGrid\{[\s\S]*margin-top:4px!important;[\s\S]*height:calc\(100dvh - 126px\)!important/);
});
