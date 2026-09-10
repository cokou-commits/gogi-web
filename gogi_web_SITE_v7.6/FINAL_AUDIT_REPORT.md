# 五疑 v7.6 — 2026-09-10 実監査報告

## 結論

**現時点では完成扱いにしていない。**

ローカルで確認可能なゲームエンジン、回帰テスト、クライアント実DOM、基本XSS境界、スマホ表示は監査し、実際に再現したUI問題だけ最小修正した。一方、この実行環境は外部DNS/レジストリ通信が遮断されており、`npm install`、`npm audit`、Node.js 24 + Express/Socket.IOの実起動、実Socket.IO 5クライアントE2E、本番公開までを完了できていない。したがって、ユーザー指定の完成条件はまだ満たしていない。

## 実際に確認したこと

- ZIP全23ファイルを展開し、README / RULES / RULE_DECISIONS / AUDIT / DEPLOY / server / engine / rules / client / CSS / 全テスト / stress scriptを確認
- `RULES.md` を正式仕様としてコードとの対応を監査
- `RULE_DECISIONS.md` 27項目は未確定仕様として保持し、ゲーム結果に影響する裁定変更は実施していない
- JavaScript構文チェック：server / rules / engine / app 全PASS
- `npm run verify`：PASS
- Node test runner：**110/110 PASS**
- エンジン行カバレッジ 94.81%、branch 84.62%、function 98.36%；`rules.js` は100%
- 5人×15ターン通しテスト：PASS
- 決定的ランダム100試合：PASS
- ランダムストレス100,000試合×15ターン：PASS、例外・不変条件違反0
- Chromium 144を使った実DOM描画確認：390×844、360×800、1440×900
- chat / action / result / final ranking の描画確認
- 390/360幅で横はみ出し0
- 390/360幅で今回対象にした主要小型操作の44px未満0
- 360×800でも10秒行動フェーズ開始時に「行動確定」が初期表示内へ入ることを確認
- 上記Chromium監査中のJavaScript page error 0、console error/warning 0
- 悪意あるチャット文字列 `<img src=x onerror=...>` を状態へ投入し、DOM要素化0、onerror発火0を確認
- クライアント表示の100秒 / 10秒 / 6秒初期値を実DOMで確認
- 最終ランキング5行の描画を確認
- 既存の静的/回帰テストで、不正payload、古いphaseSeq、二重送信、ACK再送、複数タブ、同一ブラウザ二重参加、再接続競合、Origin制限、接続上限、CSP、XSS描画、全通常/特殊カード、購入/譲渡、偵察/告発、キル/共同キル、秘密目標、最終ターン/タイブレーク等を確認

## 未確認のこと

以下は**未確認**であり、完成条件未達の理由。

- `npm install` 成功
- `npm audit` 実結果
- Node.js 24環境での当該アプリ実行
- Express 5.2.1 / Socket.IO 4.8.3を実際に読み込んだサーバー起動
- 本物のSocket.IO接続を使った5クライアント同時対戦
- 公開マッチ5人の実ネットワークE2E
- プライベート5人の実ネットワークE2E
- 実Socket.IOで15ターン完走
- 実Socket.IO上で全カード/全特殊カード/購入/譲渡/偵察/告発/キル/共同キルの一巡
- 実通信での100秒/10秒タイマー同期誤差
- 実通信での全員準備OK/全員行動確定即時進行
- ブラウザ更新、Wi-Fi一時切断、圏外相当、復帰の実ネットワーク試験
- 実Socket負荷100〜500+接続
- iPhone Safari実機
- Android Chrome実機
- Safari/WebKitエンジン（この環境ではPlaywright WebKit実体が未導入）
- PC Edge/Firefox
- 本番リージョンでのCPU/RAM/遅延
- 公開HTTPS URLからの最終E2E

## npm install / npm audit

### npm install

**失敗。アプリの依存矛盾ではなく監査環境のネットワーク制約。**

- ローカルNode: v22.16.0
- npm: 10.9.2
- `npm install --no-fund`：依存取得できず
- `npm ping --registry=https://registry.npmjs.org --fetch-timeout=5000 --fetch-retries=0`：`getaddrinfo EAI_AGAIN registry.npmjs.org`
- `nodejs.org` も同様にコンテナからDNS取得不可
- Docker / Podmanなし

### npm audit

**未実施。結果を「0 vulnerabilities」とは扱わない。**

2026-09-10時点で公開npm情報上、直接指定している Express 5.2.1 / Socket.IO 4.8.3 はそれぞれlatestだが、これは`npm audit`の代替ではない。lockfileを生成した実依存ツリーで再監査が必要。

## 見つけた問題と修正

### 1. 日本語のみ要件に対する表示残り

再現：偵察履歴に `T7`、最終順位に `K 1` の英字略称が残っていた。

原因：表示用文字列だけ旧略称が残存。

修正：
- `T7` → `第7ターン`
- `K 1` → `キル 1`

影響：表示のみ。ゲームロジック変更なし。

### 2. モバイル主要操作のタップ領域が小さい

再現：390/360幅の実DOM計測で、ルール、クイック操作、チャット対象、購入等に28〜37px程度の操作領域を確認。

原因：デスクトップ向けの小型paddingをモバイルでも継承。

修正：900px以下で対象の主要小型操作を44px以上へ拡大。

回帰：390×844 / 360×800で対象44px未満0、横はみ出し0、110テストPASS。

### 3. 10秒行動フェーズで確定ボタンが初期表示外

再現：360×800でフェーズ開始時の `行動確定` が画面下へ約36px外れ、スクロールが必要。

原因：通常/特殊カード選択UIの縦量に対し確定ボタンが末尾配置。

修正：モバイルのみ、確定ボタンを行動パネル先頭へCSS orderで移し、stickyでスクロール中も到達可能に変更。

回帰：360×800 / 390×844とも初期表示内、操作要素との重なり0、横はみ出し0、110テストPASS。

## テスト結果

- 構文：PASS
- `npm run verify`：PASS
- Node tests：110/110 PASS
- 5人×15ターン engine simulation：PASS
- 決定的ランダム100試合：PASS
- 100,000試合×15ターン stress：PASS
- engine stress実測：32.029秒、最大RSS約136MB（監査コンテナ、Node 22.16.0）
- Chromium UI 390×844：PASS（クライアント描画のみ）
- Chromium UI 360×800：PASS（クライアント描画のみ）
- Chromium UI 1440×900：PASS（クライアント描画のみ）
- XSS文字列DOM投入：発火0

注意：100,000試合stressは**実Socket負荷試験ではない**。

## iPhone / Android / PC

- iPhone Safari実機：**未確認**
- iPhone相当390×844 Chromiumモバイルエミュレーション：クライアントUI PASS
- Android Chrome実機：**未確認**
- Android相当360×800 Chromiumモバイルエミュレーション：クライアントUI PASS
- PC Chromium 1440×900：クライアントUI PASS
- PCで実Socket.IOサーバーへ接続：**未確認**

## サーバー構成

現コードは1 Node.jsプロセスのメモリ状態を正としているため、初期公開は**1インスタンス固定**が適切。

必須条件：
- Node.js 24 LTS
- HTTPS/WSS
- WebSocket対応
- 1インスタンス固定
- `ALLOWED_ORIGINS`を公開URLへ固定
- 常時起動
- 自動水平スケールなし

制約：プロセス再起動で進行中試合は消失。複数インスタンス化にはRedis等のSocket.IO共有アダプタ＋共有ゲーム状態が必要。

### 第一候補

Fly.io Tokyo (`nrt`) の1 Machine。Tokyoリージョンが公式に存在し、今回の日本向け要件に最も一致する。ただし、このチャットからFly.ioアカウントへデプロイできる接続はなく、Tokyo固有の月額を監査時点で確定できていない。

### 現在接続済み経路の候補

Renderは接続済みだが、この連携で選択可能な最寄りリージョンはSingaporeでTokyoはない。Freeは15分の無通信で停止し、再起動に約1分かかるため一般公開ゲームの第一選択にはしない。費用まで確定できる最小の常時起動有料構成は **0.5 CPU / 512MB = US$7/月**。WebSocketとTLSに対応。

## 月額費用

- Render Free：$0/月。ただしidle spin-down/cold startがあるため本番推奨しない
- Render Singapore 0.5 CPU / 512MB：**$7/月 + 超過帯域等**
- Fly.io Tokyo：候補。地域別価格表は確認したが、監査取得結果からnrt固有行を確実に対応付けられなかったため**正確な月額は未確定**

## 公開URL

**未作成。**

理由：Render連携はあるが、ワークスペース内に既存サービス0、Renderへ渡すGit URLが必要で、現在のGitHub連携には利用可能なアカウント/リポジトリが0件。監査済みソースを本番ビルドへ渡せない状態。

## 残っている問題

1. ネット接続可能なNode 24環境で `npm install` / lockfile生成 / `npm audit`
2. Express/Socket.IO実起動
3. 5実クライアントSocket.IO E2E
4. 公開/プライベート双方15ターン完走
5. 実通信タイマー/再接続/更新/一時切断
6. 実Socket負荷試験
7. iPhone Safari / Android Chrome実機
8. 本番公開と公開URLからの再E2E
9. RULE_DECISIONS 27項目の最終仕様決定

## RULE_DECISIONS.md — 決定が必要な27項目

現実装とRULES.mdの間に、ここへ分離していない意図的な差は確認していない。今回、未確定ルールを勝手に変更していない。

1. 秘密目標の達成報酬
2. 秘密目標の初期配布
3. 死神
4. 耐久者
5. 鉄壁
6. 生存+50Pと第15ターン2倍
7. 無効 vs 無効
8. 複数のカード指定が同じ相手へ衝突
9. 同時ポイント泥棒
10. 複数攻撃 + 防御1の「誰が攻撃成功か」
11. 殺人鬼の「攻撃した」の定義
12. 特殊カード購入の中身
13. 購入・譲渡情報の公開範囲
14. 1ターン中の譲渡回数
15. 2倍偵察 / 2倍告発の2回目は必須か
16. 偵察で見える状態のタイミング
17. 同ターンに脱落したプレイヤーの偵察 / 告発
18. 防御成功ターンの数え方
19. 秘密目標得点を使った後の没収とマイナスポイント
20. タイブレークの「生存ターン数」
21. 脱落後のチャット
22. 全員脱落時の早期終了
23. カード指定中の最後の指定カード譲渡
24. 同じターンの秘密目標達成と告発成功の順序
25. ポイント泥棒が参照するポイントの時点
26. 無効化された行動のカード消費
27. カード指定を受けた後の購入・受領

## 変更ファイル

既存コードを大規模変更せず、今回の実監査差分は以下に限定。

- `public/app.js` — 日本語表示2箇所
- `public/styles.css` — モバイル操作領域と行動確定UI
- `test/static.test.js` — 上記回帰確認
- `README.md` — 実監査結果反映
- `AUDIT.md` — 実監査結果反映
- `FINAL_AUDIT_REPORT.md` — 本報告

`server.js` / `src/engine.js` / `src/rules.js` / `RULES.md` / `RULE_DECISIONS.md` のゲーム処理・正式仕様は変更していない。
