'use strict';

/**
 * A8.net アフィリエイト提携エージェントのExcel（data/a8-import/ 配下）を読み込み、
 * agents.json に featured エージェントとして取り込む。
 *
 * - 既存agents.jsonと会社名で突き合わせる:
 *   - マッチした場合 → 既存エントリを「マージ更新」する。category/region/targetAge/
 *     oneLiner/appeal等の紹介文まわりはExcel側（AI構造化結果）で上書きするが、
 *     website/feeRate/companyDetail等、Excelには元々情報が無い項目は既存の値を
 *     壊さないよう温存する（既存エントリが持つ厚みのある実データを失わないため）。
 *     id・source は変更しない。
 *   - マッチしない場合 → 新規エントリとして追加する（source: "a8"、id: "a8-NNN"）。
 * - AI構造化には structure.js の buildWithAI（source: "a8" 分岐）をそのまま再利用する。
 * - ANTHROPIC_API_KEY が無い環境では、buildOfflineA8() による簡易フォールバックで動作する
 *   （データマッピング・重複除去・突き合わせの検証はAPIキー無しでも行える）。
 *
 * 使い方:
 *   node import-a8.js <path-to-xlsx> [--dry-run]
 *   例: node import-a8.js ../data/a8-import/a8-agents-20260904.xlsx --dry-run
 */

const fs = require('fs');
const path = require('path');

const XLSX = require('xlsx');

const { NOT_DISCLOSED } = require('./lib/schema');
const { buildWithAI, topCategoryHints } = require('./structure');

const AGENTS_PATH = path.join(__dirname, '..', 'agents.json');

const TALENT_RANGE_NOT_DISCLOSED = '非公開（具体的なレンジの記載なし）';

const A8_COMPANY_DETAIL_DEFAULTS = {
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
};

function parseArgs(argv) {
  const args = { file: null, dryRun: false };
  for (const raw of argv) {
    if (raw === '--dry-run') args.dryRun = true;
    else if (raw.startsWith('--file=')) args.file = raw.slice('--file='.length);
    else if (!args.file) args.file = raw;
  }
  return args;
}

function todayJst() {
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date());
}

function buildA8SourceNote(fileBaseName) {
  return (
    `A8.netアフィリエイト提携情報（${fileBaseName}）をもとに作成。取得日: ${todayJst()}。` +
    `掲載情報は提携先の申告内容に基づきます。手数料・実績等の数値情報は今回のデータには含まれていません。`
  );
}

/** <a href="...">...</a> の href 部分のみを抽出する（1x1トラッキング画像タグは無視）。 */
function extractAffiliateUrl(linkHtml) {
  if (!linkHtml) return null;
  const match = /<a\s+[^>]*href="([^"]+)"/i.exec(String(linkHtml));
  return match ? match[1] : null;
}

function cell(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s || null;
}

function readRows(filePath) {
  const wb = XLSX.readFile(filePath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(sheet, { defval: null });
  return raw
    .map(r => ({
      name: cell(r['広告主名']),
      affiliateUrl: extractAffiliateUrl(r['リンク']),
      feature: cell(r['このエージェントの特徴']),
      region: cell(r['対応エリア']),
      targetAge: cell(r['対象年代']),
      specialty: cell(r['なにに特化しているか']),
    }))
    .filter(r => r.name);
}

/** 広告主名（会社名）だけをキーにした重複除去。1件目（先頭行）を採用し、以降はスキップする。 */
function dedupeByName(rows) {
  const seen = new Map();
  const skipped = [];
  for (const row of rows) {
    if (seen.has(row.name)) {
      skipped.push(row);
      continue;
    }
    seen.set(row.name, row);
  }
  return { unique: [...seen.values()], skipped };
}

/** 既存agents.jsonの "a8-NNN" 形式idの最大値+1から連番を振る（複数回のインポートをまたいでも衝突しない）。 */
function nextA8IdCounter(agents) {
  let max = 0;
  for (const a of agents) {
    const m = /^a8-(\d+)$/.exec(a.id || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

function guessCategoryOfflineA8(row) {
  const hay = `${row.feature || ''} ${row.specialty || ''}`;
  if (/IT|Web|エンジニア|システム|データサイエンス/i.test(hay)) return 'IT・Web';
  if (/建設|施工|不動産|建築/.test(hay)) return '施工管理・建設';
  if (/営業|マーケ|販売/.test(hay)) return '営業・マーケティング';
  if (/外資|グローバル|海外/.test(hay)) return '外資・グローバル';
  if (/スタートアップ|ベンチャー/.test(hay)) return 'スタートアップ・ベンチャー';
  if (/地方|UIターン|Uターン|Iターン/i.test(hay)) return '地方転職・UIターン';
  if (/新卒|第二新卒|ポテンシャル/.test(hay)) return '第二新卒・ポテンシャル層';
  if (/管理部門|コンサル|経理|人事|バックオフィス/.test(hay)) return '管理部門・コンサル';
  return 'その他';
}

/** ANTHROPIC_API_KEY が無い場合の非AIフォールバック。事実（Excelの原文）の範囲を出ない組み立てのみ行う。 */
function buildOfflineA8(row) {
  const category = guessCategoryOfflineA8(row);
  const features = [row.feature, row.specialty, row.region].filter(Boolean).slice(0, 3);
  while (features.length < 1) features.push(NOT_DISCLOSED);

  return {
    category,
    categoryHint: null,
    oneLiner: row.specialty ? `${row.specialty}に強みを持つ転職支援サービス。` : row.feature || NOT_DISCLOSED,
    companyOneLiner: row.specialty ? `${row.specialty}に特化した採用支援サービス。` : row.feature || NOT_DISCLOSED,
    appeal: row.feature || NOT_DISCLOSED,
    companyAppeal: row.feature || NOT_DISCLOSED,
    features,
  };
}

/**
 * 新規エントリを組み立てる（Excelに情報が無い項目は固定値、website/faviconUrlはnull）。
 */
function buildNewEntry({ id, row, ai, sourceNote }) {
  return {
    id,
    source: 'a8',
    name: row.name,
    category: ai.category,
    categoryHint: ai.category === 'その他' ? (ai.categoryHint || null) : null,
    targetAge: row.targetAge || NOT_DISCLOSED,
    region: row.region || NOT_DISCLOSED,
    jobCount: NOT_DISCLOSED,
    feeRate: NOT_DISCLOSED,
    talentRange: TALENT_RANGE_NOT_DISCLOSED,
    oneLiner: ai.oneLiner,
    companyOneLiner: ai.companyOneLiner,
    appeal: ai.appeal,
    companyAppeal: ai.companyAppeal || ai.appeal,
    features: ai.features,
    reviews: [],
    reviewNote: null,
    companyReviews: [],
    companyReviewNote: null,
    feeExplanation: NOT_DISCLOSED,
    commitmentExplanation: NOT_DISCLOSED,
    website: null,
    faviconUrl: null,
    affiliateUrl: row.affiliateUrl,
    featured: true,
    real: true,
    sourceNote,
    companyDetail: { ...A8_COMPANY_DETAIL_DEFAULTS },
    _sourceUrl: null,
    _rawHash: null,
  };
}

/**
 * 既存エントリへのマージ更新。category/region/targetAge/紹介文まわり・featured・affiliateUrl
 * のみ上書きし、それ以外（website/feeRate/companyDetail/reviews/sourceNote/_sourceUrl等）は
 * 既存の値をそのまま温存する（Excel側に元々情報が無い項目で、既存の実データを消さないため）。
 */
function mergeIntoExisting(existing, { row, ai }) {
  return {
    ...existing,
    category: ai.category,
    categoryHint: ai.category === 'その他' ? (ai.categoryHint || null) : null,
    targetAge: row.targetAge || existing.targetAge,
    region: row.region || existing.region,
    oneLiner: ai.oneLiner,
    companyOneLiner: ai.companyOneLiner,
    appeal: ai.appeal,
    companyAppeal: ai.companyAppeal || ai.appeal,
    features: ai.features,
    affiliateUrl: row.affiliateUrl,
    featured: true,
  };
}

async function main() {
  const { file, dryRun } = parseArgs(process.argv.slice(2));
  if (!file) {
    console.error('Usage: node import-a8.js <path-to-xlsx> [--dry-run]');
    process.exit(1);
  }
  const filePath = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const rows = readRows(filePath);
  const { unique, skipped } = dedupeByName(rows);

  console.log(`Read ${rows.length} row(s) from ${path.basename(filePath)}.`);
  if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length} duplicate row(s) (same 広告主名 — first occurrence wins):`);
    skipped.forEach(r => console.log(`  - ${r.name}`));
  }
  console.log(`${unique.length} unique compan${unique.length === 1 ? 'y' : 'ies'} to process.`);

  const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf8'));
  const byName = new Map(agents.map(a => [a.name, a]));
  let nextIdNum = nextA8IdCounter(agents);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  let anthropic = null;
  if (apiKey) {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropic = new Anthropic({ apiKey });
  } else {
    console.warn('ANTHROPIC_API_KEY is not set — running in offline fallback mode (no AI structuring).');
  }
  const existingHints = topCategoryHints(agents);
  const sourceNote = buildA8SourceNote(path.basename(filePath));

  const finalEntriesById = new Map(agents.map(a => [a.id, a]));
  let updated = 0;
  let added = 0;
  let aiCalls = 0;
  let offlineBuilds = 0;

  for (const row of unique) {
    const existing = byName.get(row.name);
    const rawForAI = {
      companyName: row.name,
      feature: row.feature,
      specialty: row.specialty,
      region: row.region,
      targetAge: row.targetAge,
    };

    let ai;
    if (anthropic) {
      try {
        ai = await buildWithAI(rawForAI, anthropic, 'a8', existingHints);
        aiCalls += 1;
      } catch (err) {
        console.warn(`AI structuring failed for ${row.name}: ${err.message}. Falling back to offline builder.`);
        ai = buildOfflineA8(row);
        offlineBuilds += 1;
      }
    } else {
      ai = buildOfflineA8(row);
      offlineBuilds += 1;
    }

    if (existing) {
      const merged = mergeIntoExisting(existing, { row, ai });
      finalEntriesById.set(existing.id, merged);
      updated += 1;
      console.log(`[update] ${row.name} (id=${existing.id})`);
    } else {
      const id = `a8-${String(nextIdNum++).padStart(3, '0')}`;
      const entry = buildNewEntry({ id, row, ai, sourceNote });
      finalEntriesById.set(id, entry);
      added += 1;
      console.log(`[add]    ${row.name} (id=${id})`);
    }
  }

  console.log(`\nDone. updated=${updated} added=${added} ai=${aiCalls} offline=${offlineBuilds}`);

  if (dryRun) {
    console.log('[dry-run] agents.json was not modified.');
    return;
  }

  // 既存の並び順を維持しつつ、更新分はその場で差し替え、新規分は末尾に追加する。
  const finalAgents = agents.map(a => finalEntriesById.get(a.id));
  const existingIds = new Set(agents.map(a => a.id));
  for (const [id, entry] of finalEntriesById) {
    if (!existingIds.has(id)) finalAgents.push(entry);
  }

  fs.writeFileSync(AGENTS_PATH, JSON.stringify(finalAgents, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${finalAgents.length} agents to ${AGENTS_PATH}.`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  readRows,
  dedupeByName,
  extractAffiliateUrl,
  nextA8IdCounter,
  buildOfflineA8,
  buildNewEntry,
  mergeIntoExisting,
  buildA8SourceNote,
};
