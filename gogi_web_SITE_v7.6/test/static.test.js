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

test('ルール画面に10種類すべての秘密目標名が載っている', () => {
  const { OBJECTIVES } = require('../src/rules');
  for (const obj of OBJECTIVES) assert.ok(html.includes(obj.label), `${obj.label}がルール画面に必要`);
});

test('resumeは既に別ルームへ参加中の同一Socketからの乗っ取りを拒否する', () => {
  assert.match(server, /socket\.on\('resume'[\s\S]*?if \(socket\.data\.roomId\) return safeCb\(cb, \{ ok: false, message: 'すでに参加中です。' \}\)/);
});

test('ポイント譲渡・カード単独譲渡を廃止し、交換だけを承認制で使う', () => {
  assert.doesNotMatch(server, /socket\.on\('transferPoints'/);
  assert.doesNotMatch(server, /socket\.on\('respondTransfer'/);
  assert.doesNotMatch(server, /socket\.on\('cancelTransfer'/);
  assert.doesNotMatch(server, /socket\.on\('transferCard'/);
  assert.doesNotMatch(app, /emitMutation\('transferPoints'/);
  assert.doesNotMatch(app, /emitMutation\('transferCard'/);
  assert.match(server, /socket\.on\('createExchange'/);
  assert.match(server, /socket\.on\('respondExchange'/);
  assert.match(server, /socket\.on\('cancelExchange'/);
  assert.match(server, /expirePendingExchanges\(room\)/);
  assert.match(app, /0枚（カードなし）/);
  assert.match(app, /ポイント0P・カード0枚/);
  assert.match(html, /ポイント譲渡・カード譲渡の独立機能は廃止/);
});

test('購入・交換・公開契約は操作IDでACK再送時の二重処理を防ぐ', () => {
  assert.match(server, /function checkMutation\(p, scope, opId\)/);
  assert.match(server, /function commitMutation\(p, key\)/);
  for (const key of ['buy','createExchange','respondExchange','postPublicContract','acceptPublicContract']) {
    assert.match(server, new RegExp(`checkMutation\\(p, '${key}', opId\\)`));
  }
  for (const key of ['buy','createExchange','respondExchange','postPublicContract','acceptPublicContract']) {
    assert.match(app, new RegExp(`emitMutation\\('${key}'`));
  }
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

test('交換UIは再描画で選択値を失いにくい状態保持を持つ', () => {
  assert.match(app, /const tradeUi =/);
  assert.match(app, /tradeUi\.exchangeTarget/);
  assert.match(app, /tradeUi\.offerPoints/);
  assert.match(app, /tradeUi\.requestPoints/);
  assert.doesNotMatch(app, /tradeUi\.pointTarget/);
  assert.doesNotMatch(app, /const infoUi =/);
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
  for (const name of ['resume','publicMatch','createPrivate','joinPrivate','setReady','setDraft','nextResult','chat','buy','createExchange','respondExchange','cancelExchange','postPublicContract','acceptPublicContract','cancelPublicContract']) {
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
  assert.match(app, /if \(!\['resume','leaveRoom'\]\.includes\(event\)\)[\s\S]*await sessionReadyPromise/);
  assert.match(app, /socket\.on\('connect', \(\) => \{ sessionReadyPromise = tryResume\(\); \}\)/);
});

test('resumeはACK消失後の同一Socket再送を冪等成功させる', () => {
  const block = server.match(/socket\.on\('resume'[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.match(block, /current\.p\.sessionToken === token/);
  assert.match(block, /duplicate: true/);
  assert.match(block, /includeHistory: true/);
});

test('チャットは操作IDでACK再送の二重投稿を防ぐ', () => {
  assert.match(server, /checkMutation\(p, 'chat', opId\)/);
  assert.match(app, /emitMutation\('chat'/);
  assert.doesNotMatch(server, /socket\.on\('infoStatement'/);
  assert.doesNotMatch(app, /emitMutation\('infoStatement'/);
});

test('再接続でSocketレート制限をリセットしてもプレイヤー単位制限が残る', () => {
  assert.match(server, /function allowPlayer\(p, key, limit, windowMs\)/);
  for (const key of ['resume','ready','draft','chat','buy','createExchange','respondExchange','cancelExchange','postPublicContract','acceptPublicContract','cancelPublicContract']) {
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

test('交換はポイント0P・カード0枚を許可し、両側完全空だけ拒否する', () => {
  assert.match(app, /points\.min='0'/);
  assert.match(app, /points\.step='5'/);
  assert.match(app, /0枚（カードなし）/);
  assert.match(app, /offerPoints > 0 \|\| offerCardType \|\| requestPoints > 0 \|\| requestCardType/);
  assert.match(server, /!bundleHasAsset\(offer\) && !bundleHasAsset\(request\)/);
});

test('一時的なresume通信欠落は冪等再送し、失敗時も画面とtokenを即破棄しない', () => {
  assert.match(app, /res\.transient && attempt < 2/);
  assert.match(app, /if \(res\.transient\)[\s\S]*return res/);
});

test('プライベートルームも5人目の参加直後に自動開始判定する', () => {
  const block = server.match(/socket\.on\('joinPrivate'[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.match(block, /safeCb\(cb, \{ ok: true, sessionToken: p\.sessionToken \}\);[\s\S]*maybeStart\(room\)/);
});

test('プライベートルームは5人参加済みなら一時切断者がいても開始できる', () => {
  const block = server.match(/function maybeStart\(room\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(block, /room\.players\.length !== MAX_PLAYERS/);
  assert.match(block, /room\.isPublic && !room\.players\.every\(p => p\.connected\)/);
  assert.doesNotMatch(block, /if \(!room\.players\.every\(p => p\.connected\)\) return/);
});

test('ゲーム終了画面ではWebSocketを解放し、待機退出は旧正常版のresume非依存方式を使う', () => {
  assert.match(app, /state\.status === 'finished'[\s\S]*socket\.connected[\s\S]*socket\.disconnect\(\)/);
  const leaveBlock = app.match(/let leavingRoom = false;[\s\S]*?async function leaveCurrentRoom\(\) \{[\s\S]*?\}(?=\s*\$\('#showJoin'\))/)?.[0] || '';
  assert.match(app, /!\['resume','leaveRoom'\]\.includes\(event\)/);
  assert.match(leaveBlock, /emitAck\('leaveRoom', \{ sessionToken: leavingToken \}, 3500\)/);
  assert.match(leaveBlock, /if \(leavingRoom\) return/);
  assert.match(leaveBlock, /leaveButton\.disabled = true/);
  assert.match(leaveBlock, /clearSessionToken\(leavingToken\)[\s\S]*state = null[\s\S]*show\('#home'\)/);
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


test('ホーム閲覧だけではWebSocketを自動接続せず、待機退出完了後もSocketを残さない', () => {
  assert.match(app, /io\(\{ transports: \['websocket', 'polling'\], autoConnect: false \}\)/);
  assert.match(app, /if \(resumeTokenCandidate\(\)\) socket\.connect\(\)/);
  assert.match(app, /function disconnectIdleSocket\(\)/);
  const leaveBlock = app.match(/let leavingRoom = false;[\s\S]*?async function leaveCurrentRoom\(\) \{[\s\S]*?\}(?=\s*\$\('#showJoin'\))/)?.[0] || '';
  assert.match(leaveBlock, /emitAck\('leaveRoom', \{ sessionToken: leavingToken \}, 3500\)/);
  assert.match(leaveBlock, /state = null[\s\S]*show\('#home'\)/);
  assert.match(leaveBlock, /disconnectIdleSocket\(\)/);
});


test('購入・非公開交換の状態更新は関係者だけへ送る', () => {
  const buyBlock = server.match(/socket\.on\('buy'[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.match(buyBlock, /emitPlayerState\(room, p\)/);
  assert.doesNotMatch(buyBlock, /emitState\(room\)/);

  const exchangeBlock = server.match(/socket\.on\('createExchange'[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.match(exchangeBlock, /emitPlayerState\(room, p\)/);
  assert.match(exchangeBlock, /emitPlayerState\(room, target\)/);
  assert.doesNotMatch(exchangeBlock, /emitState\(room\)/);
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

test('カード指定の最後の指定カードを交換に出して強制行動を回避できない', () => {
  assert.match(server, /canTransferNormalCard\(room, owner, key\)/);
  assert.match(server, /カード指定中の最後の指定カードは交換に出せません/);
  assert.doesNotMatch(server, /socket\.on\('transferCard'/);
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
  assert.match(app, /function sharePrivateRoom\(event\)/);
  assert.match(app, /url\.hash = `room=\$\{code\}`/);
  assert.match(app, /function prepareInviteFromUrl\(\)/);
  assert.match(app, /searchParams\.get\('room'\)/);
  assert.match(app, /hashParams\.get\('room'\)/);
  assert.match(app, /prepareInviteFromUrl\(\);/);
  assert.match(html, /id="inviteDialog"/);
  assert.match(app, /shareRoomButton\?\.addEventListener\('click', sharePrivateRoom\)/);
  assert.doesNotMatch(app, /event\.target\?\.closest\?\.\('#shareRoom'\)/);
  assert.match(app, /openInviteFallback\(info\)/);
});

test('会話クイック操作はスクロールせず購入・取引・偵察を同一画面オーバーレイで開く', () => {
  assert.match(html, /data-tool-target="scoutBox">偵察履歴<\/button>/);
  assert.match(app, /function closeToolDrawer\(\)/);
  assert.match(css, /#toolDrawer\.open\{/);
});

test('待機中にカード画像を先読みして1ターン目描画遅延を減らす', () => {
  assert.match(app, /function preloadCardArt\(\)/);
  assert.match(app, /function renderLobby\(\)[\s\S]*?preloadCardArt\(\)/);
});

test('カード画像はリビジョン付きURLとimmutable長期キャッシュを使う', () => {
  assert.match(app, /const ASSET_REV = '20260912decisive1'/);
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
  assert.match(app, /url\.hash = `room=\$\{code\}`/);
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
  assert.match(server, /p\.stats\.eliminatedTurn = room\.turn/);
  assert.match(server, /const afkAchieved = evaluateObjectives\(room, result\.scoreEvents\)/);
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
  assert.doesNotMatch(rules, /ACTION_SECONDS/);
  assert.match(rules, /const RESULT_SECONDS = 60;/);
  assert.doesNotMatch(server, /function beginAction\(/);
  assert.doesNotMatch(server, /actionLocked|autoLockSeq/);
  assert.doesNotMatch(app, /actionLocked/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'src', 'engine.js'), 'utf8'), /\['chat', 'action'\]|room\.phase === 'action'/);
});

test('会話中の次へは選択を厳格検証して全員完了なら直接結果処理する', () => {
  const block = server.match(/socket\.on\('setReady'[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.match(block, /validateDraft\(room, p, p\.draft, \{ strict: true \}\)/);
  assert.doesNotMatch(block, /actionLocked/);
  assert.match(block, /allAliveReady\(room\)\) resolveAndShowResult\(room\)/);
});

test('結果は1分待機し接続中の人間全員が次へなら早送りできる', () => {
  assert.match(server, /function resultVoters\(room\)/);
  assert.match(server, /room\.players\.filter\(p => p\.connected\)/);
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


test('最大ストレスは標準で10万試合かつ2倍攻撃の第2対象も探索する', () => {
  const stress = fs.readFileSync(path.join(root, 'scripts/stress.js'), 'utf8');
  assert.match(stress, /GOGI_STRESS_GAMES \|\| '100000'/);
  assert.match(stress, /d\.special === 'double' && d\.normal === 'attack'[\s\S]*secondNormalTargetId/);
});

test('最大ストレスは他人防御・他人回復・ターン開始ボーナス・1位予想・最終順位まで探索する', () => {
  const stress = fs.readFileSync(path.join(root, 'scripts', 'stress.js'), 'utf8');
  assert.match(stress, /\['defense','heal'\]/);
  assert.match(stress, /awardTurnStartBonus\(room\)/);
  assert.match(stress, /maybePlaceWinnerBets\(room, rng\)/);
  assert.match(stress, /awardSurvivalBonus\(room\)/);
  assert.match(stress, /settleWinnerBets\(room, preBetRanking\)/);
  assert.match(stress, /Number\.isInteger\(p\.points \* 2\)/);
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


test('CPプレイヤー機能を配布物から除去する', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const engine = fs.readFileSync(path.join(root, 'src/engine.js'), 'utf8');
  assert.doesNotMatch(server, /startWithCpu|prepareCpu|scheduleCpu|fillRoomWithCpu|isCpu/);
  assert.doesNotMatch(app, /startWithCpu|isCpu|（CP）/);
  assert.doesNotMatch(html, /startWithCpu|CPで補充|CPで穴埋め/);
  assert.doesNotMatch(engine, /isCpu|cpuBrain/);
  assert.equal(fs.existsSync(path.join(root, 'src/cpu.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'src/cpu-ai.js')), false);
});


test('正直者・詐欺師と情報発言機能を配布物から完全削除する', () => {
  const rules = fs.readFileSync(path.join(root, 'src', 'rules.js'), 'utf8');
  const engine = fs.readFileSync(path.join(root, 'src', 'engine.js'), 'utf8');
  for (const removed of ['giver','accomplice','avenger','executioner','liar','honest']) assert.doesNotMatch(rules, new RegExp(`key: '${removed}'`));
  assert.doesNotMatch(html, /openInfoStatement|infoStatementControls|正直者|詐欺師/);
  assert.doesNotMatch(app, /infoUi|renderInfoStatementControls|infoStatement/);
  assert.doesNotMatch(server, /infoStatement|recordStructuredStatement/);
  assert.doesNotMatch(engine, /recordStructuredStatement|evaluateStructuredStreak|pendingInfoByTurn|infoByTurn/);
});

test('新秘密目標10種と最終得点体系がルール表示に反映される', () => {
  for (const label of ['観察者','追跡者','賭け師','殺人鬼','死神','鉄壁','耐久者','瀕死','無防備','隠者']) assert.match(html, new RegExp(label));
  assert.match(html, /告発失敗-10P/);
  assert.match(html, /攻撃成功\+10P/);
  assert.match(html, /防御成功\+10P/);
  assert.match(html, /告発成功\+25P/);
  assert.match(html, /秘密目標\+25P/);
  assert.match(html, /何ターン目でも/);
});


test('最終ターンは秘密目標・生存・ポイント移動を除いて2倍と表示される', () => {
  assert.match(html, /生存\+50P/);
  assert.match(html, /告発失敗-10P/);
  assert.match(html, /2倍対象外/);
});


test('公開契約は全員へ公開し次ターンの有効攻撃で自動判定する', () => {
  assert.match(html, /data-tool-target="contractBox"/);
  assert.match(app, /function renderPublicContracts\(\)/);
  assert.match(server, /socket\.on\('postPublicContract'/);
  assert.match(server, /socket\.on\('acceptPublicContract'/);
  assert.match(server, /settleDuePublicContracts\(room, result\)/);
  assert.match(server, /lastEffectiveActions/);
  assert.match(server, /conditionType === 'attackTarget'/);
  assert.match(server, /conditionType === 'dontAttackIssuer'/);
});

test('1位予想は試合中非公開で、終了時は全員分を公開する', () => {
  assert.match(server, /room\.status === 'finished' \? room\.winnerBetResults\.map/);
  assert.match(server, /filter\(x => x\.playerId === p\.playerId\)/);
  assert.match(html, /1位予想結果｜全員公開/);
  assert.match(html, /試合中は誰に・何P・何ターンで賭けたかを本人以外へ公開しません/);
  assert.match(html, /試合終了時に全員の予想相手/);
  assert.match(app, /1位予想の参加者はいません/);
  assert.match(app, /result\.color/);
});

test('1位予想UIと二段階順位発表を持つ', () => {
  const html = require('fs').readFileSync(require('path').join(__dirname,'../public/index.html'),'utf8');
  const app = require('fs').readFileSync(require('path').join(__dirname,'../public/app.js'),'utf8');
  const server = require('fs').readFileSync(require('path').join(__dirname,'../server.js'),'utf8');
  assert.match(html, /data-tool-target="winnerBetBox"/);
  assert.match(html, /id="preBetRanking"/);
  assert.match(html, /id="winnerBetResults"/);
  assert.match(html, /id="postBetStage"/);
  assert.match(app, /placeWinnerBet/);
  assert.match(server, /socket\.on\('placeWinnerBet'/);
});


test('ターン結果画面は本人の結果1区分だけを表示する', () => {
  assert.match(app, /createResultSection\('結果', 'private', items\)/);
  assert.doesNotMatch(app, /createResultSection\('公開結果'/);
  assert.doesNotMatch(app, /createResultSection\('自分だけの結果'/);
  assert.doesNotMatch(app, /createResultSection\('ポイント増減'/);
  assert.match(server, /return \{ turn: r\.turn, items:/);
});

test('結果は成功失敗・偵察・HP純増減・ポイント純増減だけを組み立てる', () => {
  assert.match(server, /NORMAL_CARDS\[normal\]\.label\}\$\{success \? '成功' : '失敗'\}/);
  assert.match(server, /偵察結果：\$\{e\.report\.color\}/);
  assert.match(server, /HP\$\{signedDelta\(hpDelta\)\}　ポイント\$\{signedDelta\(pointDelta\)\}/);
});

test('カード指定中は通常カードだけを指定し特殊カード併用可を指定者非公開で明示する', () => {
  assert.match(app, /通常カードは「\$\{cardLabel\(me\.forcedNormalType\.type\)\}」しか使えません。特殊カードは併用できます/);
  assert.match(app, /forcedKey !== key/);
  assert.doesNotMatch(app, /指定者[:：]/);
});

test('公開契約は25P刻みで達成者1人につき契約ポイントの5分の1を配布する', () => {
  assert.match(app, /reward\.min='25'; reward\.step='25'/);
  assert.match(server, /validContractStake\(n, p\.points\)/);
  assert.match(server, /contractRewardPerPlayer\(contract\.reward\)/);
  assert.match(server, /contractSettlement\(contract\.reward, successCount\)/);
});

test('5・10・15ターンの固定Pはターン開始時に付与し、15T+15Pと完走+50Pは2倍にしない', () => {
  const engine = require('fs').readFileSync(require('path').join(__dirname,'../src/engine.js'),'utf8');
  assert.match(server, /function beginChat\(room\)[\s\S]*awardTurnStartBonus\(room\)/);
  assert.match(engine, /TURN_START_BONUSES/);
  assert.match(engine, /awardPoints\(room, p, amount, `第\$\{room\.turn\}ターン開始ボーナス`, events, \{ multiplyFinal: false \}\)/);
  assert.match(engine, /awardPoints\(room, p, SCORING\.survival, '15ターン生存', events, \{ multiplyFinal: false \}\)/);
  assert.match(server, /if \(room\.turn >= MAX_TURNS \|\| getAlive\(room\)\.length === 0\) return finishGame\(room\)/);
});

test('交換と公開契約は画面通知と効果音を持つ', () => {
  assert.match(html, /id="gameNotice"/);
  assert.match(server, /emitGameNotice\(room/);
  assert.match(server, /kind:'exchange'/);
  assert.match(server, /kind:'contract'/);
  assert.match(app, /socket\.on\('gameNotice'/);
  assert.match(app, /noticeExchange/);
  assert.match(app, /noticeContract/);
});

test('最終順位表は追加操作なしで常時表示する', () => {
  assert.match(html, /id="postBetStage"/);
  assert.doesNotMatch(html, /id="showBetSettlement"/);
  assert.match(app, /classList\.remove\('hidden'\)/);
  assert.match(app, /appendRankingRows\(\$\('#ranking'\), finalRows\)/);
});


test('タイトル直下は効果音ON/OFFだけを持ち端末設定を保存する', () => {
  assert.doesNotMatch(html, /id="bgmToggle"/);
  assert.match(html, /id="sfxToggle"/);
  assert.match(css, /\.audioToggles/);
  assert.doesNotMatch(app, /AUDIO_BGM_KEY/);
  assert.match(app, /AUDIO_SFX_KEY/);
  assert.match(app, /AudioContext|webkitAudioContext/);
  assert.match(app, /storageSet\(localStore/);
  assert.match(app, /chatPrivate/);
  assert.doesNotMatch(app, /function startBgm\(/);
});

test('個別チャットは選択した相手ごとに履歴を分離する', () => {
  assert.match(app, /function messageBelongsToChannel\(/);
  assert.match(app, /function visibleChatMessages\(/);
  assert.match(app, /\$\('#chatTarget'\)\?\.addEventListener\('change'/);
  assert.match(app, /option\.textContent = `\$\{colorLabel\(p\)\}個別チャット`/);
  assert.doesNotMatch(app, /【\$\{privateChatLabel\(message\)\}】/);
});


test('通常防御は他人を対象にでき、完全防御は自分専用である', () => {
  const engine = fs.readFileSync(path.join(root, 'src/engine.js'), 'utf8');
  assert.match(app, /defensePlayerOptions/);
  assert.match(app, /const targetLabel = '対象を選択'/);
  assert.doesNotMatch(app, /防御対象を選択|回復対象を選択|告発対象を選択|防御する対象|回復する対象|通常カードの対象/);
  assert.match(engine, /defenseClaims/);
  assert.match(engine, /a\.special === 'fullDefense'\) fullDefense\.add\(a\.p\.playerId\)/);
  assert.match(html, /完全防御[\s\S]*他人には使用できない/);
});

test('公開契約は防御・告発条件を持ち、告発は成否不問で色名表示する', () => {
  assert.match(server, /defendIssuer/);
  assert.match(server, /accuseTarget/);
  assert.match(server, /defensesByPlayer/);
  assert.match(server, /accusationsByPlayer/);
  assert.match(app, /指定した色を告発したら報酬（成功・失敗どちらでも可）/);
  assert.match(app, /\$\{myColor\}を防御したら報酬/);
  assert.doesNotMatch(app, /契約主/);
  assert.doesNotMatch(html, /契約主/);
});


test('終了画面で削除済みBGM関数を呼ばず順位を描画する', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.equal(app.includes('stopBgm()'), false);
  const finishedBlock = app.match(/if \(state\.status === 'finished'\) \{([\s\S]*?)\n  \}/)?.[1] || '';
  assert.match(finishedBlock, /show\('#finish'\)/);
  assert.match(finishedBlock, /renderRanking\(\)/);
});


test('公開結果廃止後の内部対戦ログをクライアントへ配信しない', () => {
  assert.doesNotMatch(server, /emit\('logEntry'/);
  assert.doesNotMatch(server, /data\.logs\s*=/);
  assert.doesNotMatch(app, /socket\.on\('logEntry'/);
  assert.doesNotMatch(html, /id="logs"/);
});

test('最終ルール文書は1位予想の終了時公開と公開契約25P刻みで統一される', () => {
  const rulesDoc = fs.readFileSync(path.join(root, 'RULES.md'), 'utf8');
  const decisions = fs.readFileSync(path.join(root, 'RULE_DECISIONS.md'), 'utf8');
  assert.match(rulesDoc, /試合終了時に全員の予想相手/);
  assert.match(decisions, /所持P以内の25P刻み/);
  assert.doesNotMatch(decisions, /第1〜14ターンに、5P刻み報酬/);
});

test('公開契約の精算通知は全プレイヤーへ専用通知で送る', () => {
  assert.match(server, /emitGameNotice\(room, room\.players\.map\(x => x\.playerId\), \{[\s\S]*?kind:'contract'[\s\S]*?公開契約結果/);
});


test('交換の新規提案・期限切れも関係者へ専用通知する', () => {
  const createBlock = server.match(/socket\.on\('createExchange'[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.match(createBlock, /emitGameNotice\(room, \[target\.playerId\][\s\S]*?交換提案が届きました/);
  const expireBlock = server.match(/function expirePendingExchanges\(room\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(expireBlock, /emitGameNotice\(room, \[from\.playerId, to\.playerId\][\s\S]*?自動キャンセル/);
});

test('公開契約の受付終了・参加者なし・取消も専用通知する', () => {
  const expireBlock = server.match(/function expireOpenPublicContracts\(room\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(expireBlock, /emitGameNotice\(room, room\.players\.map\(x => x\.playerId\)[\s\S]*?人参加/);
  assert.match(expireBlock, /参加者なしで終了[\s\S]*?emitGameNotice/);
  const cancelBlock = server.match(/socket\.on\('cancelPublicContract'[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.match(cancelBlock, /emitGameNotice\(room, room\.players\.map\(x => x\.playerId\)[\s\S]*?公開契約を取消/);
});

test('交換承認は必要資産を検証してから操作IDを確定する', () => {
  const block = server.match(/socket\.on\('respondExchange'[\s\S]*?\n  \}\);/)?.[0] || '';
  const acceptStart = block.indexOf('const wantPoints');
  const acceptPart = acceptStart >= 0 ? block.slice(acceptStart) : '';
  const cardTake = acceptPart.indexOf('takeCardForExchange');
  const commit = acceptPart.indexOf('commitMutation(p, mutation.key)');
  assert.ok(acceptStart >= 0 && cardTake >= 0 && commit > cardTake, '承認側の資産検証/確保後にmutationを確定する');
});

test('カード指定案内は通常カードだけを強制し特殊カード併用可と明示する', () => {
  assert.match(app, /通常カードは「\$\{cardLabel\(me\.forcedNormalType\.type\)\}」しか使えません。特殊カードは併用できます/);
  assert.doesNotMatch(app, /指定されているため、このカードしか使えません/);
});

test('現行ルール文書の告発点数・契約参加人数に旧仕様が残らない', () => {
  const rulesDoc = fs.readFileSync(path.join(root, 'RULES.md'), 'utf8');
  const decisions = fs.readFileSync(path.join(root, 'RULE_DECISIONS.md'), 'utf8');
  assert.match(rulesDoc, /成功 \+25P/);
  assert.match(rulesDoc, /失敗 -10P/);
  assert.doesNotMatch(rulesDoc, /成功 \+30P/);
  assert.doesNotMatch(rulesDoc, /失敗 -5P/);
  assert.doesNotMatch(decisions, /受諾は1人/);
  assert.match(decisions, /複数人が参加可能/);
  assert.match(decisions, /\*\*試合中\*\*.*本人以外へ非公開/);
  assert.match(decisions, /\*\*試合終了時\*\*.*全員へ公開/);
});

test('削除済みの未使用ヘルパーを配布コードへ残さない', () => {
  assert.doesNotMatch(server, /function visibleLogs\(/);
  assert.doesNotMatch(server, /function allAliveLocked\(/);
  assert.doesNotMatch(app, /function privateChatLabel\(/);
  assert.doesNotMatch(app, /function objectiveLabel\(/);
});


test('公開契約は攻撃・提示色防御系だけ判定前脱落で取消し、告発契約は脱落者を対象に継続できる', () => {
  const settleBlock = server.match(/function settleDuePublicContracts\(room, result\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(settleBlock, /contract\.conditionType === 'attackTarget'/);
  assert.match(settleBlock, /\['dontAttackIssuer', 'defendIssuer'\]\.includes\(contract\.conditionType\)/);
  assert.match(settleBlock, /: null;/);
  assert.match(settleBlock, /relevantPlayer && !aliveAtTurnStart\(relevantPlayer\)/);
  assert.match(settleBlock, /contract\.status = 'cancelled'/);
  assert.match(settleBlock, /refundPublicContract\(room, contract\)/);
});


test('終了画面のトップへ戻るは通信を待たず専用同期処理でホームへ戻る', () => {
  assert.match(app, /function returnHomeFromFinish\(\)/);
  const block = app.match(/function returnHomeFromFinish\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(block, /clearSessionToken\(leavingToken\)/);
  assert.match(block, /state = null/);
  assert.match(block, /show\('#home'\)/);
  assert.match(block, /disconnectIdleSocket\(\)/);
  assert.doesNotMatch(block, /await\s+/);
  assert.doesNotMatch(block, /emitAck\(/);
  assert.match(app, /#backHome'\)\?\.addEventListener\('click', returnHomeFromFinish\)/);
});


test('秘密目標HUDは短いiPhone/Safari表示領域でも非表示にしない', () => {
  assert.doesNotMatch(css, /\.hudObjective\s*\{\s*display\s*:\s*none/);
  assert.match(css, /hudRight>\.hudObjective\{display:block!important/);
  assert.match(css, /@media\(max-height:760px\)[\s\S]*hudRight>\.hudObjective\{display:block!important;visibility:visible!important;opacity:1!important\}/);
  assert.match(server, /ensureSecretObjectives\(room\);[\s\S]*me:\s*p\s*\?\s*selfView\(p, room\)/);
});


test('購入画面は所持枚数を併記せず購入対象と価格だけを表示する', () => {
  const block = app.match(/function renderInventory\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.doesNotMatch(block, /me\.hand\[key\].*枚/);
  assert.doesNotMatch(block, /me\.specials\[key\].*枚/);
  assert.match(block, /textContent = def\.label/);
});

test('告発UIは脱落者を候補に残し、防御UIは空の対象選択から始まる', () => {
  const accusationOptions = app.match(/function accusationPlayerOptions\([\s\S]*?\n\}/)?.[0] || '';
  assert.match(accusationOptions, /state\?\.players/);
  assert.match(accusationOptions, /（脱落）/);
  assert.match(app, /draft\.normal === 'accusation' \? accusationPlayerOptions\(\) : playerOptions\(\)/);
  assert.match(app, /function defensePlayerOptions\(includeBlank = true\)/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'src/engine.js'), 'utf8'), /d\.normal === 'defense' && !d\.normalTargetId\) d\.normalTargetId = p\.playerId/);
});

test('告発の初期枚数は5枚で公開契約の告発対象も脱落者を許可する', () => {
  const rulesSource = fs.readFileSync(path.join(root, 'src/rules.js'), 'utf8');
  assert.match(rulesSource, /accusation: \{ label: '告発', initial: 5, price: 25 \}/);
  assert.match(server, /aliveOnly: kind !== 'accuseTarget'/);
  assert.match(fs.readFileSync(path.join(root, 'RULES.md'), 'utf8'), /告発 5/);
  assert.match(fs.readFileSync(path.join(root, 'RULES.md'), 'utf8'), /告発は生存者・脱落者どちらも対象/);
});


test('交換提案は同一相手・複数相手へ同時複数件を出せる', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  const createBlock = server.match(/socket\.on\('createExchange'[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.doesNotMatch(createBlock, /同時に出せる交換提案は1件まで/);
  assert.doesNotMatch(createBlock, /exchangeRequests\.some\(x => x\.turn === room\.turn && x\.fromId === p\.playerId\)/);
  const tradeBlock = app.match(/function renderTrade\(\)[\s\S]*?\n\}\n\nfunction renderPublicContracts/)?.[0] || app;
  assert.match(tradeBlock, /交換提案の件数制限なし/);
  assert.doesNotMatch(tradeBlock, /disabled \|\| exchanges\.outgoing\?\.length > 0/);
  assert.match(fs.readFileSync(path.join(root, 'RULES.md'), 'utf8'), /同じ相手へ複数件、複数の相手へ同時に複数件/);
});


test('公開契約は同一ターン・同時複数件を件数制限なく提示できる', () => {
  const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  const createBlock = serverSource.match(/socket\.on\('postPublicContract'[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.doesNotMatch(createBlock, /同時に公開できる契約は1件まで/);
  assert.doesNotMatch(createBlock, /publicContracts\.some\(c => \['open','accepted'\]\.includes\(c\.status\) && c\.issuerId === p\.playerId\)/);
  const contractBlock = appSource.match(/function renderPublicContracts\(\)[\s\S]*?\n\}\n\nfunction renderWinnerBet/)?.[0] || appSource;
  assert.doesNotMatch(contractBlock, /!contracts\.some\(c => c\.issuerId===me\.playerId/);
  assert.match(contractBlock, /公開契約の件数制限なし/);
  assert.match(fs.readFileSync(path.join(root, 'RULES.md'), 'utf8'), /提示件数に制限なし。同じターンに複数件、同時に複数件提示可能/);
});


test('通常カード購入は1ターン回数無制限、特殊カード購入は1試合1回を維持する', () => {
  const buyBlock = server.match(/socket\.on\('buy'[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.doesNotMatch(buyBlock, /通常カード購入は1ターン1回まで/);
  assert.doesNotMatch(buyBlock, /p\.normalPurchasedTurn === room\.turn/);
  assert.doesNotMatch(buyBlock, /p\.normalPurchasedTurn = room\.turn/);
  assert.match(buyBlock, /if \(p\.specialPurchased\) return safeCb\(cb, \{ ok: false, message: '特殊カードは1試合1回まで購入できます。' \}\);/);

  const inventoryBlock = app.match(/function renderInventory\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.doesNotMatch(inventoryBlock, /me\.normalPurchasedThisTurn/);
  assert.match(inventoryBlock, /me\.specialPurchased/);

  const rules = fs.readFileSync(path.join(root, 'RULES.md'), 'utf8');
  assert.match(rules, /通常カード購入は1ターンの回数制限なし/);
  assert.match(rules, /特殊カード購入は1試合1回/);
});


test('偵察UIは脱落者を含む専用対象候補を使う', () => {
  assert.match(app, /function scoutPlayerOptions\(includeBlank = true\)/);
  assert.match(app, /draft\.normal === 'scout' \? scoutPlayerOptions\(\)/);
  assert.match(app, /draft\.normal === 'scout' \? scoutPlayerOptions\(\) : playerOptions\(\)/);
  assert.match(app, /'（脱落）'/);
});




test('待機退出で参照するrenderedLogsKeyはstrict modeでも未定義例外にならない', () => {
  assert.match(app, /let renderedLogsKey = '';/);
});

test('待機をやめるは旧210/210正常版の実装をそのまま使う', () => {
  const leaveBlock = app.match(/let leavingRoom = false;[\s\S]*?async function leaveCurrentRoom\(\) \{[\s\S]*?\}(?=\s*\$\('#showJoin'\))/)?.[0] || '';
  assert.match(app, /!\['resume','leaveRoom'\]\.includes\(event\)/);
  assert.match(leaveBlock, /if \(leavingRoom\) return/);
  assert.match(leaveBlock, /emitAck\('leaveRoom', \{ sessionToken: leavingToken \}, 3500\)/);
  assert.match(leaveBlock, /if \(res\.transient\)/);
  assert.match(leaveBlock, /if \(socket\.connected\) socket\.disconnect\(\)/);
  assert.match(leaveBlock, /disconnectIdleSocket\(\)/);
  assert.doesNotMatch(leaveBlock, /leavingLobby = true/);
  assert.doesNotMatch(leaveBlock, /sessionWritesBlocked = true/);
  assert.doesNotMatch(leaveBlock, /ignoredLobbyRoomKey = leavingRoomKey/);
  assert.doesNotMatch(leaveBlock, /fetch\('\/api\/leave-lobby'/);
});


test('待機退出APIはclientInstanceIdが変わっても同一browserIdの古いロビー枠を掃除する', () => {
  const route = server.match(/app\.post\('\/api\/leave-lobby'[\s\S]*?\n\}\);/)?.[0] || '';
  assert.match(route, /removeLobbyPlayersForBrowser\(requestBrowserId\)/);
  const helper = server.match(/function removeLobbyPlayersForBrowser\(browserId\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(helper, /room\.status !== 'lobby'/);
  assert.match(helper, /p\.browserId === normalizedBrowserId/);
  assert.doesNotMatch(helper, /room\.status === 'playing'/);
});

test('新規参加前にも同一browserIdの古い待機枠を掃除してBROWSER_IN_USEを自己修復する', () => {
  for (const event of ['publicMatch','createPrivate','joinPrivate']) {
    const block = server.match(new RegExp(`socket\\.on\\('${event}'[\\s\\S]*?\\n  \\}\\);`))?.[0] || '';
    assert.match(block, /removeLobbyPlayersForBrowser\(browserId\)/);
  }
});

test('待機室のSocket切断は復帰猶予なしで即プレイヤーを削除する', () => {
  const block = server.match(/socket\.on\('disconnect'[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.match(block, /if \(room\.status === 'lobby'\) \{[\s\S]*removeLobbyPlayer\(room, p\.playerId\);[\s\S]*return;/);
  assert.doesNotMatch(block, /room\.status === 'lobby' \? LOBBY_RECONNECT_GRACE_SECONDS/);
});

test('待機室の自動resumeを無効化し古い待機記録も新規参加前に除去する', () => {
  const resumeBlock = server.match(/socket\.on\('resume'[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.match(resumeBlock, /if \(room\.status === 'lobby'\)[\s\S]*removeLobbyPlayer\(room, p\.playerId\)[\s\S]*LOBBY_RESUME_DISABLED/);
  const recoverBlock = server.match(/function recoverClientJoin\(socket, clientInstanceId, browserId, pageInstanceId\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(recoverBlock, /found\.room\.status === 'lobby'[\s\S]*removeLobbyPlayer\(found\.room, found\.p\.playerId\)[\s\S]*return null/);
});

test('iOSの日本語IME入力中はルームコードを書き換えずcomposition終了後に正規化する', () => {
  assert.match(html, /id="codeInput"[^>]*autocorrect="off"[^>]*autocapitalize="characters"[^>]*spellcheck="false"/);
  assert.match(app, /compositionstart[\s\S]*roomCodeComposing = true/);
  assert.match(app, /compositionend[\s\S]*normalizeRoomCodeValue/);
  assert.match(app, /roomCodeComposing \|\| e\.isComposing \|\| e\.inputType === 'insertCompositionText'/);
});

test('待機室はSocket通知とHTTPポーリングの両方で人数表示の取りこぼしを自己修復する', () => {
  assert.match(app, /setInterval\(requestLobbySync, 2000\)/);
  assert.match(app, /fetch\(`\/api\/lobby\/\$\{encodeURIComponent\(code\)\}/);
  assert.match(app, /socket\.on\('lobbyStatus'/);
  assert.match(server, /function emitLobbyStatus\(room\)/);
  assert.match(server, /io\.to\(room\.id\)\.emit\('lobbyStatus'/);
  assert.match(server, /app\.get\('\/api\/lobby\/:code'/);
});


test('待機室修正版はJS/CSSを新しいリビジョンで読み込み、HTML/JSの旧キャッシュを残さない', () => {
  assert.match(html, /app\.js\?v=20260912leave-runtime-fix1/);
  assert.match(html, /styles\.css\?v=20260912invitefix1/);
  assert.match(server, /Cache-Control', 'no-store, max-age=0'/);
  assert.match(server, /X-Gogi-Build', BUILD_ID/);
});

test('友達招待はWeb Share失敗時にClipboardとlegacy copyへフォールバックする', () => {
  assert.match(app, /function copyTextRobust\(text\)/);
  assert.match(app, /navigator\.share[\s\S]*openInviteFallback\(info\)/);
  assert.match(app, /inviteCopyLink[\s\S]*copyTextRobust\(info\.text\)/);
  assert.match(app, /document\.execCommand\?\.\('copy'\)/);
});


test('プライベート招待はiOSの直接clickで共有し失敗時は可視フォールバックを出す', () => {
  assert.match(app, /shareRoomButton\?\.addEventListener\('click', sharePrivateRoom\)/);
  assert.match(app, /navigator\.share\(\{ title:'五疑戦', text:info\.text \}\)/);
  assert.match(app, /openInviteFallback\(info\)/);
  assert.match(html, /id="inviteNativeShare"/);
  assert.match(html, /id="inviteCopyLink"/);
  assert.match(css, /\.inviteDialog\{/);
  assert.match(html, /app\.js\?v=20260912leave-runtime-fix1/);
  assert.match(html, /styles\.css\?v=20260912invitefix1/);
});




