'use strict';

/**
 * A8.net アフィリエイト提携サービスのExcel（data/a8-import/ 配下、固定ファイル名
 * A8_FILE_NAME）を読み込み、agents.json に featured サービスとして取り込む。
 *
 * 以前はagent-zukan側と共用のテンプレート（サイト列で対象を判別する共用シート）を
 * 使っており、かつファイル名に日付を含めて複数ファイルの中から最新を検出していたが、
 * 今後はこのサイト専用の固定ファイル名で都度上書き更新される運用に変更された
 * （図鑑4-5）。そのため、サイト列によるフィルタリング・複数ファイルからの最新検出
 * ロジックは廃止した。列の対応付けはExcelのヘッダー行の文言（"広告主名"等）で解決
 * するため、シート上の列の位置（アルファベット）自体には依存しない。
 *
 * - 対象行は「広告主名・リンク・特徴」が埋まっている行のみ（対応エリア・特化領域は
 *   空欄でも対象とする。空欄の場合はAIに特徴列の本文から推測させる。対象年代列は
 *   今後一切参照しない）。
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
 *   Excelには公式サイトの実際のページ本文が無いため、特徴列・特化領域列の原文を
 *   pageText として渡し、そこからの抽出・要約として扱わせる（対応エリア・
 *   カテゴリーの推測もこの呼び出しに含まれる）。
 * - ANTHROPIC_API_KEY が無い環境では、buildOfflineA8Fields() による簡易フォール
 *   バックで動作する（データマッピング・重複除去・突き合わせの検証はAPIキー
 *   無しでも行える）。
 * - 正常に処理（新規追加または既存更新）できた行は、読み込み元Excel自体のA列
 *   （反映）をTRUEに書き換えて上書き保存する（markRowsReflected）。処理中に
 *   エラーが起きた行はA列を更新せず、警告をログに出力するのみに留める。
 *
 * 使い方:
 *   node import-a8.js [--dry-run]
 *   （data/a8-import/<A8_FILE_NAME> を固定で読み込む。パスの指定はできない）
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

/** 今後、A8案件のExcelはこの固定ファイル名で都度上書き更新される運用とする。 */
const A8_FILE_NAME = 'アフィリエイト案件_フリーランス案件図鑑.xlsx';

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
  const args = { dryRun: false };
  for (const raw of argv) {
    if (raw === '--dry-run') args.dryRun = true;
  }
  return args;
}

/** data/a8-import/ 配下の固定ファイル名のフルパスを返す（dirを渡すとテスト用に差し替え可能）。 */
function resolveA8FilePath(dir = A8_IMPORT_DIR) {
  return path.join(dir, A8_FILE_NAME);
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
 * 「広告主名・リンク・特徴」が埋まっている行のみを対象として返す。列の対応付けは
 * ヘッダー行の文言で解決するため（サイト列の有無・列の並び順の変化に依存しない）、
 * このExcelが今後サイト専用の固定レイアウトになっても引き続き動作する。
 * 対応エリア・特化領域は空欄でも対象に含める（後段でAIに推測させるため）。
 * 対象年代列は今後一切参照しない。
 *
 * 各行には sheetRowIndex（0-indexed。物理的なシート上の行番号は sheetRowIndex+1、
 * ヘッダー行がr=0のため）を持たせる。XLSX.utils.sheet_to_json(sheet,{defval:null})は
 * 範囲内の行を欠番なく順番に出力するため、出力配列のインデックスがそのまま
 * 物理行番号に対応することを利用している（markRowsReflectedでの書き戻し用）。
 */
function readRows(filePath) {
  const wb = XLSX.readFile(filePath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(sheet, { defval: null });
  return raw
    .map((r, i) => ({
      sheetRowIndex: i,
      name: cell(r['広告主名']),
      affiliateUrl: extractAffiliateUrl(r['リンク']),
      feature: cell(r['特徴']),
      region: cell(r['対応エリア']),
      specialty: cell(r['なにに特化しているか']),
    }))
    .filter(r => r.name && r.affiliateUrl && r.feature);
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
 * ANTHROPIC_API_KEY が無い場合の非AIフォールバック。特徴・特化領域の原文からの機械的な
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

/**
 * ANTHROPIC_API_KEY が無い場合の非AIフォールバック。対応エリア列が空欄の場合に、
 * 特徴・特化領域の原文からキーワードで簡易推定する（見つからなければnullを返し、
 * 呼び出し元でNOT_DISCLOSEDにフォールバックする）。
 */
function guessRegionOfflineA8(hay) {
  if (/全国/.test(hay)) return '全国（お問い合わせで確認）';
  if (/在宅|リモートワーク|フルリモート|オンライン完結/.test(hay)) return '全国（オンライン対応）';
  const prefectureMatch = /(北海道|東北|関東|中部|近畿|関西|中国|四国|九州|沖縄|東京|大阪|愛知|福岡|神奈川|埼玉|千葉|京都|兵庫)/.exec(hay);
  if (prefectureMatch) return `${prefectureMatch[1]}近郊（お問い合わせで確認）`;
  return null;
}

/** ANTHROPIC_API_KEY が無い場合の非AIフォールバック。事実（Excelの原文）の範囲を出ない組み立てのみ行う。 */
function buildOfflineA8Fields(row) {
  const hay = `${row.feature || ''} ${row.specialty || ''}`;
  const category = guessCategoryOfflineA8(hay);
  const region = row.region || guessRegionOfflineA8(hay);
  return {
    category,
    categoryHint: null,
    region,
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
    region: row.region || ai.region || NOT_DISCLOSED,
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
    region: row.region || ai.region || existing.region,
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

/**
 * 正常に処理できた行（sheetRowIndexes）について、読み込み元Excel自体のA列（反映）を
 * TRUE（既存のTRUE行と同じExcelブール型セル）に書き換えて上書き保存する。
 * 対象外の行・他の列は一切変更しない。sheetRowIndexes が空の場合は何もしない
 * （dry-run時や、1件も正常処理できなかった場合にファイルへ触れないため）。
 */
function markRowsReflected(filePath, sheetRowIndexes) {
  if (!sheetRowIndexes || sheetRowIndexes.length === 0) return;
  // cellStyles:true を読み書き両方に付けないと列幅(!cols)等の書式情報が失われるため
  // （実データ・値自体はcellStyles無しでも完全に保持されることは確認済みだが、念のため
  // 書式もできる限り保持する）。
  const wb = XLSX.readFile(filePath, { cellStyles: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  for (const sheetRowIndex of sheetRowIndexes) {
    const addr = XLSX.utils.encode_cell({ r: sheetRowIndex + 1, c: 0 }); // +1: ヘッダー行(r=0)の分
    sheet[addr] = { t: 'b', v: true, w: 'TRUE' };
  }
  XLSX.writeFile(wb, filePath, { cellStyles: true });
}

async function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));

  const filePath = resolveA8FilePath();
  if (!fs.existsSync(filePath)) {
    console.error(
      `A8取り込み対象のExcelファイルが見つかりません: ${filePath}\n` +
        `data/a8-import/ に "${A8_FILE_NAME}" という名前でExcelファイルを配置してください。`
    );
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
  const reflectedSheetRowIndexes = [];

  for (const row of unique) {
    try {
      const existing = byName.get(row.name);
      // Excelには公式サイトの実ページ本文が無いため、特徴・特化領域・対応エリアの
      // 原文をpageTextとして渡す（buildDiscoveredAgentFieldsは「実際に取得した
      // ページ本文からの抽出・要約」を前提に設計されているため、ここではExcelの
      // 申告内容がその代わりとなる）。対応エリア・特化領域が空欄の行では、この
      // pageTextから対応エリア（ai.region）・カテゴリーをAIに推測させる。
      const pageTextLines = [row.feature];
      if (row.specialty) pageTextLines.push(`特化領域: ${row.specialty}`);
      if (row.region) pageTextLines.push(`対応エリア: ${row.region}`);
      const pageText = pageTextLines.join('\n\n');
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
        console.log(`[update] ${row.name} (id=${existing.id}) category=${merged.category} region=${merged.region}`);
      } else {
        const id = `a8-${String(nextIdNum++).padStart(3, '0')}`;
        const entry = buildNewEntry({ id, row, ai, sourceNote });
        finalEntriesById.set(id, entry);
        added += 1;
        console.log(`[add]    ${row.name} (id=${id}) category=${entry.category}${entry.categoryHint ? ` (hint: ${entry.categoryHint})` : ''} region=${entry.region}`);
      }

      reflectedSheetRowIndexes.push(row.sheetRowIndex);
    } catch (err) {
      console.warn(`[skip]   ${row.name}: 処理中にエラーが発生したため、Excelの反映チェック(A列)は更新しません: ${err.message}`);
    }
  }

  console.log(`\nDone. updated=${updated} added=${added} ai=${aiCalls} offline=${offlineBuilds}`);

  if (dryRun) {
    console.log('[dry-run] agents.json / Excelファイルは変更しませんでした。');
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

  markRowsReflected(filePath, reflectedSheetRowIndexes);
  if (reflectedSheetRowIndexes.length > 0) {
    console.log(`Marked ${reflectedSheetRowIndexes.length} row(s) as reflected (A列=TRUE) in ${path.basename(filePath)}.`);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  A8_FILE_NAME,
  resolveA8FilePath,
  readRows,
  dedupeByName,
  extractAffiliateUrl,
  nextA8IdCounter,
  guessCategoryOfflineA8,
  guessRegionOfflineA8,
  buildOfflineA8Fields,
  buildNewEntry,
  mergeIntoExisting,
  buildA8SourceNote,
  markRowsReflected,
};
