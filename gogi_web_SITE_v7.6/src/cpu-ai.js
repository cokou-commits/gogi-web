'use strict';

// Optional AI phrasing layer for CP chat.
// Strategy remains deterministic/local in cpu.js. The external model only turns a
// locally selected tactical intent into short, natural Japanese. If the API is
// absent, rate-limited, slow, or errors, the original local sentence is used.

const usageByRoom = new WeakMap();

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(raw));
}

function envInt(name, fallback, min, max) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function cleanGeneratedText(text, max = 120) {
  let out = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/^[\s\-–—•*「『"']+|[\s」』"']+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!out) return '';
  // Do not let the bot break character or expose implementation details.
  if (/(?:Gemini|言語モデル|人工知能|AIとして|CPとして|CPUとして|システムプロンプト)/i.test(out)) return '';
  return [...out].slice(0, max).join('');
}

function visibleRank(room, cpu) {
  if (!room || !cpu || Number(room.turn || 0) < 10) return null;
  const mine = Number(cpu.points || 0);
  const values = room.players.map(p => Number(p.points || 0));
  const rank = values.filter(v => v > mine).length + 1;
  const tied = values.filter(v => v === mine).length > 1;
  return { rank, tied, total: values.length };
}

function consumeBudget(room) {
  const max = envInt('CPU_AI_MAX_REQUESTS_PER_TURN', 8, 1, 30);
  const turn = Number(room?.turn || 0);
  const current = usageByRoom.get(room);
  if (!current || current.turn !== turn) {
    usageByRoom.set(room, { turn, used: 1 });
    return true;
  }
  if (current.used >= max) return false;
  current.used += 1;
  return true;
}

function styleLabel(style) {
  return ({
    aggressive: '強気で圧をかけるが無謀ではない',
    cautious: '慎重で信用を簡単には置かない',
    analyst: '冷静な頭脳派で観察と誘導が得意',
    trickster: '策士でブラフ・ミスリード・駆け引きが得意'
  })[style] || '冷静な頭脳派';
}

function publicEventSummary(room) {
  const events = room?.lastResult?.publicEvents || [];
  return events.slice(-4).map(e => String(e?.text || '').trim()).filter(Boolean).join(' / ');
}

function buildPrompt(room, cpu, plan) {
  const brain = cpu?.cpuBrain || {};
  const rank = visibleRank(room, cpu);
  const rankText = rank ? `${rank.tied ? '同率' : ''}${rank.rank}位/${rank.total}人` : 'まだ非公開';
  const trigger = String(plan?.triggerSummary || '会話フェーズ中の自発的な心理戦発言').slice(0, 160);
  const fallback = String(plan?.text || '').slice(0, 160);
  const events = publicEventSummary(room) || '直前の公開結果なし';

  return [
    'あなたは5人制心理戦カードゲーム「五疑戦」のプレイヤー1人として発言する。',
    '目的は勝つことで、自然な日本語の心理戦をする。AIやCPだと絶対に名乗らない。',
    `性格: ${styleLabel(brain.style)}`,
    `現在: 第${Number(room?.turn || 1)}ターン、HP${Number(cpu?.hp || 0)}、自分の所持P${Number(cpu?.points || 0)}、自分の順位=${rankText}`,
    `直前の公開情報: ${events}`,
    `会話の状況: ${trigger}`,
    `戦略上の発言意図: ${fallback}`,
    '',
    '制約:',
    '- 出力はチャット本文だけ。説明・箇条書き・引用符・絵文字は禁止。',
    '- 1〜2文、できれば12〜55文字。最大100文字。',
    '- 若い日本人がオンラインゲームで自然に打つ口調。毎回同じ言い回しにしない。',
    '- 発言意図は維持するが、自然な言い換え・牽制・誘導・ブラフは可。',
    '- 与えられていないHP、ポイント、手札、秘密目標などを事実として捏造しない。ブラフするときも具体的な未提供数値を作らない。',
    '- 侮辱、差別、性的表現、現実の脅迫、個人情報要求は禁止。',
    '- 正式な同盟システムはないので、共闘は非公式な約束として扱う。',
    '- 自由チャットの真偽は秘密目標の嘘判定には使われない。'
  ].join('\n');
}

function extractGeminiText(json) {
  const parts = json?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.filter(p => !p?.thought && typeof p?.text === 'string').map(p => p.text).join(' ');
}

async function generateCpuChatText(room, cpu, plan) {
  const fallback = cleanGeneratedText(plan?.text || '');
  if (!fallback) return '';
  if (!envBool('CPU_AI_CHAT_ENABLED', false)) return fallback;

  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey || !consumeBudget(room)) return fallback;

  const model = String(process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim() || 'gemini-3.8-flash';
  const timeoutMs = envInt('CPU_AI_TIMEOUT_MS', 2200, 600, 6000);
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt(room, cpu, plan) }] }],
        generationConfig: {
          temperature: 0.95,
          topP: 0.92,
          maxOutputTokens: 96,
          thinkingConfig: { thinkingLevel: 'low' }
        }
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return fallback;
    const json = await response.json();
    return cleanGeneratedText(extractGeminiText(json)) || fallback;
  } catch {
    return fallback;
  }
}

function aiChatConfigured() {
  return envBool('CPU_AI_CHAT_ENABLED', false) && !!String(process.env.GEMINI_API_KEY || '').trim();
}

module.exports = {
  generateCpuChatText,
  aiChatConfigured,
  buildPrompt,
  cleanGeneratedText,
  extractGeminiText
};
