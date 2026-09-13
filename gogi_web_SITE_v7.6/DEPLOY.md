# 五疑戦 v7.6 — 本番公開チェック

## 実行環境

- Node.js: 24.21.x（`package.json` は `>=24.21.0 <25`）
- Start: `npm start`
- Health: `GET /health`
- 状態はサーバーメモリ保持のため、**1インスタンス運用**を前提とする
- autoscaling / 複数インスタンス化は、共有Socket.IO adapter + 共有状態ストアを導入するまで行わない

## 環境変数

`.env.example` を基準に設定する。

- `NODE_ENV=production`
- `PORT` — Render等が渡す値を使用可能
- `ALLOWED_ORIGINS` — 実公開Originをカンマ区切りで指定。本番は必須
- `REQUIRE_ALLOWED_ORIGINS=true` — 本番では既定のまま
- `MAX_ACTIVE_ROOMS`
- `MAX_STORED_ROOMS`
- `MAX_SOCKET_CONNECTIONS`
- `EXPOSE_HEALTH_DETAILS=false` — 公開本番では内部数値を出さない

## Render等での推奨

1. Node 24対応ランタイムを使用
2. Build: `npm install`（lockfileを保存した後は `npm ci`）
3. Start: `npm start`
4. Health path: `/health`
5. インスタンス数: 1
6. 本番URLを `ALLOWED_ORIGINS` に設定
7. HTTPSを使用

このZIPはオフライン監査環境で作成されており `package-lock.json` を捏造していません。ネット接続可能な環境で最初に依存を解決したら、生成されたlockfileをリポジトリへ保存し、その後は `npm ci` へ固定してください。

## 公開前コマンド

```bash
npm install
npm run verify
npm audit
npm start
```

## 必須E2E

- 公開マッチ5人成立
- プライベートマッチ5人成立
- 会話・行動選択10分 / 全生存者「次へ」で即処理
- 結果確認1分 / 接続中人間全員「次へ」で即進行
- 全通常カード / 全特殊カード
- 他人防御 / 他人回復 / 完全防御自分専用
- 2倍攻撃 / 防御 / 偵察 / 告発 / 回復
- 無効 / カード指定 / 同時ポイント泥棒
- 購入 / 交換（無料片側交換を含む）
- 交換の提案 / 拒否 / 取消 / 期限切れ / 成立通知
- 公開契約4条件 / 複数参加 / 余剰返却 / 取消 / 期限切れ / 精算通知
- 1位予想3/6/9ターン / 試合中秘匿 / 終了時全員公開
- 5/10/15ターン開始ボーナス、15ターン生存+50P
- 最終ターン倍率例外
- 最終画面で賭け前順位・賭け結果・正式最終順位を表示
- 秘密目標10種 / 欠損時の自動修復
- 全体チャット / 色別個別チャット / 通知音
- 切断 / 更新 / 再接続 / バックグラウンド復帰
- ACK遅延/消失を模した経済操作再送
- iPhone Safari / Android Chrome / PC ChromeまたはEdge
- 15ターン完走を複数回

## セキュリティ確認

- `ALLOWED_ORIGINS` が実URLだけになっている
- HTTPS / HSTS
- `npm audit` が許容可能
- セッショントークンや秘密目標を外部ログへ出さない
- `/health` が本番で内部ルーム数等を露出しない
- 1インスタンスで動いている

## 運用上の限界

- サーバー再起動で進行中試合は失われる
- アカウントなしのため、別端末まで含めた同一人物の多重参加を完全には防げない
- 通信品質・Safariバックグラウンド挙動は実端末E2Eで最終確認が必要
