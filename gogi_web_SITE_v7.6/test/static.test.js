'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const engineFile = fs.readFileSync(path.join(root, 'src/engine.js'), 'utf8');
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
  for (const key of ['buy','createExchange','respondExchange','postPublicContract']) {
    assert.match(server, new RegExp(`checkMutation\\(p, '${key}', opId\\)`));
  }
  for (const key of ['buy','createExchange','respondExchange','postPublicContract']) {
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
  for (const key of ['resume','ready','draft','chat','buy','createExchange','respondExchange','cancelExchange','postPublicContract']) {
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
  assert.match(block, /safeCb\(cb, \{ ok: true, sessionToken: p\.sessionToken, chipBalance:balance \}\);[\s\S]*maybeStart\(room\)/);
});

test('プライベートルームは5人参加済みなら一時切断者がいても開始できる', () => {
  const block = server.match(/function maybeStart\(room\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(block, /room\.players\.length !== MAX_PLAYERS/);
  assert.match(block, /room\.isPublic && !room\.players\.every\(p => p\.connected \|\| isCpu\(p\)\)/);
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
  assert.match(app, /const ASSET_REV = '20260913-complete-final7'/);
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


test('CP実装版は全員同意のCP補充・自動行動・チップ対応を持ち、外部AI接続は持たない', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const engine = fs.readFileSync(path.join(root, 'src/engine.js'), 'utf8');
  assert.match(server, /fillRoomWithCpu/);
  assert.match(server, /buildCpuDraft/);
  assert.match(server, /socket\.on\('fillWithCpu'/);
  assert.match(server, /p\.connected \|\| isCpu\(p\)/);
  assert.match(server, /p\.chips = Math\.max/);
  assert.match(server, /公開契約は自動参加/);
  assert.match(app, /fillWithCpu/);
  assert.match(app, /p\.isCpu/);
  assert.match(html, /CP補充でプレイ/);
  assert.match(server, /cpuFillConsentStatus/);
  assert.match(server, /humans\.every\(p => p\.cpuFillReady\)/);
  assert.doesNotMatch(server, /Gemini|OpenAI|ANTHROPIC|GOOGLE_API_KEY/);
  assert.doesNotMatch(engine, /cpuBrain/);
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


test('公開契約は全員へ公開し提示した同ターンの有効行動で自動判定する', () => {
  assert.match(html, /data-tool-target="contractBox"/);
  assert.match(app, /function renderPublicContracts\(\)/);
  assert.match(server, /socket\.on\('postPublicContract'/);
  assert.match(server, /socket\.on\('acceptPublicContract'/);
  assert.match(server, /settleDuePublicContracts\(room, result\)/);
  assert.match(server, /lastEffectiveActions/);
  assert.match(server, /conditionType === 'attackTarget'/);
  assert.match(server, /conditionType === 'dontAttackTarget'/);
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

test('完全防御・カード指定・ポイント泥棒は本人の結果に成功失敗を表示する', () => {
  assert.match(server, /e\.type !== 'specialResult'/);
  assert.match(server, /\['fullDefense','specify','steal'\]/);
  assert.match(server, /items\.push\(`\$\{label\}\$\{e\.success \? '成功' : '失敗'\}`\)/);
});

test('カード指定UIは指定される人・通常カード・そのカードを使う相手まで選ぶ', () => {
  assert.match(app, /そのカードを使う相手/);
  assert.match(app, /specifiedTargetId/);
  assert.match(app, /specifiedActionTargetOptions/);
});

test('カード指定中は通常カードだけを指定し特殊カード併用可を指定者非公開で明示する', () => {
  assert.match(app, /カード指定中：[\s\S]*cardLabel\(me\.forcedNormalType\.type\)[\s\S]*特殊カードは併用できます/);
  assert.match(app, /forcedKey !== key/);
  assert.doesNotMatch(app, /指定者[:：]/);
});

test('公開契約は20P刻みで通常4分の1・第15ターン判定は報酬2倍にする', () => {
  assert.match(app, /reward\.min='20'; reward\.step='20'/);
  assert.match(server, /validContractStake\(n, p\.points\)/);
  assert.match(server, /contractRewardPerPlayer\(contract\.reward, rewardMultiplier\)/);
  assert.match(server, /contractSettlement\(contract\.reward, successCount, rewardMultiplier\)/);
  assert.match(server, /contract\.dueTurn === MAX_TURNS \? 2 : 1/);
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

test('公開契約は防御・回復・告発条件を持ち、告発は成否不問で色名表示する', () => {
  assert.match(server, /defendTarget/);
  assert.match(server, /healTarget/);
  assert.match(server, /accuseTarget/);
  assert.match(server, /defensesByPlayer/);
  assert.match(server, /healsByPlayer/);
  assert.match(server, /accusationsByPlayer/);
  assert.match(app, /指定した色に回復カードを使ったら報酬/);
  assert.match(app, /指定した色を告発したら報酬（成功・失敗どちらでも可）/);
  assert.match(app, /指定した色を防御したら報酬/);
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

test('最終ルール文書は1位予想の終了時公開と公開契約20P刻みで統一される', () => {
  const rulesDoc = fs.readFileSync(path.join(root, 'RULES.md'), 'utf8');
  const decisions = fs.readFileSync(path.join(root, 'RULE_DECISIONS.md'), 'utf8');
  assert.match(rulesDoc, /試合終了時に全員の予想相手/);
  assert.match(decisions, /所持P以内の20P刻み/);
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

test('公開契約は自動参加し、参加対象者なしの場合だけ匿名で返却通知する', () => {
  assert.match(server, /function autoEnrollPublicContract\(room, contract\)/);
  assert.match(server, /contract\.acceptorIds = participants\.map/);
  const expireBlock = server.match(/function expireOpenPublicContracts\(room\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(expireBlock, /参加対象者なしで終了[\s\S]*?emitGameNotice/);
  const acceptBlock = server.match(/socket\.on\('acceptPublicContract'[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.match(acceptBlock, /自動参加/);
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
  assert.match(app, /カード指定中：[\s\S]*cardLabel\(me\.forcedNormalType\.type\)[\s\S]*特殊カードは併用できます/);
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
  assert.match(decisions, /条件上参加可能な生存者が自動参加/);
  assert.match(decisions, /\*\*試合中\*\*.*本人以外へ非公開/);
  assert.match(decisions, /\*\*試合終了時\*\*.*全員へ公開/);
});

test('削除済みの未使用ヘルパーを配布コードへ残さない', () => {
  assert.doesNotMatch(server, /function visibleLogs\(/);
  assert.doesNotMatch(server, /function allAliveLocked\(/);
  assert.doesNotMatch(app, /function privateChatLabel\(/);
  assert.doesNotMatch(app, /function objectiveLabel\(/);
});


test('公開契約は攻撃・回復・提示色防御系だけ判定前脱落で取消し、告発契約は脱落者を対象に継続できる', () => {
  const settleBlock = server.match(/function settleDuePublicContracts\(room, result\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(settleBlock, /\['attackTarget','dontAttackTarget','defendTarget','healTarget'\]\.includes\(contract\.conditionType\)/);
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
  assert.match(rulesSource, /accusation: \{ label: '告発', initial: 5, price: 20 \}/);
  assert.match(server, /kind === 'accuseTarget' && subject\.secretState\?\.invalid/);
  assert.match(fs.readFileSync(path.join(root, 'RULES.md'), 'utf8'), /告発 5/);
  assert.match(fs.readFileSync(path.join(root, 'RULES.md'), 'utf8'), /告発は生存者・脱落者どちらも対象/);
});

test('公開契約は提示者自身の色も条件対象に指定できる', () => {
  const contractUiBlock = app.match(/function publicContractTargetOptions\([\s\S]*?\n\}/)?.[0] || '';
  const postBlock = server.match(/socket\.on\('postPublicContract'[\s\S]*?socket\.on\('acceptPublicContract'/)?.[0] || '';
  assert.match(contractUiBlock, /p\.playerId === state\?\.me\?\.playerId \? '（自分）'/);
  assert.doesNotMatch(contractUiBlock, /p\.playerId === state\?\.me\?\.playerId\) continue/);
  assert.match(postBlock, /subject = getPlayer\(room, cleanText\(subjectId, 96\)\)/);
  assert.doesNotMatch(postBlock, /subject = validTarget\(room, p, subjectId/);
  assert.match(fs.readFileSync(path.join(root, 'RULES.md'), 'utf8'), /提示者自身の色も指定可能/);
});

test('購入価格は全カード5P引き下げ、初期回復は1枚を維持する', () => {
  const rulesSource = fs.readFileSync(path.join(root, 'src/rules.js'), 'utf8');
  assert.match(rulesSource, /attack: \{ label: '攻撃', initial: 5, price: 10 \}/);
  assert.match(rulesSource, /defense: \{ label: '防御', initial: 5, price: 10 \}/);
  assert.match(rulesSource, /scout: \{ label: '偵察', initial: 5, price: 10 \}/);
  assert.match(rulesSource, /accusation: \{ label: '告発', initial: 5, price: 20 \}/);
  assert.match(rulesSource, /heal: \{ label: '回復', initial: 1, price: 30 \}/);
  assert.match(rulesSource, /const SPECIAL_PURCHASE_PRICE = 40;/);
});

test('告発成功済みの相手は通常告発・2倍告発・公開契約の候補から除外する', () => {
  const engine = fs.readFileSync(path.join(root, 'src/engine.js'), 'utf8');
  assert.match(app, /p\.accusationResolved/);
  assert.match(server, /accusationResolved: !!p\.secretState\?\.invalid/);
  assert.match(engine, /function accusationTargetIsValid/);
  assert.match(engine, /target\.secretState\?\.invalid/);
  assert.match(server, /kind === 'accuseTarget' && subject\.secretState\?\.invalid/);
});

test('公開契約は参加操作不要で自動参加し、誰が出したか・誰が参加したかをクライアントへ出さない', () => {
  const viewBlock = server.match(/function publicContractView\(room, contract\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(server, /const autoParticipantCount = autoEnrollPublicContract\(room, contract\);/);
  assert.match(server, /contract\.status = 'accepted'/);
  assert.doesNotMatch(viewBlock, /issuerId:|issuerColor:|acceptorIds:|acceptorColors/);
  assert.doesNotMatch(app, /参加済み|textContent='参加'|acceptPublicContract/);
  assert.match(app, /誰が提示したか・誰が参加しているかは公開されません/);
  assert.doesNotMatch(server, /successColors/);
});

test('公開契約の判定ターンは常に作成した現在ターン', () => {
  assert.match(server, /const dueTurn = room\.turn;/);
  assert.match(app, /const contractTiming = 'このターン';/);
  assert.doesNotMatch(server, /const dueTurn = room\.turn >= MAX_TURNS \? MAX_TURNS : room\.turn \+ 1/);
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
  assert.match(contractBlock, /件数制限なし/);
  assert.match(fs.readFileSync(path.join(root, 'RULES.md'), 'utf8'), /提示件数に制限なし。同じターンに複数件、同時に複数件提示可能/);
});


test('通常カード・特殊カード購入は所持ポイントの範囲で回数制限なし', () => {
  const buyBlock = server.match(/socket\.on\('buy'[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.doesNotMatch(buyBlock, /通常カード購入は1ターン1回まで/);
  assert.doesNotMatch(buyBlock, /p\.normalPurchasedTurn === room\.turn/);
  assert.doesNotMatch(buyBlock, /p\.normalPurchasedTurn = room\.turn/);
  assert.doesNotMatch(buyBlock, /特殊カードは1試合1回まで購入できます/);
  assert.doesNotMatch(buyBlock, /p\.specialPurchased = true/);

  const inventoryBlock = app.match(/function renderInventory\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.doesNotMatch(inventoryBlock, /me\.normalPurchasedThisTurn/);
  assert.doesNotMatch(inventoryBlock, /me\.specialPurchased/);
  assert.match(inventoryBlock, /特殊カード購入：\$\{specialPrice\}P・ランダム。所持ポイントの範囲で回数制限なし/);

  const rules = fs.readFileSync(path.join(root, 'RULES.md'), 'utf8');
  assert.match(rules, /通常カード購入は1ターンの回数制限なし/);
  assert.match(rules, /特殊カード購入も所持ポイントの範囲で回数制限なし/);
});



test('完全防御は攻撃者1人につき10Pで表示・実装される', () => {
  const rulesJs = fs.readFileSync(path.join(root, 'src/rules.js'), 'utf8');
  const rulesMd = fs.readFileSync(path.join(root, 'RULES.md'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  assert.match(rulesJs, /fullDefensePerAttacker: 10/);
  assert.match(rulesMd, /完全防御: 攻撃者人数×10P/);
  assert.match(html, /完全防御[\s\S]*攻撃者人数×10P/);
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
  assert.match(html, /app\.js\?v=20260913-complete-final7/);
  assert.match(html, /styles\.css\?v=20260913-complete-final7/);
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
  assert.match(html, /app\.js\?v=20260913-complete-final7/);
  assert.match(html, /styles\.css\?v=20260913-complete-final7/);
});






test('対戦HUDは五戯チップを非表示にし公開契約・1位予想を常時操作できる配置にする', () => {
  assert.match(html, /class="chipInGameHud">五戯 <b id="myChips"/);
  assert.match(css, /#game\.portraitGame \.chipInGameHud\{display:none!important\}/);
  assert.match(html, /data-tool-target="contractBox">公開契約<\/button>/);
  assert.match(html, /data-tool-target="winnerBetBox">1位予想<\/button>/);
  assert.match(css, /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)!important/);
  assert.match(css, /hudTools button:last-child\{grid-column:auto!important\}/);
});

test('公開契約の公開表示は提示者・参加者・使用Pを隠し1人あたり報酬だけ表示する', () => {
  const contractBlock = app.match(/function renderPublicContracts\(\) \{[\s\S]*?\n\}\n\nfunction renderWinnerBet/)?.[0] || '';
  assert.doesNotMatch(contractBlock, /c\.issuerColor|c\.acceptorColors|参加：/);
  assert.match(contractBlock, /【\$\{rewardLabel\}】 \$\{condition\}/);
  const viewBlock = server.match(/function publicContractView\(room, contract\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.doesNotMatch(viewBlock, /issuerId:|issuerColor:|acceptorIds:|acceptorColors/);
  assert.doesNotMatch(server, /\$\{p\.color\.label\}が公開契約を提示/);
  assert.doesNotMatch(server, /公開契約参加：/);
  assert.match(server, /公開契約が提示されました：\$\{condition\} \/ 報酬1人\$\{perPlayer\}P \/ 対象者は自動参加/);
});

test('公開契約は第1〜15ターンすべて提示した同ターン判定、報酬額を全員へ毎回表示する', () => {
  assert.match(server, /公開契約は第1〜15ターンの会話時間内に作成できます/);
  assert.match(server, /const dueTurn = room\.turn;/);
  assert.match(app, /state\.turn <= state\.maxTurns/);
  assert.match(app, /この契約の達成報酬：1人/);
  assert.match(app, /【\$\{rewardLabel\}】/);
  assert.match(server, /公開契約が提示されました：\$\{condition\} \/ 報酬1人\$\{perPlayer\}P \/ 対象者は自動参加/);
  assert.match(server, /function autoEnrollPublicContract\(room, contract\)/);
  assert.doesNotMatch(app, /acceptPublicContract/);
});


test('五戯チップUIは初期100000・所持0のみ100000チャージ・0/100刻み・同額公開マッチを持つ', () => {
  assert.match(html, /id="chipBalance"/);
  assert.match(html, /id="chipRecharge"[^>]*>100,000チャージ<\/button>/);
  assert.match(html, /初期100,000 \/ 所持0のときだけ100,000チャージ可能/);
  assert.match(html, /id="chipStakeInput"[^>]*min="0"[^>]*step="100"/);
  assert.match(app, /const INITIAL_CHIP_BALANCE = 100000/);
  assert.match(app, /const CHIP_RECHARGE_AMOUNT = 100000/);
  assert.match(app, /async function rechargeChipWallet\(\)[\s\S]*emitAck\('rechargeChipWallet', \{ browserId \}\)/);
  assert.match(app, /async function refreshChipWallet\(\)[\s\S]*emitAck\('getChipWallet', \{ browserId \}\)/);
  assert.match(app, /#chipRecharge'\)\?\.addEventListener\('click', rechargeChipWallet\)/);
  assert.doesNotMatch(app, /DAILY_CHIP_GRANT|applyDailyChipGrant/);
  assert.doesNotMatch(server, /scheduleDailyChipGrant|applyDailyChipGrantToPlayer/);
  assert.match(app, /const CHIP_STAKE_STEP = 100/);
  assert.match(app, /emitAck\('publicMatch', \{[^}]*chipStake[^}]*\}/);
  assert.doesNotMatch(app, /emitAck\('publicMatch', \{[^}]*chipBalance/);
  assert.match(server, /const chipWallets = new Map\(\)/);
  assert.match(server, /const balance = chipWalletBalance\(browserId\)/);
  assert.match(server, /findPublicWaitingRoom\(stake\)/);
  assert.match(server, /Number\(r\.chipStake \|\| 0\) === Number\(chipStake \|\| 0\)/);
});

test('プライベート五戯チップは部屋主設定額を強制し不足参加を拒否する', () => {
  assert.match(app, /emitAck\('createPrivate', \{[^}]*chipStake[^}]*\}/);
  assert.match(app, /emitAck\('joinPrivate', \{ code, clientInstanceId, browserId, pageInstanceId \}\)/);
  assert.doesNotMatch(app, /emitAck\('createPrivate', \{[^}]*chipBalance/);
  assert.doesNotMatch(app, /emitAck\('joinPrivate', \{[^}]*chipBalance/);
  assert.match(server, /makeRoom\(\{ isPublic: false, chipStake: stake \}\)/);
  assert.match(server, /balance < Number\(room\.chipStake \|\| 0\)/);
  assert.match(server, /この部屋は\$\{Number\(room\.chipStake \|\| 0\)\}五戯チップ必要です/);
});

test('五戯チップ賞金は最終1位2.5倍・予想成績1位2.5倍で結果表示する', () => {
  const { GOGI_CHIPS } = require('../src/rules');
  assert.equal(GOGI_CHIPS.payoutMultiplier, 2.5);
  assert.equal(GOGI_CHIPS.initialBalance, 100000);
  assert.equal(GOGI_CHIPS.rechargeAmount, 100000);
  assert.equal(GOGI_CHIPS.stakeStep, 100);
  assert.match(server, /room\.chipSettlement = settleChipWager\(room\)/);
  assert.match(html, /id="chipSettlement"/);
  assert.match(html, /同じ人が両方で単独1位なら合計で賭け額の5倍/);
  assert.match(app, /predictionFallbackToFinalWinner \? '予想枠繰越' : '予想1位'/);
  assert.match(app, /予想賞金枠は第2順位発表の1位へ配分しました/);
  assert.match(html, /的中者がいない、または誰も1位予想をしていない場合/);
});


test('AFK警告は確認ボタンでその警告を閉じられる', () => {
  assert.match(html, /id="dismissAfkWarning"[^>]*>確認<\/button>/);
  assert.match(app, /let dismissedAfkWarningKey = ''/);
  assert.match(app, /dismissAfkWarning'\)\?\.addEventListener\('click'/);
  assert.match(app, /dismissedAfkWarningKey === warningKey/);
  assert.match(css, /\.afkWarningBanner button\{/);
});

test('同一ターンの回復は攻撃より先に解決する', () => {
  const engineSource = fs.readFileSync(path.join(root, 'src/engine.js'), 'utf8');
  const healPos = engineSource.indexOf('回復は攻撃より先に解決する');
  const attackPos = engineSource.indexOf('攻撃を対象ごとに同時集計');
  assert.ok(healPos >= 0 && attackPos >= 0 && healPos < attackPos);
});

test('予想的中者がいない場合は予想賞金枠を第2順位発表の1位へ回す', () => {
  const engineSource = fs.readFileSync(path.join(root, 'src/engine.js'), 'utf8');
  assert.match(engineSource, /predictionFallbackToFinalWinner = predictionWinnerIdsByBet\.length === 0/);
  assert.match(engineSource, /predictionFallbackToFinalWinner \? \[\.\.\.gameWinnerIds\] : predictionWinnerIdsByBet/);
});


test('ゲーム終了後だけ全ターン行動履歴を全員へ公開する', () => {
  assert.match(html, /id="turnHistory"/);
  assert.match(app, /function renderTurnHistory\(\)/);
  assert.match(app, /rowData\.action/);
  assert.match(app, /rowData\.results/);
  assert.match(server, /room\.turnHistory\.push\(buildTurnHistoryEntry/);
  assert.match(server, /turnHistory: room\.status === 'finished' \? JSON\.parse\(JSON\.stringify\(room\.turnHistory \|\| \[\]\)\) : \[\]/);
  assert.match(server, /特殊：カード指定/);
  assert.match(server, /無効カードにより行動無効/);
  assert.match(server, /HP/);
});


test('CP実装版はチャット以外の主要ゲーム機能を自動利用できる', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /maybePlaceCpuWinnerBets/);
  assert.match(server, /maybeRunCpuPurchases/);
  assert.match(server, /maybeCreateCpuExchanges/);
  assert.match(server, /maybePostCpuPublicContracts/);
  assert.match(server, /cpuObjectiveFeasibility/);
  assert.match(server, /cpuStrategicContext/);
  assert.match(server, /cpuObjectivePurchaseType/);
  assert.match(server, /key === 'hermit'|case 'hermit'/);
  assert.match(server, /key === 'gambler'|case 'gambler'/);
  assert.match(server, /key === 'reaper'|case 'reaper'/);
  assert.match(server, /CPも人間と同じゲーム機能を使う。チャットだけは自動送信しない/);
});

test('CPはチャット自動送信ロジックを持たない', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const cpArea = server.slice(server.indexOf('// 本番CP。'), server.indexOf('function uniqueRoomCode'));
  assert.doesNotMatch(cpArea, /chatMessage|room\.chat\.push|socket\.on\('chat'/);
});

test('CP策士版は状況評価・偵察推論・勝率判断・取引評価を持ち、相手の秘密を直接参照しない', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /cpuObjectiveInference/);
  assert.match(server, /cpuNormalCandidateScore/);
  assert.match(server, /cpuChooseSpecial/);
  assert.match(server, /cpuLearnFromLastTurn/);
  assert.match(server, /cpuWinCandidateScore/);
  assert.match(server, /cpuBundleValue/);
  assert.match(server, /cpuContractPlan/);
  const cpBlock = server.slice(server.indexOf('// 本番CP。'), server.indexOf('function autoEnrollPublicContract'));
  assert.doesNotMatch(cpBlock, /target\.objective/);
  assert.doesNotMatch(cpBlock, /target\.points/);
  assert.doesNotMatch(cpBlock, /target\.hand/);
});


test('CP最高戦略版は目標期限・終盤順位・期待値・再計画・二重告発推理まで使う', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const cpBlock = server.slice(server.indexOf('// 本番CP。'), server.indexOf('function autoEnrollPublicContract'));
  assert.match(cpBlock, /function cpuObjectiveFeasibility/);
  assert.match(cpBlock, /function cpuStrategicContext/);
  assert.match(cpBlock, /currentPointsStanding\(room, p\.playerId\)/);
  assert.match(cpBlock, /expectedReturnRatio/);
  assert.match(cpBlock, /secondGuess/);
  assert.match(cpBlock, /secondNormalTargetId = first\.playerId/);
  assert.match(cpBlock, /function cpuReplan/);
  assert.match(cpBlock, /cpuReplan\(room, cpu\)/);
  assert.match(cpBlock, /相手のready状態は対戦中非公開なので判断材料にしない/);
  assert.doesNotMatch(cpBlock, /x\.ready|target\.ready|candidate\.ready/);
  assert.doesNotMatch(cpBlock, /target\.objective/);
  assert.doesNotMatch(cpBlock, /target\.points/);
  assert.doesNotMatch(cpBlock, /target\.hand/);
  assert.match(server, /20260913-complete-final7/);
});


test('交換はカード種類に加えて1〜99枚の枚数を指定し、表示・エスクロー・返却・成立で数量を保持する', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  assert.match(app, /offerCount:'1'/);
  assert.match(app, /requestCount:'1'/);
  assert.match(app, /offerCardCount/);
  assert.match(app, /requestCardCount/);
  assert.match(app, /count\.max='99'/);
  assert.match(server, /MAX_EXCHANGE_CARD_COUNT = 99/);
  assert.match(server, /quantity:exchangeCardQuantity\(card\)/);
  assert.match(server, /bag\[card\.type\].*exchangeCardQuantity\(card\)/);
  assert.match(server, /bag\[normalized\.type\] -= qty/);
  assert.match(server, /giveExchangeCard\(player, card\)/);
});

test('CP補充開始は参加中の人間全員の同意が揃うまで待機し、1人の押下だけでは開始しない', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  assert.match(server, /function cpuFillConsentStatus/);
  assert.match(server, /humans\.length > 0 && humans\.every\(p => p\.cpuFillReady\)/);
  assert.match(server, /if \(!consent\.allReady\)[\s\S]*waiting:true/);
  assert.match(server, /fillCpuAndStartIfConsented\(room\)/);
  assert.match(app, /CP補充でプレイ：\$\{res\.readyCount\}\/\$\{res\.humanCount\}人が同意済み/);
  assert.match(app, /mineReady/);
});


test('CPの1位予想は自己固定ではなく、未知相手を過小評価せず推定勝率で他色も選べる', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const cpBlock = server.slice(server.indexOf('// 本番CP。'), server.indexOf('function autoEnrollPublicContract'));
  assert.match(cpBlock, /function cpuExpectedWinnerPointBaseline/);
  assert.match(cpBlock, /未偵察は「弱い」とみなさず/);
  assert.match(cpBlock, /function cpuWeightedPick/);
  assert.match(cpBlock, /const reliability = room\.turn === 3/);
  assert.match(cpBlock, /const chosen = weighted\[0\]/);
  assert.match(cpBlock, /chosen\.target\.playerId/);
  assert.doesNotMatch(cpBlock, /const best = weighted\[0\][\s\S]*placeWinnerBet\(room, p, best\.target\.playerId/);
  assert.doesNotMatch(cpBlock, /target\.points/);
});


test('CP交換AIは提案を無視せず即承認または即拒否し、拒否時にエスクローを返却する', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /function respondExchangeAsCpu\(room, req\)/);
  assert.match(server, /function rejectExchangeAsCpu\(room, req\)/);
  assert.match(server, /removeExchangeRequest\(room, req\.requestId\)[\s\S]*?refundExchangeOffer/);
  const createBlock = server.match(/socket\.on\('createExchange'[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.match(createBlock, /if \(isCpu\(target\)\)[\s\S]*?respondExchangeAsCpu/);
  assert.match(createBlock, /rejected:decision\.accepted !== true/);
  assert.match(app, /CPが交換を拒否しました/);
});

test('CP交換AIは取引履歴・相手別承認率・同一カード連打ペナルティ・余剰売却を使う', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /function cpuTradeMemory/);
  assert.match(server, /function cpuTradePartnerStats/);
  assert.match(server, /function cpuTradeRecentTypePenalty/);
  assert.match(server, /function cpuTradePartnerScore/);
  assert.match(server, /function cpuMaybeBuildLiquidationTrade/);
  assert.match(server, /proposalHistory/);
  assert.match(server, /accepted \/ total/);
  assert.match(server, /wantedType !== wantedType/);
});


test('CP超強化版は被攻撃リスクと偵察済み防御在庫を戦術判断へ反映する', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const cpBlock = server.slice(server.indexOf('// 本番CP。'), server.indexOf('function autoEnrollPublicContract'));
  assert.match(cpBlock, /function cpuIncomingAttackRisk/);
  assert.match(cpBlock, /function cpuKnownCardSignal/);
  assert.match(cpBlock, /defenseSignal\.count === 0/);
  assert.match(cpBlock, /attackRisk < 0\.20/);
  assert.match(cpBlock, /fullDefense[\s\S]*attackRisk/);
});

test('CP購入AIは固定1種類1枚ではなく購入後に限界効用を再計算する', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const block = server.match(/function maybeRunCpuPurchases\(room\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(block, /maxNormalBuys/);
  assert.match(block, /for \(let i = 0; i < maxNormalBuys; i\+\+\)/);
  assert.match(block, /cpuCardNeedScore\(room,p,type\)/);
  assert.match(block, /cpuBuy\(room,p,best\.type\)/);
});

test('CP交換AIは不利取引の反復悪用を防ぎ、成立・拒否後に戦略を再計算する', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /const minimumRatio = 1\.03/);
  assert.match(server, /repeatedAccepted/);
  assert.match(server, /partnerThreat/);
  assert.match(server, /cpuReplan\(room, from\)/);
  assert.match(server, /同じ提案の pending と最終結果を別レコードで二重計上しない/);
});

test('CPの1位予想は第9ターンでも明確な負期待値を強制しない', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /const minExpectedRatio/);
  assert.match(server, /if \(expectedReturnRatio < minExpectedRatio\) continue/);
  assert.doesNotMatch(server, /expectedReturnRatio < 1\.03 && room\.turn !== 9/);
});


test('CPは回復公開契約も戦略判断する', () => {
  assert.match(server, /kind:'healTarget'/);
  assert.match(server, /conditionType === 'healTarget'/);
  assert.match(server, /normal === 'heal'/);
});


test('CP APEX MAXは古い偵察0枚情報を永久確定せず時間減衰させる', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const cpBlock = server.slice(server.indexOf('// 本番CP。'), server.indexOf('function autoEnrollPublicContract'));
  assert.match(cpBlock, /function cpuKnownCardSignal/);
  assert.match(cpBlock, /freshness = age <= 0 \? 1 : Math\.max\(0\.08, 1 - age \* 0\.18\)/);
  assert.match(cpBlock, /observedAvailability = count === 0 \? 0\.02/);
  assert.match(cpBlock, /old|古い「防御0枚」|古い0枚情報/);
});

test('CP FINALは人間に非公開の内部イベントを読まず、偵察済み情報だけで相手傾向を推定する', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const cpBlock = server.slice(server.indexOf('// 本番CP。'), server.indexOf('function autoEnrollPublicContract'));
  assert.match(cpBlock, /function cpuObservedBehaviorWeight/);
  assert.match(cpBlock, /cpuHandSpendEvidence/);
  assert.match(cpBlock, /cpuLatestScout/);
  assert.doesNotMatch(cpBlock, /cpuLearnPublicEvents|cpuPublicProfile|publicPlayers|publicScoreEvidence/);
  assert.doesNotMatch(cpBlock, /result\?\.publicEvents|r\.publicEvents/);
  assert.doesNotMatch(cpBlock, /behavior\.specialsUsed[\s\S]*scores\.hermit/);
});

test('CP APEX MAXは未使用目標を絶対禁止せず生存価値が上なら破棄できる', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const cpBlock = server.slice(server.indexOf('// 本番CP。'), server.indexOf('function autoEnrollPublicContract'));
  assert.match(cpBlock, /function cpuObjectiveBreakPenalty/);
  assert.match(cpBlock, /SECRET_REWARD/);
  assert.doesNotMatch(cpBlock, /key === 'endurer'[\s\S]{0,100}normal === 'heal'\) b -= 500/);
  assert.doesNotMatch(cpBlock, /key === 'unguarded'[\s\S]{0,100}normal === 'defense'\) b -= 500/);
  assert.doesNotMatch(cpBlock, /key === 'hermit'[\s\S]{0,100}return d/);
});

test('CP APEX MAXは完全防御と自己通常防御の重複消費を避ける', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const cpBlock = server.slice(server.indexOf('// 本番CP。'), server.indexOf('function autoEnrollPublicContract'));
  assert.match(cpBlock, /function cpuBestNormalPlanWithoutSelfDefense/);
  assert.match(cpBlock, /best\.special === 'fullDefense'[\s\S]*d\.normal === 'defense'[\s\S]*cpuBestNormalPlanWithoutSelfDefense/);
});

test('CP APEX MAXは瀕死目標の必要回復枚数を計算し買い溜めを抑える', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const cpBlock = server.slice(server.indexOf('// 本番CP。'), server.indexOf('function autoEnrollPublicContract'));
  assert.match(cpBlock, /function cpuNearDeathHealRequirement/);
  assert.match(cpBlock, /Math\.ceil\(Math\.max\(0, needDamage - safeCapacity\) \/ 2\)/);
  assert.match(cpBlock, /have < nearDeathRequiredHeals/);
});

test('CP APEX MAXは公開契約でライバルの通常行動得点まで外部性として評価する', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const cpBlock = server.slice(server.indexOf('// 本番CP。'), server.indexOf('function autoEnrollPublicContract'));
  assert.match(cpBlock, /function cpuContractRivalExternality/);
  assert.match(cpBlock, /SCORING\.defenseOtherSuccess/);
  assert.match(cpBlock, /SCORING\.healOtherSuccess/);
  assert.match(cpBlock, /rivalExternality/);
});

test('CP FINALは自分の結果から一意に分かる攻撃だけ学習し、内部の二重行動結果を覗かない', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const cpBlock = server.slice(server.indexOf('// 本番CP。'), server.indexOf('function autoEnrollPublicContract'));
  assert.match(cpBlock, /plannedTargets\.push\(plan\.secondNormalTargetId/);
  assert.match(cpBlock, /uniqueTargets\.length === 1/);
  assert.match(cpBlock, /own\.some\(x => String\(x\)\.startsWith\('攻撃成功'\)\)/);
  assert.doesNotMatch(cpBlock, /lastEffectiveActions|effective\?\.attacksByPlayer|effective\?\.accusationsByPlayer/);
  assert.doesNotMatch(cpBlock, /successfulAccusationFor|failedObjectiveGuesses\[tr\.targetId\]/);
});

test('CP APEX MAXは人間の安値買取提案へ売値カウンターを返せる', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const cpBlock = server.slice(server.indexOf('// 本番CP。'), server.indexOf('function autoEnrollPublicContract'));
  assert.match(cpBlock, /相手がCPのカードを安く買おうとした場合/);
  assert.match(cpBlock, /counterRequest = \{ points:askPoints, card:null \}/);
  assert.match(cpBlock, /takeCardForExchange\(room,cpu/);
});


test('CP APEX FINALは死神の達成可能性を生存中の攻撃対象だけで判定する', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const cpBlock = server.slice(server.indexOf('// 本番CP。'), server.indexOf('function autoEnrollPublicContract'));
  assert.match(cpBlock, /attackableIds = new Set\(cpuAliveTargets\(room,p\)/);
  assert.match(cpBlock, /bestLiveCount/);
  assert.match(cpBlock, /attackableIds\.size > 0 \? Math\.max\(0, 5 - bestLiveCount\) : 99/);
});

test('CP APEX FINALは行動パターンを記憶して不要な反復を弱く抑える', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const cpBlock = server.slice(server.indexOf('// 本番CP。'), server.indexOf('function autoEnrollPublicContract'));
  assert.match(cpBlock, /actionHistory/);
  assert.match(cpBlock, /function cpuPredictabilityPenalty/);
  assert.match(cpBlock, /score -= cpuPredictabilityPenalty/);
});

test('CP APEX FINALは2倍カードを行動種別と対象状況に応じて評価する', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const cpBlock = server.slice(server.indexOf('// 本番CP。'), server.indexOf('function autoEnrollPublicContract'));
  assert.match(cpBlock, /function cpuIncomingAttackDistribution/);
  assert.match(cpBlock, /pAtLeastTwo/);
  assert.match(cpBlock, /観察者\/追跡者は「連続ターン」「同一人物回数」/);
  assert.match(cpBlock, /p\.objective\?\.key === 'reaper'.*ctx\.objective\.need <= 2/s);
  assert.match(cpBlock, /missing >= 4/);
});

test('CP APEX FINALは1位予想で優勢時の負期待値賭けを避け劣勢時だけ分散を取る', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const cpBlock = server.slice(server.indexOf('// 本番CP。'), server.indexOf('function autoEnrollPublicContract'));
  assert.match(cpBlock, /riskSeeking/);
  assert.match(cpBlock, /riskProtecting/);
  assert.match(cpBlock, /riskProtecting \? 1\.08 : 1\.03/);
});

test('CP APEX FINALは公開契約の実参加人数と推定カード保有率を期待値へ反映する', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const cpBlock = server.slice(server.indexOf('// 本番CP。'), server.indexOf('function autoEnrollPublicContract'));
  assert.match(cpBlock, /function cpuContractEligibleParticipants/);
  assert.match(cpBlock, /cpuKnownCardSignal\(room,cpu,x\.playerId,requiredType\)\.availability/);
  assert.match(cpBlock, /participantCount = cpuContractEligibleParticipants\(room,cpu,option\)\.length/);
});


test('完全完成版の公開契約は提示者色を条件から逆算できない汎用指定色方式', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  assert.match(server, /dontAttackTarget/);
  assert.match(server, /defendTarget/);
  assert.doesNotMatch(server, /dontAttackIssuer|defendIssuer/);
  assert.doesNotMatch(app, /dontAttackIssuer|defendIssuer/);
  assert.match(app, /指定した色を攻撃しなければ報酬/);
  assert.match(app, /指定した色を防御したら報酬/);
  const viewBlock = server.match(/function publicContractView\(room, contract\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(viewBlock, /targetColor:subject\?\.color\?\.label/);
  assert.doesNotMatch(viewBlock, /issuer\?\.color|issuerId:/);
});

test('完全完成版CPは他人の現在HPを直接読まず、自分か偵察済みHPだけで回復価値を判断する', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const cpBlock = server.slice(server.indexOf('// 本番CP。'), server.indexOf('function autoEnrollPublicContract'));
  assert.match(cpBlock, /function cpuKnownMissingHp/);
  assert.match(cpBlock, /cpuLatestScout\(p,target\.playerId\)/);
  assert.match(cpBlock, /cpuKnownMissingHp\(room,p,target\)/);
  assert.doesNotMatch(cpBlock, /Number\(target\.hp\|\|0\)/);
});

test('完全完成版は購入回数制限の旧状態フィールドと待機室再接続猶予の旧定数を残さない', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const engine = fs.readFileSync(path.join(root, 'src/engine.js'), 'utf8');
  const rules = fs.readFileSync(path.join(root, 'src/rules.js'), 'utf8');
  assert.doesNotMatch(server, /specialPurchased|normalPurchasedTurn|normalPurchasedThisTurn|LOBBY_RECONNECT_GRACE_SECONDS/);
  assert.doesNotMatch(engine, /specialPurchased|normalPurchasedTurn/);
  assert.doesNotMatch(rules, /LOBBY_RECONNECT_GRACE_SECONDS/);
});

test('完全完成版の現行文書はCP正式実装・公開契約5条件・2026-09-13監査で統一する', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const decisions = fs.readFileSync(path.join(root, 'RULE_DECISIONS.md'), 'utf8');
  const deploy = fs.readFileSync(path.join(root, 'DEPLOY.md'), 'utf8');
  const audit = fs.readFileSync(path.join(root, 'AUDIT.md'), 'utf8');
  assert.doesNotMatch(decisions, /人間のみ。CP機能なし/);
  assert.match(decisions, /CPは正式実装/);
  assert.match(deploy, /公開契約5条件/);
  assert.doesNotMatch(deploy, /公開契約4条件/);
  assert.match(readme, /2026-09-13/);
  assert.match(audit, /2026-09-13/);
  assert.doesNotMatch(readme, /FINAL_TEST_REPORT_20260912/);
});

test('完全完成版のサーバー・クライアント・HTMLキャッシュ識別子は同一', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const build = server.match(/const BUILD_ID = '([^']+)'/)?.[1];
  const client = app.match(/const CLIENT_BUILD_ID = '([^']+)'/)?.[1];
  const asset = app.match(/const ASSET_REV = '([^']+)'/)?.[1];
  assert.ok(build);
  assert.equal(client, build);
  assert.equal(asset, build);
  assert.match(html, new RegExp(`\\?v=${build.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}`));
});


test('完全完成版は五戯チップ残高をクライアント申告ではなくサーバー台帳で管理する', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  assert.match(server, /const chipWallets = new Map\(\)/);
  assert.match(server, /function chipWalletBalance\(browserId/);
  assert.match(server, /function syncRoomChipWallets\(room\)/);
  assert.match(server, /socket\.on\('getChipWallet'/);
  assert.match(server, /socket\.on\('rechargeChipWallet'/);
  assert.doesNotMatch(server, /const \{[^}]*chipBalance[^}]*\} = objectPayload\(rawPayload\)/);
  assert.doesNotMatch(app, /chipBalance:chipWallet\.balance/);
  assert.match(server, /syncRoomChipWallets\(room\);[\s\S]*ゲーム開始/);
  assert.match(server, /room\.chipSettlement = settleChipWager\(room\);[\s\S]*syncRoomChipWallets\(room\)/);
});

test('完全完成版は決済済み公開契約をライブ配列から除去して無制限増加を防ぐ', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /room\.publicContracts = room\.publicContracts\.filter\(contract => \['open','accepted'\]\.includes\(contract\.status\)\)/);
});

test('完全完成版の五戯チップ台帳は最大件数と未使用期限でメモリ増加を抑止する', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const env = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  assert.match(server, /const MIN_CHIP_WALLETS = Math\.max\(100, MAX_ACTIVE_ROOMS \* MAX_PLAYERS\)/);
  assert.match(server, /const MAX_CHIP_WALLETS = envInt\('MAX_CHIP_WALLETS', Math\.max\(10000, MIN_CHIP_WALLETS\)/);
  assert.match(server, /function evictOldestChipWalletIfNeeded\(\)/);
  assert.match(server, /if \(chipWallets\.size < MAX_CHIP_WALLETS\) return/);
  assert.match(server, /30 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(env, /MAX_CHIP_WALLETS=10000/);
});


test('最終版はターン解決エラー時に公開契約を通常判定せず全額返却する', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /function cancelDuePublicContractsAfterResolutionError\(room, result\)/);
  assert.match(server, /let resolutionSucceeded = false/);
  assert.match(server, /result = resolveTurn\(room\);[\s\S]*resolutionSucceeded = true/);
  assert.match(server, /if \(resolutionSucceeded\) settleDuePublicContracts\(room, result\);[\s\S]*else cancelDuePublicContractsAfterResolutionError\(room, result\)/);
  const cancelBlock = server.match(/function cancelDuePublicContractsAfterResolutionError\(room, result\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(cancelBlock, /contract\.status = 'cancelled'/);
  assert.match(cancelBlock, /refundPublicContract\(room, contract\)/);
});

test('最終版は公開契約の自動参加者が0人なら人間・CPとも即返却してライブ配列へ残さない', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  const postBlock = server.match(/socket\.on\('postPublicContract'[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.match(postBlock, /if \(autoParticipantCount === 0\)/);
  assert.match(postBlock, /refundPublicContract\(room, contract\)/);
  assert.match(postBlock, /expired:true, refunded:true/);
  const cpuBlock = server.match(/function maybePostCpuPublicContracts\(room\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(cpuBlock, /if \(autoParticipantCount === 0\)/);
  assert.match(cpuBlock, /refundPublicContract\(room, contract\)/);
  assert.match(app, /else if\(res\.expired\)\{toast\('参加対象者がいないため契約は成立せず、使用Pを返却しました。'\);\}/);
});

test('最終版はマイナスPでも0Pのカード交換を提案・承認できる', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const createBlock = server.match(/socket\.on\('createExchange'[\s\S]*?\n  \}\);/)?.[0] || '';
  const respondBlock = server.match(/socket\.on\('respondExchange'[\s\S]*?\n  \}\);/)?.[0] || '';
  assert.match(createBlock, /if \(givePoints > 0 && p\.points < givePoints\)/);
  assert.match(respondBlock, /if \(wantPoints > 0 && p\.points < wantPoints\)/);
  assert.doesNotMatch(createBlock, /if \(givePoints > p\.points\)/);
  assert.doesNotMatch(respondBlock, /if \(p\.points < wantPoints\)/);
});

test('最終版の五戯チップ台帳掃除は対戦中・待機中browserIdを削除しない', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const cleanup = server.match(/const cleanupInterval = setInterval\(\(\) => \{[\s\S]*?\n\}, 5 \* 60 \* 1000\);/)?.[0] || '';
  assert.match(cleanup, /if \(browserIdInUse\(browserId\)\) continue/);
});


test('最終版はカード指定の固定対象が無効ならUIでも行動なしを明示し特殊カードや最後の指定カードを不必要に拘束しない', () => {
  assert.match(server, /forcedTargetInvalid/);
  assert.match(app, /指定された対象が無効になったため、このターンは行動なし/);
  assert.match(app, /me\.forcedTargetInvalid/);
  assert.match(server, /targetValid[\s\S]*specifiedActionTargetIsValid/);
  assert.match(engineFile, /対象が有効なときだけ最後の1枚を保護/);
});


test('最終版CPはマイナスPでも0Pのカード交換を評価でき、ポイント要求時だけ残高・リザーブを検証する', () => {
  const startAt = server.indexOf('function tryAcceptExchangeAsCpu');
  const endAt = server.indexOf('function cpuMaybeCounterOffer', startAt);
  const block = startAt >= 0 && endAt > startAt ? server.slice(startAt, endAt) : '';
  assert.match(block, /wantPoints > 0 && \(cpu\.points < wantPoints \|\| cpu\.points - wantPoints < cpuPointReserve/);
});
