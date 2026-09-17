'use strict';

/**
 * 記事を書くときの Claude API 呼び出し。
 *
 * structure.js と同じく @anthropic-ai/sdk を使い、usage-log で消費量を記録する
 * （getDefaultRecorder で包むので、何も書かなくても data/usage-log に積み上がる）。
 */

const { instrumentClient, getDefaultRecorder, jstDateString } = require('./usage-log');

/** 記事を書くモデル。解説文を書くので、構造化より少し賢いモデルを既定にする。 */
const DEFAULT_MODEL = process.env.ANTHROPIC_ARTICLE_MODEL || 'claude-sonnet-5';

function createClient({ script } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY がありません');
  const Anthropic = require('@anthropic-ai/sdk');
  return instrumentClient(new Anthropic({ apiKey }), getDefaultRecorder({ script }));
}

/**
 * 1往復だけ聞く。返事の本文と、終わり方（途中で切れたかどうか）を返す。
 * 途中で切れたかを呼び出し側に伝えないと、「短く書き直して」と頼めない。
 */
async function ask({ system, prompt, model = DEFAULT_MODEL, maxTokens = 16000, script = 'ai' }) {
  const client = createClient({ script });
  const message = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = (message.content || [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');
  return { text, stopReason: message.stop_reason };
}

/**
 * 返事から JSON を取り出す。前置きや ``` の囲みが付いていても読めるようにする
 * （「JSONだけ返して」と頼んでも、たまに付いてくる）。読めなければ null。
 */
function extractJson(text) {
  const body = String(text || '').trim();
  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced ? fenced[1] : null, body].filter(Boolean);
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      /* 次の候補を試す */
    }
  }
  return null;
}

/** 日本時間の今日（YYYY-MM-DD）。 */
const jstDate = () => jstDateString();

module.exports = { ask, extractJson, jstDate, DEFAULT_MODEL, createClient };
