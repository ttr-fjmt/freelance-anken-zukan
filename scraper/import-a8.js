'use strict';

/**
 * A8.net アフィリエイト提携サービスのExcel（data/a8-import/ 配下）を読み込み、
 * agents.json に featured サービスとして取り込む。
 *
 * Excelはagent-zukan側と共通のテンプレート（サイト列で対象を判別する共用シート）
 * のため、B列（サイト）が"フリーランス案件図鑑"の行のみを処理対象とする。
 * G列（対象年代）はフリーランス版のスキーマに存在しない項目のため読み込まない。
 *
 * - 既存agents.jsonと会社名（完全一致）で突き合わせる:
 *   - マッチした場合 → 既存エントリを featured: true に格上げし、category/region/
 *     紹介文まわり・affiliateUrl を更新する。id・sourceは変更しない。
 *     Excelには元々情報が無い項目（contractTypes/remoteRatio/feeStructure/
 *     freelancerCount等）は、AI側が具体的な値を返さない限り既存の値を温存する。
 *   - マッチしない場合 → 新規エントリとして追加する（source: "a8"、id: "a8-NNN"）。
 * - AI構造化には lib/agent-discovery.js の buildDiscoveredAgentFields をそのまま
 *   再利用する（現行スキーマ(contractTypes/remoteRatio/feeStructure/freelancerCount)
 *   と一致させるため。structure.jsのbuildWithAIは廃止済みの旧スキーマ
 *   (targetAge/talentRange/companyDetail全項目)を前提としており流用できない）。
 *   Excelには公式サイトの実際のページ本文が無いため、E列（特徴）・H列（なにに
 *   特化しているか）の原文を pageText として渡し、そこからの抽出・要約として
 *   扱わせる。
 * - ANTHROPIC_API_KEY が無い環境では、buildOfflineA8Fields() による簡易フォール
 *   バックで動作する（データマッピング・重複除去・突き合わせの検証はAPIキー
 *   無しでも行える）。
 *
 * 使い方:
 *   node import-a8.js [path-to-xlsx] [--dry-run]
 *   例: node import-a8.js ../data/a8-import/a8-freelance-20260906.xlsx --dry-run
 *
 * path-to-xlsx を省略した場合、data/a8-import/ 配下の .xlsx ファイルのうち、
 * ファイル名の辞書順で最も新しいもの（findLatestA8File参照）を自動的に対象とする。
 * 毎月Tatsuroさんが新しいExcelファイルをこのディレクトリに追加していく運用を想定した
 * もの。ファイル名には a8-freelance-YYYYMMDD.xlsx のように日付を含める前提とする
 * （更新日時ではなくファイル名でソートする理由: GitHub Actions上ではactions/checkout
 * 時に全ファイルの更新日時がチェックアウト時刻にリセットされてしまい、更新日時では
 * 「最新」を正しく判定できないため）。
 */

const fs = require('fs');
const path = require('path');

const XLSX = require('xlsx');

const { NOT_DISCLOSED } = require('./lib/schema');
const { buildDiscoveredAgentFields, getAnthropicClient } = require('./lib/agent-discovery');
const { topCategoryHints } = require('./structure');
const { promoteCategories } = require('./promote-categories');

const AGENTS_PATH = path.join(__dirname, '..', 'agents.json');
const CATEGORIES_PATH = path.join(__dirname, '..', 'categories.json');
const A8_IMPORT_DIR = path.join(__dirname, '..', 'data', 'a8-import');

/** このExcelは複数サイト共用テンプレートのため、この値の行のみを対象とする。 */
const TARGET_SITE = 'フリーランス案件図鑑';

const REVIEW_NOTE = '口コミデータは未収集です（今後のアップデートで追加予定）。';
const COMPANY_REVIEW_NOTE = '企業からの口コミデータは未収集です（今後のアップデートで追加予定）。';

const A8_COMPANY_DETAIL_DEFAULTS = {
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

/**
 * data/a8-import/ 配下の .xlsx ファイルのうち、ファイル名の辞書順で最も新しいものを返す。
 * 1件も無ければ null を返す。ファイル名に日付（YYYYMMDD等）を含める運用を前提としており、
 * 辞書順ソートがそのまま時系列順になる（a8-freelance-20260906.xlsx < a8-freelance-20261001.xlsx）。
 */
function findLatestA8File() {
  if (!fs.existsSync(A8_IMPORT_DIR)) return null;
  const files = fs
    .readdirSync(A8_IMPORT_DIR)
    .filter(name => /\.xlsx$/i.test(name))
    .sort();
  if (files.length === 0) return null;
  return path.join(A8_IMPORT_DIR, files[files.length - 1]);
}

function todayJst() {
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date());
}

function buildA8SourceNote(fileBaseName) {
  return (
    `A8.netアフィリエイト提携情報（${fileBaseName}）をもとに作成。取得日: ${todayJst()}。` +
    `掲載情報は提携先の申告内容に基づきます。手数料体系・登録フリーランス数等の数値情報は今回のデータには含まれていません。`
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

/**
 * B列(サイト)が TARGET_SITE の行のみを対象にし、C・D・E・F・H列（広告主名・リンク・
 * 特徴・対応エリア・なにに特化しているか）が全て埋まっている行だけを処理対象として返す。
 * G列（対象年代）はフリーランス版のスキーマに存在しないため読み込まない。
 */
function readRows(filePath) {
  const wb = XLSX.readFile(filePath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(sheet, { defval: null });
  return raw
    .filter(r => cell(r['サイト']) === TARGET_SITE)
    .map(r => ({
      name: cell(r['広告主名']),
      affiliateUrl: extractAffiliateUrl(r['リンク']),
      feature: cell(r['特徴']),
      region: cell(r['対応エリア']),
      specialty: cell(r['なにに特化しているか']),
    }))
    .filter(r => r.name && r.affiliateUrl && r.feature && r.region && r.specialty);
}

/**
 * 広告主名（会社名）だけをキーにした重複除去。1件目（先頭行）を採用し、以降はスキップする。
 * 完全に同一内容の行・同名で異なるリンクの行、どちらも同じルール（先勝ち）で処理される。
 */
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
    const m = /^a8-(\d+)$/.exec(String(a.id == null ? '' : a.id));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

/**
 * ANTHROPIC_API_KEY が無い場合の非AIフォールバック。E・H列の原文からの機械的な
 * キーワード判定のみ行う（buildDiscoveredAgentFieldsが本来担うAI判断の簡易代替）。
 * 「転職支援」「転職エージェント」等、フリーランス/業務委託ではなく正社員雇用への
 * 転職支援を主眼とするサービスは、既存カテゴリーのいずれにも無理に当てはめず
 * 「その他」とする（例: M&A業界特化の転職エージェント等）。
 */
function guessCategoryOfflineA8(hay) {
  if (/転職支援|転職エージェント|正社員/.test(hay) && !/フリーランス|業務委託|準委任/.test(hay)) {
    return 'その他';
  }
  if (/IT|Web|エンジニア|システム|データサイエンス|プログラ/i.test(hay)) return 'IT・Web開発';
  if (/デザイン|デザイナー|UI\/UX/i.test(hay)) return 'デザイン';
  // 「動画編集」等の複合語がライティング側に誤爆しないよう、動画・クリエイティブの判定を先に行う。
  if (/動画|映像|クリエイティブ|撮影/.test(hay)) return '動画・クリエイティブ';
  if (/ライティング|記事作成|コピーライ|校正|編集(?!スキル|スクール)/.test(hay)) return 'ライティング・編集';
  if (/コンサル|士業|税理士|弁護士|会計士|社労士/.test(hay)) return 'コンサル・士業';
  if (/事務|バックオフィス|経理|人事|総務/.test(hay)) return '事務・バックオフィス';
  if (/営業|マーケ|販売|広告/.test(hay)) return '営業・マーケティング';
  if (/フリーランス|案件紹介|案件マッチング|複業|副業/.test(hay)) return 'フリーランス案件マッチング';
  return 'その他';
}

/** ANTHROPIC_API_KEY が無い場合の非AIフォールバック。事実（Excelの原文）の範囲を出ない組み立てのみ行う。 */
function buildOfflineA8Fields(row) {
  const hay = `${row.feature || ''} ${row.specialty || ''}`;
  const category = guessCategoryOfflineA8(hay);
  return {
    category,
    categoryHint: null,
    oneLiner: (row.specialty ? `${row.specialty}に関する案件紹介サービス。` : row.feature || NOT_DISCLOSED).slice(0, 60),
    companyOneLiner: (row.specialty ? `${row.specialty}に特化したサービス。` : row.feature || NOT_DISCLOSED).slice(0, 60),
    appeal: (row.feature || NOT_DISCLOSED).slice(0, 200),
    companyAppeal: (row.feature || NOT_DISCLOSED).slice(0, 200),
    contractTypes: [],
    remoteRatio: null,
    feeStructure: { type: 'unknown', note: null },
    freelancerCount: null,
  };
}

/** 新規エントリを組み立てる（Excelに情報が無い項目は固定値、website/faviconUrlはnull）。 */
function buildNewEntry({ id, row, ai, sourceNote }) {
  return {
    id,
    source: 'a8',
    name: row.name,
    category: ai.category,
    categoryHint: ai.category === 'その他' ? (ai.categoryHint || null) : null,
    region: row.region || NOT_DISCLOSED,
    jobCount: NOT_DISCLOSED,
    feeRate: NOT_DISCLOSED,
    contractTypes: ai.contractTypes || [],
    remoteRatio: ai.remoteRatio || null,
    feeStructure: ai.feeStructure || { type: 'unknown', note: null },
    freelancerCount: ai.freelancerCount || null,
    oneLiner: ai.oneLiner,
    companyOneLiner: ai.companyOneLiner,
    appeal: ai.appeal,
    companyAppeal: ai.companyAppeal || ai.appeal,
    features: ai.features || [],
    reviews: [],
    reviewNote: REVIEW_NOTE,
    companyReviews: [],
    companyReviewNote: COMPANY_REVIEW_NOTE,
    commitmentExplanation: NOT_DISCLOSED,
    website: null,
    faviconUrl: null,
    affiliateUrl: row.affiliateUrl,
    featured: true,
    real: true,
    sourceNote,
    companyDetail: { ...A8_COMPANY_DETAIL_DEFAULTS },
  };
}

/**
 * 既存エントリへのマージ更新。category/region/紹介文まわり・featured・affiliateUrl
 * のみ上書きし、それ以外（website/companyDetail/reviews/sourceNote等、Excelに元々
 * 情報が無い項目）は既存の値をそのまま温存する。contractTypes等、AIが具体的な値を
 * 返さなかった場合も既存の値を壊さない。id・sourceは変更しない。
 */
function mergeIntoExisting(existing, { row, ai }) {
  return {
    ...existing,
    category: ai.category,
    categoryHint: ai.category === 'その他' ? (ai.categoryHint || null) : null,
    region: row.region || existing.region,
    oneLiner: ai.oneLiner,
    companyOneLiner: ai.companyOneLiner,
    appeal: ai.appeal,
    companyAppeal: ai.companyAppeal || ai.appeal,
    features: (ai.features && ai.features.length > 0) ? ai.features : existing.features,
    contractTypes: (ai.contractTypes && ai.contractTypes.length > 0) ? ai.contractTypes : existing.contractTypes,
    remoteRatio: ai.remoteRatio || existing.remoteRatio,
    feeStructure: (ai.feeStructure && ai.feeStructure.type !== 'unknown') ? ai.feeStructure : existing.feeStructure,
    freelancerCount: ai.freelancerCount || existing.freelancerCount,
    affiliateUrl: row.affiliateUrl,
    featured: true,
  };
}

async function main() {
  const { file, dryRun } = parseArgs(process.argv.slice(2));

  let filePath;
  if (file) {
    filePath = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }
  } else {
    filePath = findLatestA8File();
    if (!filePath) {
      console.error(
        `Usage: node import-a8.js <path-to-xlsx> [--dry-run]\n` +
          `(no path given, and no .xlsx file found under ${A8_IMPORT_DIR} to auto-detect)`
      );
      process.exit(1);
    }
    console.log(`No file specified — auto-detected latest file: ${path.basename(filePath)}`);
  }

  const rows = readRows(filePath);
  const { unique, skipped } = dedupeByName(rows);

  console.log(`Read ${rows.length} "${TARGET_SITE}" row(s) from ${path.basename(filePath)}.`);
  if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length} duplicate row(s) (same 広告主名 — first occurrence wins):`);
    skipped.forEach(r => console.log(`  - ${r.name}`));
  }
  console.log(`${unique.length} unique compan${unique.length === 1 ? 'y' : 'ies'} to process.`);

  const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf8'));
  // name完全一致に加え、aliasNames（例: 別サービス名で統合された際の旧登録名・
  // 持株会社名等）でも突き合わせる。A8の広告主名が、実際にはAI発見等で既に別名で
  // 掲載済みの同一サービスの持株会社・旧社名だった場合（統合済み）に、再インポートの
  // たびに重複追加してしまうのを防ぐため。
  const byName = new Map();
  for (const a of agents) {
    byName.set(a.name, a);
    for (const alias of a.aliasNames || []) {
      byName.set(alias, a);
    }
  }
  let nextIdNum = nextA8IdCounter(agents);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const anthropic = apiKey ? getAnthropicClient() : null;
  if (!anthropic) {
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
    // Excelには公式サイトの実ページ本文が無いため、E・H列の原文をpageTextとして渡す
    // （buildDiscoveredAgentFieldsは「実際に取得したページ本文からの抽出・要約」を
    // 前提に設計されているため、ここではExcelの申告内容がその代わりとなる）。
    const pageText = `${row.feature}\n\n特化領域: ${row.specialty}\n対応エリア: ${row.region}`;
    const candidate = { name: row.name, website: '(A8.netアフィリエイト提携情報のため公式サイトURLは未取得)' };

    let ai;
    if (anthropic) {
      try {
        ai = await buildDiscoveredAgentFields(candidate, pageText, anthropic, existingHints);
        aiCalls += 1;
      } catch (err) {
        console.warn(`AI structuring failed for ${row.name}: ${err.message}. Falling back to offline builder.`);
        ai = buildOfflineA8Fields(row);
        offlineBuilds += 1;
      }
    } else {
      ai = buildOfflineA8Fields(row);
      offlineBuilds += 1;
    }

    if (existing) {
      const merged = mergeIntoExisting(existing, { row, ai });
      finalEntriesById.set(existing.id, merged);
      updated += 1;
      console.log(`[update] ${row.name} (id=${existing.id}) category=${merged.category}`);
    } else {
      const id = `a8-${String(nextIdNum++).padStart(3, '0')}`;
      const entry = buildNewEntry({ id, row, ai, sourceNote });
      finalEntriesById.set(id, entry);
      added += 1;
      console.log(`[add]    ${row.name} (id=${id}) category=${entry.category}${entry.categoryHint ? ` (hint: ${entry.categoryHint})` : ''}`);
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

  if (added > 0 || updated > 0) {
    const categories = fs.existsSync(CATEGORIES_PATH) ? JSON.parse(fs.readFileSync(CATEGORIES_PATH, 'utf8')) : [];
    const result = promoteCategories(finalAgents, categories);
    if (result.promotedNames.length > 0 || result.reclassifiedCount > 0) {
      fs.writeFileSync(AGENTS_PATH, JSON.stringify(finalAgents, null, 2) + '\n', 'utf8');
      fs.writeFileSync(CATEGORIES_PATH, JSON.stringify(categories, null, 2) + '\n', 'utf8');
      console.log(
        `Category promotion: promoted=${result.promotedNames.join('、') || 'none'}, reclassified=${result.reclassifiedCount}`
      );
    }
  }
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
  findLatestA8File,
  guessCategoryOfflineA8,
  buildOfflineA8Fields,
  buildNewEntry,
  mergeIntoExisting,
  buildA8SourceNote,
};
