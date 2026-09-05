'use strict';

/**
 * 週次で、新規のフリーランス向け案件紹介エージェント/サービスをClaude(web_search)に
 * カテゴリー別に発見させ、実際にHTTPアクセスして実在照合したうえで agents.json に
 * 追加するエントリーポイント（.github/workflows/discover-agents.yml から呼び出される）。
 *
 * 【安全設計】lib/agent-discovery.js の discoverCandidates() が、カテゴリーごとの
 * web_search呼び出しと実在照合(verifyCandidate)までを内部で一貫して行う。この
 * 2段階方式を経ていない候補は絶対に掲載しない。不一致・fetch失敗は
 * data/agent-discover-skip.json に記録し、以降の実行では除外リストに含めて
 * 再試行しない（無駄なAPI呼び出し・fetchを避けるため）。
 */

const fs = require('fs');
const path = require('path');

const {
  discoverCandidates,
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
 *
 * targetAge・talentRange・companyDetail.placementRate/onboardingSupport・
 * 数値ベースのfeeExplanationは、公式サイト本文から確度高く抽出できる項目では
 * ないためスキーマから廃止し、代わりに contractTypes・remoteRatio・
 * feeStructure・freelancerCount（いずれも buildDiscoveredAgentFields が
 * ページ本文から抽出）を採用する。
 *
 * verifiedUrl には verifyCandidate() が実際にアクセスできたURL（candidate.website
 * そのまま、またはルートドメインへのフォールバック先）を渡す。AIが提示したURLの
 * パス・サブドメイン・ドメイン表記がわずかに誤っていたケースがあったため、掲載時の
 * website/faviconUrlは、AIの提示値ではなく実際に実在確認が取れたURLを使う。
 */
function assembleDiscoveredEntry(candidate, ai, id, verifiedUrl) {
  const websiteUrl = verifiedUrl || candidate.website;
  return {
    id,
    source: 'ai-discovered',
    name: candidate.name,
    category: ai.category,
    categoryHint: ai.category === 'その他' ? (ai.categoryHint || null) : null,
    region: NOT_DISCLOSED,
    jobCount: NOT_DISCLOSED,
    feeRate: NOT_DISCLOSED,
    contractTypes: ai.contractTypes || [],
    remoteRatio: ai.remoteRatio || null,
    feeStructure: ai.feeStructure || { type: 'unknown', note: null },
    freelancerCount: ai.freelancerCount || null,
    oneLiner: ai.oneLiner,
    companyOneLiner: ai.companyOneLiner,
    appeal: ai.appeal,
    companyAppeal: ai.companyAppeal || null,
    features: [],
    reviews: [],
    reviewNote: REVIEW_NOTE,
    companyReviews: [],
    companyReviewNote: COMPANY_REVIEW_NOTE,
    commitmentExplanation: NOT_DISCLOSED,
    website: stripProtocol(websiteUrl),
    faviconUrl: buildFaviconUrl(websiteUrl),
    affiliateUrl: null,
    featured: false,
    real: true,
    sourceNote: 'AIによるWeb検索で発見・実在照合済み',
    companyDetail: {
      permitNumber: NOT_DISCLOSED,
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
    `Discovering up to ${MAX_PER_RUN} new freelance-agent candidate(s) across categories ` +
      `(excluding ${excludeNames.length} known name(s): ${agents.length} listed + ${Object.keys(skipList).length} skip-listed)...`
  );

  // discoverCandidates() がカテゴリーごとにweb_searchと実在照合(verifyCandidate)まで
  // 内部で行い、累計の照合成功数がMAX_PER_RUNに達した時点で残りのカテゴリーをスキップする。
  const { verified, skipped, perCategory } = await discoverCandidates(excludeNames, MAX_PER_RUN);
  const totalFound = perCategory.reduce((sum, c) => sum + c.found, 0);
  console.log(`AI proposed ${totalFound} candidate(s) via web_search across ${perCategory.length} categorie(s), ${verified.length} passed verification.`);

  const now = new Date().toISOString();
  for (const { candidate, reason } of skipped) {
    skipList[candidate.name] = {
      name: candidate.name,
      website: candidate.website,
      reason,
      checkedAt: now,
    };
  }
  if (skipped.length > 0) {
    console.log(`Recorded ${skipped.length} skipped candidate(s) in ${path.basename(SKIP_PATH)}, will not retry.`);
  }

  let listedCount = 0;
  let promotedNames = [];

  if (verified.length > 0) {
    const anthropic = getAnthropicClient();
    const existingHints = topCategoryHints(agents);
    let id = nextId(agents);

    for (const { candidate, pageText, verifiedUrl } of verified) {
      console.log(`Structuring verified candidate: ${candidate.name} <${candidate.website}>`);
      let ai;
      try {
        ai = await buildDiscoveredAgentFields(candidate, pageText, anthropic, existingHints);
      } catch (err) {
        // 実在は確認済みだが構造化AI呼び出し自体が失敗（レート制限等）した場合は
        // スキップリストに入れず、次回の実行で再試行する。
        console.warn(`  Structuring failed for ${candidate.name}: ${err.message}. Will retry next run.`);
        continue;
      }

      const entry = assembleDiscoveredEntry(candidate, ai, id, verifiedUrl);
      agents.push(entry);
      id += 1;
      listedCount += 1;
      console.log(`  LISTED as id=${entry.id}, category=${entry.category}${entry.categoryHint ? ` (hint: ${entry.categoryHint})` : ''}`);
    }
  }

  if (listedCount > 0) {
    writeJson(AGENTS_PATH, agents);
  }
  if (skipped.length > 0) {
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

  console.log('--- Category breakdown ---');
  for (const c of perCategory) {
    console.log(`${c.category}: 発見${c.found}件・掲載${c.listed}件・スキップ${c.skipped}件`);
  }

  console.log(
    `Discovery finished: found=${totalFound}, listed=${listedCount}, skipped=${skipped.length}` +
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
