'use strict';

/**
 * 週次で、新規のフリーランス向け案件紹介エージェント/サービスをClaude(web_search)に
 * 発見させ、実際にHTTPアクセスして実在照合したうえで agents.json に追加する
 * エントリーポイント（.github/workflows/discover-agents.yml から呼び出される）。
 *
 * 【安全設計】lib/agent-discovery.js の2段階方式（discoverCandidates →
 * verifyCandidate）を経ていない候補は絶対に掲載しない。不一致・fetch失敗は
 * data/agent-discover-skip.json に記録し、以降の実行では除外リストに含めて
 * 再試行しない（無駄なAPI呼び出し・fetchを避けるため）。
 */

const fs = require('fs');
const path = require('path');

const {
  discoverCandidates,
  verifyCandidate,
  buildDiscoveredAgentFields,
  getAnthropicClient,
} = require('./lib/agent-discovery');
const { buildFaviconUrl, stripProtocol, topCategoryHints } = require('./structure');
const { promoteCategories } = require('./promote-categories');
const { NOT_DISCLOSED } = require('./lib/schema');

const AGENTS_PATH = path.join(__dirname, '..', 'agents.json');
const CATEGORIES_PATH = path.join(__dirname, '..', 'categories.json');
const SKIP_PATH = path.join(__dirname, '..', 'data', 'agent-discover-skip.json');

/** 1回の実行あたりに新規発見を試みる候補数の上限。環境変数で調整可能。 */
const MAX_PER_RUN = Number(process.env.DISCOVER_MAX_PER_RUN || 10);

const REVIEW_NOTE = '口コミデータは未収集です（今後のアップデートで追加予定）。';
const COMPANY_REVIEW_NOTE = '企業からの口コミデータは未収集です（今後のアップデートで追加予定）。';

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/** 既存agents.jsonの最大idの次の値を発行する（idが数値化できるエントリのみ対象）。 */
function nextId(agents) {
  let max = 0;
  for (const a of agents) {
    const n = Number(a.id);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/**
 * 実在照合済みの候補をagents.jsonのスキーマに組み立てる。数値実績・手数料等、
 * 発見・照合の過程では確認しようがない項目はすべてNOT_DISCLOSEDとし、AIによる
 * 創作を防ぐ（structure.js の assembleEntry と同じ「事実が無ければ非公開」方針）。
 */
function assembleDiscoveredEntry(candidate, ai, id) {
  return {
    id,
    source: 'ai-discovered',
    name: candidate.name,
    category: ai.category,
    categoryHint: ai.category === 'その他' ? (ai.categoryHint || null) : null,
    targetAge: NOT_DISCLOSED,
    region: NOT_DISCLOSED,
    jobCount: NOT_DISCLOSED,
    feeRate: NOT_DISCLOSED,
    talentRange: NOT_DISCLOSED,
    oneLiner: ai.oneLiner,
    companyOneLiner: ai.companyOneLiner,
    appeal: ai.appeal,
    companyAppeal: ai.companyAppeal || null,
    features: [],
    reviews: [],
    reviewNote: REVIEW_NOTE,
    companyReviews: [],
    companyReviewNote: COMPANY_REVIEW_NOTE,
    feeExplanation: NOT_DISCLOSED,
    commitmentExplanation: NOT_DISCLOSED,
    website: stripProtocol(candidate.website),
    faviconUrl: buildFaviconUrl(candidate.website),
    affiliateUrl: null,
    featured: false,
    real: true,
    sourceNote: 'AIによるWeb検索で発見・実在照合済み',
    companyDetail: {
      permitNumber: NOT_DISCLOSED,
      placementRate: NOT_DISCLOSED,
      avgDays: NOT_DISCLOSED,
      trackRecord: NOT_DISCLOSED,
      refundPolicy: NOT_DISCLOSED,
      upfrontFee: NOT_DISCLOSED,
      minContract: NOT_DISCLOSED,
      exclusivity: NOT_DISCLOSED,
      capacity: NOT_DISCLOSED,
      sourcingMethod: NOT_DISCLOSED,
      reportingFreq: NOT_DISCLOSED,
      handoverPolicy: NOT_DISCLOSED,
      onboardingSupport: NOT_DISCLOSED,
      confidentiality: NOT_DISCLOSED,
    },
    linkVerified: true,
    lastLinkCheckAt: new Date().toISOString(),
  };
}

async function main() {
  const agents = readJson(AGENTS_PATH, []);
  const skipList = readJson(SKIP_PATH, {});

  const excludeNames = [...agents.map(a => a.name).filter(Boolean), ...Object.keys(skipList)];

  console.log(
    `Discovering up to ${MAX_PER_RUN} new freelance-agent candidate(s) ` +
      `(excluding ${excludeNames.length} known name(s): ${agents.length} listed + ${Object.keys(skipList).length} skip-listed)...`
  );

  const candidates = await discoverCandidates(excludeNames, MAX_PER_RUN);
  console.log(`AI proposed ${candidates.length} candidate(s) via web_search.`);

  let listedCount = 0;
  let skippedCount = 0;
  let promotedNames = [];

  if (candidates.length > 0) {
    const anthropic = getAnthropicClient();
    const existingHints = topCategoryHints(agents);
    let id = nextId(agents);
    const now = new Date().toISOString();

    for (const candidate of candidates) {
      console.log(`Verifying candidate: ${candidate.name} <${candidate.website}>`);
      const verification = await verifyCandidate(candidate);

      if (!verification.ok) {
        skipList[candidate.name] = {
          name: candidate.name,
          website: candidate.website,
          reason: verification.reason,
          checkedAt: now,
        };
        skippedCount += 1;
        console.log(`  SKIP (${verification.reason}) — recorded in ${path.basename(SKIP_PATH)}, will not retry.`);
        continue;
      }

      console.log('  VERIFIED — structuring via AI...');
      let ai;
      try {
        ai = await buildDiscoveredAgentFields(candidate, anthropic, existingHints);
      } catch (err) {
        // 実在は確認済みだが構造化AI呼び出し自体が失敗（レート制限等）した場合は
        // スキップリストに入れず、次回の実行で再試行する。
        console.warn(`  Structuring failed for ${candidate.name}: ${err.message}. Will retry next run.`);
        continue;
      }

      const entry = assembleDiscoveredEntry(candidate, ai, id);
      agents.push(entry);
      id += 1;
      listedCount += 1;
      console.log(`  LISTED as id=${entry.id}, category=${entry.category}${entry.categoryHint ? ` (hint: ${entry.categoryHint})` : ''}`);
    }

    if (listedCount > 0) {
      writeJson(AGENTS_PATH, agents);
    }
    if (skippedCount > 0) {
      writeJson(SKIP_PATH, skipList);
    }

    if (listedCount > 0) {
      const categories = readJson(CATEGORIES_PATH, []);
      const result = promoteCategories(agents, categories);
      promotedNames = result.promotedNames;
      if (result.promotedNames.length > 0 || result.reclassifiedCount > 0) {
        writeJson(AGENTS_PATH, agents);
        writeJson(CATEGORIES_PATH, categories);
      }
    }
  }

  console.log(
    `Discovery finished: found=${candidates.length}, listed=${listedCount}, skipped=${skippedCount}` +
      (promotedNames.length ? `, promotedCategories=${promotedNames.join('、')}` : '')
  );
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main, assembleDiscoveredEntry, nextId };
