'use strict';

/**
 * 一時的なバックフィルスクリプト: 既存agents.json全件のうち companyFeatures が空の
 * エントリについて、companyAppeal（既存の発注側向け紹介文）を元にAI(Haiku)で
 * companyFeatures（箇条書き3件程度）だけを追加生成する。
 *
 * creative作文を防ぐため、companyAppealに書かれている内容の抽出・言い換えのみを
 * 生成させる（本文に無い新しい情報を作らない）。companyAppealの内容が薄い/
 * featuresの焼き直しにしかならない場合は、無理に埋めず空配列のままにする。
 *
 * 実行後は削除して構わない一回限りのスクリプト。
 *
 * 使い方: ANTHROPIC_API_KEY=xxx node scraper/backfill-company-features.js
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
 * companyAppealテキストから、箇条書き用のcompanyFeatures（0〜3件）をAIに抽出させる。
 * companyAppealに書かれている内容の要約・言い換えのみを生成させ、creative作文を防ぐ。
 * 企業目線での具体的な事実が読み取れない場合は、空配列を正直に返させる。
 */
async function extractCompanyFeaturesFromAppeal(anthropic, name, companyAppeal) {
  const tool = {
    name: 'extract_company_features',
    description: '発注側企業向けの紹介文（companyAppeal）から、箇条書き表示用の短い特徴を抽出する。',
    input_schema: {
      type: 'object',
      properties: {
        companyFeatures: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 3,
          description:
            '紹介文に書かれている、発注・掲載したい企業側にとって具体的で魅力的な事実を、' +
            '箇条書き用として最大3件抽出する（各項目は15〜25字程度の短い体言止め・簡潔な文）。' +
            'creative作文ではなく、紹介文に実際に書かれている内容の抽出・言い換えであること。' +
            '新しい情報を付け加えないこと。紹介文が企業目線での具体的な情報を含まない' +
            '（フリーランス向けの内容の焼き直しにしかならない）場合は、無理に埋めず' +
            '正直に空配列 [] とすること。',
        },
      },
      required: ['companyFeatures'],
      additionalProperties: false,
    },
  };

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 500,
    tools: [tool],
    tool_choice: { type: 'tool', name: 'extract_company_features' },
    messages: [{
      role: 'user',
      content:
        `以下は、フリーランス向け案件紹介サービス「${name}」の、発注・掲載したい企業向けの` +
        `紹介文です。\n\n${companyAppeal}\n\n` +
        'この紹介文の内容に基づいて extract_company_features ツールを呼び出してください。\n\n' +
        '厳守事項:\n' +
        '- creative作文ではなく、あくまで紹介文に実際に書かれている内容の抽出・言い換えであること。' +
        '紹介文に基づかない新しい情報を創作しないこと。\n' +
        '- 紹介文の単なる分割ではなく、別々の具体的なポイントをそれぞれ短い箇条書きにすること。\n' +
        '- 紹介文から企業目線での具体的な特徴を読み取れない場合は空配列 [] とする（無理に埋めない）。\n',
    }],
  });

  const toolUse = msg.content.find(b => b.type === 'tool_use');
  if (!toolUse) throw new Error('AI response did not include a tool_use block');

  const result = toolUse.input;
  return Array.isArray(result.companyFeatures) ? result.companyFeatures : [];
}

async function main() {
  const agents = readJson(AGENTS_PATH);
  const targets = agents.filter(a => !Array.isArray(a.companyFeatures) || a.companyFeatures.length === 0);

  console.log(`Total agents: ${agents.length}, targets (empty companyFeatures): ${targets.length}`);

  if (targets.length === 0) {
    console.log('No targets. Nothing to do.');
    return;
  }

  const anthropic = getAnthropicClient();
  let filledCount = 0;
  let emptyCount = 0;

  for (const agent of targets) {
    if (!agent.companyAppeal || !agent.companyAppeal.trim()) {
      console.log(`  SKIP id=${agent.id} (${agent.name}): companyAppeal is empty`);
      continue;
    }
    try {
      const companyFeatures = await extractCompanyFeaturesFromAppeal(anthropic, agent.name, agent.companyAppeal);
      agent.companyFeatures = companyFeatures;
      if (companyFeatures.length > 0) {
        filledCount += 1;
      } else {
        emptyCount += 1;
      }
      console.log(`  id=${agent.id} (${agent.name}): companyFeatures=${JSON.stringify(companyFeatures)}`);
    } catch (err) {
      console.warn(`  FAILED id=${agent.id} (${agent.name}): ${err.message}`);
    }
  }

  writeJson(AGENTS_PATH, agents);
  console.log(`Backfill finished: ${filledCount} filled, ${emptyCount} legitimately empty, out of ${targets.length} targets.`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { extractCompanyFeaturesFromAppeal, main };
