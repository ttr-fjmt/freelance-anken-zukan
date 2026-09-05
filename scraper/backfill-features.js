'use strict';

/**
 * 一時的なバックフロースクリプト: 既存agents.json全件のうち features が空の
 * エントリについて、appeal（既存の長文紹介）を元にAI(Haiku)で箇条書き用の
 * features（1〜3件程度）だけを追加生成する。
 *
 * creative作文を防ぐため、appealに書かれている内容の抽出・言い換えのみを
 * 生成させる（本文に無い新しい情報を作らない）。
 *
 * 実行後は削除して構わない一回限りのスクリプト。
 *
 * 使い方: ANTHROPIC_API_KEY=xxx node scraper/backfill-features.js
 */

const fs = require('fs');
const path = require('path');

const { getAnthropicClient } = require('./lib/agent-discovery');

const AGENTS_PATH = path.join(__dirname, '..', 'agents.json');
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/**
 * appealテキストから、箇条書き用のfeatures（1〜3件）をAIに抽出させる。
 * appealに書かれている内容の要約・言い換えのみを生成させ、creative作文を防ぐ。
 */
async function extractFeaturesFromAppeal(anthropic, name, appeal) {
  const tool = {
    name: 'extract_features',
    description: '紹介文（appeal）から、箇条書き表示用の短い特徴を抽出する。',
    input_schema: {
      type: 'object',
      properties: {
        features: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 3,
          description:
            '紹介文に書かれている具体的な特徴を、箇条書き用として1〜3件抽出する' +
            '（各項目は15〜25字程度の短い体言止め・簡潔な文）。' +
            'creative作文ではなく、紹介文に実際に書かれている内容の抽出・言い換えであること。' +
            '新しい情報を付け加えないこと。',
        },
      },
      required: ['features'],
      additionalProperties: false,
    },
  };

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 500,
    tools: [tool],
    tool_choice: { type: 'tool', name: 'extract_features' },
    messages: [{
      role: 'user',
      content:
        `以下は、フリーランス向け案件紹介サービス「${name}」の紹介文です。\n\n${appeal}\n\n` +
        'この紹介文の内容に基づいて extract_features ツールを呼び出してください。\n\n' +
        '厳守事項:\n' +
        '- creative作文ではなく、あくまで紹介文に実際に書かれている内容の抽出・言い換えであること。' +
        '紹介文に基づかない新しい情報を創作しないこと。\n' +
        '- 紹介文の単なる分割ではなく、別々の具体的なポイントをそれぞれ短い箇条書きにすること。\n' +
        '- 紹介文から具体的な特徴を読み取れない場合は空配列 [] とする（無理に埋めない）。\n',
    }],
  });

  const toolUse = msg.content.find(b => b.type === 'tool_use');
  if (!toolUse) throw new Error('AI response did not include a tool_use block');

  const result = toolUse.input;
  return Array.isArray(result.features) ? result.features : [];
}

async function main() {
  const agents = readJson(AGENTS_PATH);
  const targets = agents.filter(a => !Array.isArray(a.features) || a.features.length === 0);

  console.log(`Total agents: ${agents.length}, targets (empty features): ${targets.length}`);

  if (targets.length === 0) {
    console.log('No targets. Nothing to do.');
    return;
  }

  const anthropic = getAnthropicClient();
  let filledCount = 0;

  for (const agent of targets) {
    if (!agent.appeal || !agent.appeal.trim()) {
      console.log(`  SKIP id=${agent.id} (${agent.name}): appeal is empty`);
      continue;
    }
    try {
      const features = await extractFeaturesFromAppeal(anthropic, agent.name, agent.appeal);
      agent.features = features;
      filledCount += 1;
      console.log(`  id=${agent.id} (${agent.name}): features=${JSON.stringify(features)}`);
    } catch (err) {
      console.warn(`  FAILED id=${agent.id} (${agent.name}): ${err.message}`);
    }
  }

  writeJson(AGENTS_PATH, agents);
  console.log(`Backfill finished: ${filledCount}/${targets.length} entries updated.`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { extractFeaturesFromAppeal, main };
