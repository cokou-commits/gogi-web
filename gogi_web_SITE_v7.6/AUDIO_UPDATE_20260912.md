# BGM / 効果音追加

- ゲームタイトル直下に BGM ON/OFF・SE ON/OFF を追加。
- 設定は端末の localStorage に保存。
- iPhone等の自動再生制限に合わせ、最初のユーザー操作後に Web Audio を有効化。
- BGMはWeb Audio APIで生成する低音量の心理戦向けループ。外部音源・著作権素材は不使用。
- チャット、UI、HP/ポイント変化、ターン、結果、脱落、秘密目標、終了などに効果音を追加。
