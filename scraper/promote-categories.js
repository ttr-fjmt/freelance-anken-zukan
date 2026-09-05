'use strict';

/**
 * agents.json 内で category が「その他」に分類されたエージェントを categoryHint ごとに集計し、
 * 一定数（PROMOTION_THRESHOLD）以上たまった categoryHint を正式なカテゴリーとして
 * categories.json に昇格させる。日次パイプラインの末尾（structure.js の後）で実行する想定。
 *
 * - 既に昇格済みのカテゴリー名（categories.json に存在する名前）と一致する categoryHint は、
 *   件数の多寡にかかわらず毎回無条件でそのカテゴリーへ再分類する
 *   （一度昇格したカテゴリー名は恒久的で、閾値を下回っても降格しない）。
 * - まだ存在しない categoryHint は、件数が PROMOTION_THRESHOLD 以上になった時点で
 *   初めて新規カテゴリーとして追加する（それ未満は「その他」のまま据え置く）。
 * - 新規カテゴリーの色は RESERVE_PALETTE から未使用のものを順に割り当てる。
 *   8色を使い切った場合は8番目を使い回し、警告をログ出力する。
 */

const fs = require('fs');
const path = require('path');

const { CATEGORIES } = require('./lib/schema');

const AGENTS_PATH = path.join(__dirname, '..', 'agents.json');
const CATEGORIES_PATH = path.join(__dirname, '..', 'categories.json');

const PROMOTION_THRESHOLD = 5;

// lib/schema.js の CATEGORIES（AIの分類対象となる9カテゴリー）と一致させる。
// これに含まれない categories.json のエントリは「昇格によって追加されたもの」とみなす。
// 以前はここに別途ハードコードしており、schema.js側の変更に追随できず陳腐化する
// 問題があったため、CATEGORIESを唯一のソースとして一本化した。
const ORIGINAL_CATEGORY_NAMES = new Set(CATEGORIES);

// 昇格カテゴリー用の予備カラーパレット（8色、指定の順で使用）。
const RESERVE_PALETTE = [
  { from: '#7A5C8E', to: '#4E3A5C' },
  { from: '#3D7A8C', to: '#264E58' },
  { from: '#8C6B3D', to: '#5C4626' },
  { from: '#5C7A3D', to: '#3A4E26' },
  { from: '#8C3D5C', to: '#5C264E' },
  { from: '#3D5C8C', to: '#26385C' },
  { from: '#8C5C3D', to: '#5C3A26' },
  { from: '#5C3D8C', to: '#3A265C' },
];

// 昇格カテゴリー共通の「タグ」アイコン（他カテゴリーのアイコンと視覚的に揃うよう調整済み）。
const RESERVE_ICON =
  '<path d="M28 14 h14 l14 14 v14 l-14 14 h-14 l-14-14 v-14 Z" stroke="#fff" stroke-width="2.2" fill="none" stroke-linejoin="round"/><circle cx="34" cy="26" r="3" fill="#fff"/>';

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/** promotedCount（既に昇格済みのカテゴリー数）から、次に使う予備色を返す。8色使い切ったら8番目を使い回す。 */
function nextReserveColor(promotedCount) {
  if (promotedCount < RESERVE_PALETTE.length) return RESERVE_PALETTE[promotedCount];
  console.warn(
    `Reserve color palette exhausted (${RESERVE_PALETTE.length} colors already used). ` +
      `Reusing color #${RESERVE_PALETTE.length} for the next promoted category.`
  );
  return RESERVE_PALETTE[RESERVE_PALETTE.length - 1];
}

/**
 * agents / categories を直接ミューテートしてカテゴリー昇格・再分類を行う。
 * 戻り値: { promotedNames: string[], reclassifiedCount: number }
 */
function promoteCategories(agents, categories) {
  const categoryNames = new Set(categories.map(c => c.name));

  const groups = new Map();
  for (const a of agents) {
    if (a.category === 'その他' && a.categoryHint) {
      if (!groups.has(a.categoryHint)) groups.set(a.categoryHint, []);
      groups.get(a.categoryHint).push(a);
    }
  }

  let promotedCount = categories.filter(c => !ORIGINAL_CATEGORY_NAMES.has(c.name)).length;
  const promotedNames = [];
  let reclassifiedCount = 0;

  for (const [hint, group] of groups) {
    const alreadyPromoted = categoryNames.has(hint);
    if (!alreadyPromoted && group.length < PROMOTION_THRESHOLD) continue; // 閾値未満・未昇格 → 据え置き

    if (!alreadyPromoted) {
      const color = nextReserveColor(promotedCount);
      categories.push({ name: hint, from: color.from, to: color.to, icon: RESERVE_ICON });
      categoryNames.add(hint);
      promotedCount += 1;
      promotedNames.push(hint);
      console.log(`Promoted new category "${hint}" (${group.length} agents currently classified as その他).`);
    }

    for (const a of group) {
      a.category = hint;
      a.categoryHint = null;
      reclassifiedCount += 1;
    }
  }

  return { promotedNames, reclassifiedCount };
}

function main() {
  const agents = readJson(AGENTS_PATH, []);
  const categories = readJson(CATEGORIES_PATH, []);

  if (agents.length === 0) {
    console.log(`No agents found at ${AGENTS_PATH} — skipping category promotion.`);
    return;
  }
  if (categories.length === 0) {
    console.warn(`No categories found at ${CATEGORIES_PATH} — skipping category promotion.`);
    return;
  }

  const { promotedNames, reclassifiedCount } = promoteCategories(agents, categories);

  if (promotedNames.length > 0 || reclassifiedCount > 0) {
    writeJson(AGENTS_PATH, agents);
    writeJson(CATEGORIES_PATH, categories);
  }

  console.log(
    `Category promotion finished: promoted=${promotedNames.length}` +
      `${promotedNames.length ? ' (' + promotedNames.join('、') + ')' : ''}, ` +
      `reclassifiedAgents=${reclassifiedCount}`
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  promoteCategories,
  nextReserveColor,
  RESERVE_PALETTE,
  RESERVE_ICON,
  PROMOTION_THRESHOLD,
  ORIGINAL_CATEGORY_NAMES,
};
