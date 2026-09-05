'use strict';

/**
 * 一時的な単発修正スクリプト: id=38(ビザスクdirect)は、記録されていたURL
 * (visasq.com)が実体ページへのリダイレクトスタブに誤マッチしていたため、
 * appeal/features等が実質的に空の状態だった。正しい実体ページ
 * (direct.visasq.com)のURLに修正し、その本文を元にAI構造化フィールドを
 * 再生成してこの1件だけ更新する。実行後は削除して構わない。
 *
 * 使い方: ANTHROPIC_API_KEY=xxx node scraper/fix-id38-visasq.js
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const {
  getAnthropicClient,
  buildDiscoveredAgentFields,
  fetchWithVerifyUA,
} = require('./lib/agent-discovery');
const { buildFaviconUrl, stripProtocol, topCategoryHints } = require('./structure');

const AGENTS_PATH = path.join(__dirname, '..', 'agents.json');
const TARGET_ID = 38;
const NEW_URL = 'https://direct.visasq.com';
const PAGE_TEXT_MAX_CHARS = 4000; // lib/agent-discovery.js の buildPageText と同じ上限
const MIN_CONTENT_LENGTH = 200; // 同上、thinContent判定の閾値

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function main() {
  const agents = readJson(AGENTS_PATH);
  const agent = agents.find(a => Number(a.id) === TARGET_ID);
  if (!agent) throw new Error(`id=${TARGET_ID} が見つかりません`);

  console.log(`Fetching ${NEW_URL} ...`);
  const html = await fetchWithVerifyUA(NEW_URL);
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();
  const rawBodyText = $('body').text();
  const pageText = rawBodyText
    .replace(/[ \t　]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
    .slice(0, PAGE_TEXT_MAX_CHARS);
  const thinContent = pageText.length < MIN_CONTENT_LENGTH;
  console.log(`pageText length: ${pageText.length} (thinContent=${thinContent})`);

  const anthropic = getAnthropicClient();
  const existingHints = topCategoryHints(agents.filter(a => Number(a.id) !== TARGET_ID));
  const candidate = { name: agent.name, website: NEW_URL };
  const ai = await buildDiscoveredAgentFields(candidate, pageText, anthropic, existingHints, thinContent);

  agent.category = ai.category;
  agent.categoryHint = ai.category === 'その他' ? (ai.categoryHint || null) : null;
  agent.contractTypes = ai.contractTypes || [];
  agent.remoteRatio = ai.remoteRatio || null;
  agent.feeStructure = ai.feeStructure || { type: 'unknown', note: null };
  agent.freelancerCount = ai.freelancerCount || null;
  agent.oneLiner = ai.oneLiner;
  agent.companyOneLiner = ai.companyOneLiner;
  agent.appeal = ai.appeal;
  agent.companyAppeal = ai.companyAppeal || null;
  agent.features = ai.features || [];
  agent.website = stripProtocol(NEW_URL);
  agent.faviconUrl = buildFaviconUrl(NEW_URL);
  agent.linkVerified = true;
  agent.lastLinkCheckAt = new Date().toISOString();

  writeJson(AGENTS_PATH, agents);
  console.log(`Updated id=${TARGET_ID} (${agent.name}).`);
  console.log('appeal:', agent.appeal);
  console.log('features:', agent.features);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main };
