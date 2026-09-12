# 五疑戦 v7.6 — 本番公開ガイド

## 推奨初期構成

日本人向け小規模公開では以下。

- **Node.js 24 LTS+**
- **日本から最も近い利用可能リージョン / 1インスタンス**
  - Renderを使う場合は **Singapore**（Tokyoリージョンはない）
- HTTPS必須
- WebSocket対応
- 常時起動
- Docker利用可

Socket.IOを使用するため、静的サイトだけではゲームサーバーは動きません。

2026-09-10監査時の主要依存:

- Node.js 24 LTS
- Express 5.2.1
- Socket.IO 4.8.3

公開直前には、Work側で改めて最新安定版・セキュリティ情報・`npm audit`を確認してください。

## 環境変数

```text
PORT=3000
NODE_ENV=production
MAX_ACTIVE_ROOMS=300
MAX_STORED_ROOMS=600
MAX_SOCKET_CONNECTIONS=2000
ALLOWED_ORIGINS=https://実際の公開ドメイン
REQUIRE_ALLOWED_ORIGINS=true
```

### ALLOWED_ORIGINS

**本番では既定で必須です。** 未設定のまま `NODE_ENV=production` で起動すると安全側に倒して起動エラーにします。

複数ドメインはカンマ区切り。

`REQUIRE_ALLOWED_ORIGINS=false` は閉じた検証環境などでのみ使用してください。一般公開では使用しないでください。

### 容量上限

- `MAX_ACTIVE_ROOMS`: lobby / playingを含む終了前ルーム上限
- `MAX_STORED_ROOMS`: 終了画面保持中を含む総ルーム上限
- `MAX_SOCKET_CONNECTIONS`: Socket.IO総接続上限

初期値は保護用の上限であり、実際に安全な同時人数を保証する値ではありません。Workで負荷試験し、CPU / RAMに合わせて下げるか上げてください。

## Docker

```bash
docker build -t gogi-web .
docker run --rm -p 3000:3000 --env-file .env gogi-web
```

本番の `GET /health` は既定で `{ "ok": true }` のみ返し、ルーム数・Socket数・uptimeは公開しません。閉じた監視環境で詳細が必要な場合だけ `EXPOSE_HEALTH_DETAILS=true` を設定してください。

## 1インスタンス前提

進行中試合と再接続セッションはメモリ保持。

- 1インスタンス：対応
- プロセス再起動：進行中試合消失
- 複数インスタンス：そのままでは不可

水平分散する場合:

- Redis等のSocket.IO共有アダプタ
- 共有ゲーム状態 / セッションストア
- sticky sessionの要否確認
- 状態バージョン / 競合制御
- 再起動復旧方針

を別設計してください。

## リバースプロキシ / ホスティング

- WebSocket Upgradeを許可
- 長時間接続を短いidle timeoutで切らない
- HTTPS終端後もSocket.IOが同一オリジンで接続できること
- 単一インスタンス構成では勝手なautoscalingを無効化または1固定

## 本番前

ネット接続可能な環境で:

```bash
npm install
npm run verify
npm audit
npm start
```

初回に生成された `package-lock.json` は保存し、その後の本番ビルドは原則 `npm ci` を使用してください。このZIPには、依存取得ができない環境で偽のlockfileを生成することを避けるため `package-lock.json` を同梱していません。

## 必須E2E

- 公開マッチ5人成立
- プライベート5人成立
- 会話＋行動選択10分 / 生存者全員が「次へ」で即処理
- 結果表示1分 / 接続中の人間全員が「次へ」で即進行
- 全通常 / 全特殊
- 同時攻撃 / 同時告発 / 同時ポイント泥棒 / カード指定競合
- 購入 / カード譲渡 / ポイント譲渡
- ACK遅延を模した経済操作再送
- 別タブで同一復帰セッションを奪えないこと
- 同一ブラウザIDで同時に別対戦へ参加できないこと
- 切断 / 更新 / 再接続
- iPhone Safari
- Android Chrome
- PC Chrome / Edge
- 15ターン完走
- 想定規模のSocket負荷試験

## 公開前セキュリティ

- HTTPS
- `ALLOWED_ORIGINS`を本番URLに固定
- `npm audit`
- 依存更新確認
- ログへ秘密目標 / セッショントークンを出さない
- ホスティング側DDoS / WAF / rate limitの利用可否を確認
- 利用規約 / プライバシーポリシー / 通報・問い合わせ方針を決める

アカウントなしの公開サービスはアプリ内部のレート制限だけで大規模DDoSを完全防御できません。外部エッジ / ホスティング側の保護と組み合わせてください。
