# 五疑 v7.6 サイト仕上げ版

## 今回の変更
- 既存の対戦ロジック、RULES.md、RULE_DECISIONS.md、server.js、src/engine.js、src/rules.js は変更なし。
- トップ画面の導線を整理し、公開マッチ / 友達とのプライベート対戦 / 遊び方を明確化。
- 3ステップのゲーム進行説明を追加。
- favicon とOG基本メタデータを追加。
- ロビー / 対戦中の接続状態表示を追加。
- 通信切断時に「再接続中」を画面内バナーで明示し、再接続後に表示を解除。
- 既存のスマホ44pxタップ領域、safe-area、行動確定sticky UIを維持。

## 回帰確認
- `npm run verify`: 111/111 PASS
- `node scripts/stress.js`: 10,000試合 × 15ターン PASS

## 未確認
- この環境では依存取得用の外部DNS通信が制限されているため `npm install` / `npm audit` は未実行。
- Node.js 24上の実Express/Socket.IO起動、実5ブラウザ同時対戦、実iPhone Safari、実Android Chrome、本番公開URLは未確認。
