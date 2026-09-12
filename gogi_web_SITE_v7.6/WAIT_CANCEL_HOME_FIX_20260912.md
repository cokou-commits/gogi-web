# 待機をやめる → トップ復帰 修正（2026-09-12）

- `待機をやめる` 後の `location.replace()` を廃止。
- 退出時は同一ページ内で即座にホームへ確定遷移する。
- `leavingLobby` / `sessionWritesBlocked` / `ignoredLobbyRoomKey` で遅延state・resume・人数同期による待機室復元を遮断。
- 退出に使うtokenは現在stateの `resumeToken` を最優先に変更。
- サーバーの待機枠除去は sendBeacon / keepalive / Socket leaveRoom でバックグラウンド実行し、画面遷移は待たない。
- JS/CSSキャッシュキーを更新。
