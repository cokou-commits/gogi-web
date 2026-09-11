# CP AIチャット設定

## そのままでも動く

`GEMINI_API_KEY` を設定しなくても、CPはローカル戦略エンジンで行動し、自由チャットも行います。外部API料金は0円です。

## Gemini無料枠を使って発言をAI生成する

RenderのEnvironmentへ次を追加します。

```env
CPU_AI_CHAT_ENABLED=true
GEMINI_API_KEY=あなたのGemini APIキー
GEMINI_MODEL=gemini-3.8-flash
CPU_AI_TIMEOUT_MS=2200
CPU_AI_MAX_REQUESTS_PER_TURN=8
```

- 戦略・行動選択はローカルCPが担当し、Geminiは発言の自然な言い換えだけを担当します。
- 人間の生チャット本文そのものはGeminiへ送らず、「同盟提案」「赤への攻撃提案」などサーバー側で分類した会話要約だけを送ります。
- APIキー未設定、レート制限、無料枠上限、通信障害、タイムアウト時はローカル会話へ自動フォールバックします。
- 課金を絶対に発生させたくない場合は、Gemini側で有料プランへアップグレードせず無料枠のまま利用してください。
