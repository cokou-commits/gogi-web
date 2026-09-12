# 秘密目標表示の再発修正 — 2026-09-12

## 原因
- `@media(max-height:760px)` が `.hudObjective{display:none}` を指定していた。
- iPhone Safari はブラウザUIの表示/非表示で `dvh` が変動し、760px以下になる場合があるため、同じ端末でも秘密目標が出たり消えたりした。

## 修正
- 760px以下でも秘密目標HUDを常時表示。
- 短画面では文字だけ圧縮し、秘密目標名・説明・状態を保持。
- HUD高さを112pxへ確保し、カード領域はスクロール可能な既存仕様を維持。
- 最終CSSに `display:block!important / visibility:visible / opacity:1` の安全柵を追加。
- サーバー側の `ensureSecretObjectives(room)` による欠損自動補完も維持。
- 回帰テスト追加。
