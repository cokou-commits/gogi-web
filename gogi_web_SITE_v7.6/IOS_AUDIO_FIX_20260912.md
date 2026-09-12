iPhone音声修正
- BGMを実体WAVファイルで再生し、Web Audio生成BGMはフォールバック化
- BGM音量とSEマスター音量を引き上げ
- pointer/touch/clickで音声アンロックを再試行
- AudioContext resume時に短いバッファを開始
- 対応端末ではaudioSession=playbackを設定
- バックグラウンド復帰時に音声状態を再同期
