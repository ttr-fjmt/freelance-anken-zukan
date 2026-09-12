'use strict';

/**
 * カテゴリー名を、サイトで使う分類（lib/schema.js の CATEGORIES）にまとめ直す。
 *
 * 【なぜ必要になったか】
 * 以前は「その他」に付いた補足メモ（categoryHint）が一定数たまると、正式カテゴリーへ自動昇格させていた
 * （promote-categories.js）。その結果「フリーランス案件マッチング」と同じ意味の
 * 「フリーランス案件マッチングサービス」が自動採番のslug（category-1）で作られ、同じ分類が2つに割れた。
 * 姉妹サイトの転職エージェント図鑑では、同じ仕組みで言い換えのカテゴリーが46種類まで増えている。
 *
 * また categories.json が正式な9分類と揃っておらず、「営業・マーケティング」「ライティング・編集」の
 * サービスにはカテゴリーページが作られていなかった。
 *
 * 【考え方】
 * 増やす方向をやめ、名前の文字列だけで機械的にまとめる。AIに判定し直させない。
 * categories.json は常に CATEGORIES と同じ9件に作り直す（掲載0件のカテゴリーはページも入口も出さない）。
 */

const { CATEGORIES } = require('./schema');

const FALLBACK_CATEGORY = 'その他';

/** まとめ先の判定。上から順に見て、最初に当たったものを採用する。 */
const MERGE_RULES = [
  { to: 'フリーランス案件マッチング', pattern: /案件マッチング|マッチングサービス|マッチングプラットフォーム/ },
];

/**
 * カテゴリーの見た目。categories.json に正式なslugで既にあるものは、そちらを優先して引き継ぐ。
 * 色・アイコンは index.html の DEFAULT_CATEGORIES と同じもの。
 */
const APPEARANCE = {
  'IT・Web開発': {
    slug: 'it-web', from: '#1F6F63', to: '#123F38',
    icon: '<rect x="14" y="14" width="36" height="24" rx="2" stroke="#fff" stroke-width="2.5"/><line x1="24" y1="46" x2="40" y2="46" stroke="#fff" stroke-width="2.5"/><line x1="32" y1="38" x2="32" y2="46" stroke="#fff" stroke-width="2.5"/><path d="M22 22 L18 26 L22 30" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M42 22 L46 26 L42 30" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  'デザイン': {
    slug: 'design', from: '#A3446E', to: '#6B2B47',
    icon: '<path d="M32 14 C20 14 12 23 12 33 c0 7 5 11 10 11 c2 0 4-1 4-3 c0-2-2-3-2-6 c0-3 2-5 5-5 h9 c6 0 13-5 13-15 C51 20 43 14 32 14 Z" stroke="#fff" stroke-width="2.2" fill="none" stroke-linejoin="round"/><circle cx="21" cy="27" r="2.4" fill="#fff"/><circle cx="30" cy="21" r="2.4" fill="#fff"/><circle cx="41" cy="24" r="2.4" fill="#fff"/><circle cx="43" cy="33" r="2.4" fill="#fff"/>',
  },
  'ライティング・編集': {
    slug: 'writing-editing', from: '#B5651D', to: '#7A4310',
    icon: '<path d="M20 44 L38 26 L44 32 L26 50 L16 52 Z" stroke="#fff" stroke-width="2.2" fill="none" stroke-linejoin="round"/><line x1="35" y1="29" x2="41" y2="35" stroke="#fff" stroke-width="2"/><path d="M42 14 L50 22" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>',
  },
  '動画・クリエイティブ': {
    slug: 'video-creative', from: '#3D7A8C', to: '#264E58',
    icon: '<rect x="14" y="22" width="36" height="26" rx="3" stroke="#fff" stroke-width="2.3" fill="none"/><path d="M14 22 L22 14 h8 l-6 8 Z" stroke="#fff" stroke-width="2" fill="none" stroke-linejoin="round"/><path d="M30 22 L38 14 h8 l-6 8 Z" stroke="#fff" stroke-width="2" fill="none" stroke-linejoin="round"/><path d="M28 30 L28 40 L38 35 Z" fill="#fff"/>',
  },
  'コンサル・士業': {
    slug: 'consulting', from: '#2B3A55', to: '#171E2C',
    icon: '<rect x="14" y="24" width="36" height="24" rx="3" stroke="#fff" stroke-width="2.5"/><path d="M24 24 V18 a3 3 0 0 1 3-3 h10 a3 3 0 0 1 3 3 v6" stroke="#fff" stroke-width="2.5" fill="none"/><line x1="14" y1="34" x2="50" y2="34" stroke="#fff" stroke-width="2"/>',
  },
  '事務・バックオフィス': {
    slug: 'backoffice', from: '#4A6670', to: '#2E4148',
    icon: '<rect x="18" y="16" width="28" height="36" rx="2" stroke="#fff" stroke-width="2.3" fill="none"/><rect x="26" y="12" width="12" height="8" rx="2" fill="#fff"/><line x1="24" y1="28" x2="40" y2="28" stroke="#fff" stroke-width="2"/><line x1="24" y1="35" x2="40" y2="35" stroke="#fff" stroke-width="2"/><line x1="24" y1="42" x2="34" y2="42" stroke="#fff" stroke-width="2"/>',
  },
  '営業・マーケティング': {
    slug: 'sales-marketing', from: '#B23A4E', to: '#742534',
    icon: '<line x1="16" y1="48" x2="48" y2="48" stroke="#fff" stroke-width="2"/><rect x="20" y="36" width="6" height="12" fill="#fff" opacity=".9"/><rect x="30" y="28" width="6" height="20" fill="#fff" opacity=".9"/><rect x="40" y="20" width="6" height="28" fill="#fff" opacity=".9"/><path d="M18 26 L28 18 L34 22 L46 12" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round"/>',
  },
  'フリーランス案件マッチング': {
    slug: 'freelance-matching', from: '#7A5C8E', to: '#4E3A5C',
    icon: '<path d="M28 14 h14 l14 14 v14 l-14 14 h-14 l-14-14 v-14 Z" stroke="#fff" stroke-width="2.2" fill="none" stroke-linejoin="round"/><circle cx="34" cy="26" r="3" fill="#fff"/>',
  },
  'その他': {
    slug: 'other', from: '#5C6570', to: '#38414A',
    icon: '<path d="M14 22 h12 l4 6 h20 v22 a2 2 0 0 1-2 2 h-32 a2 2 0 0 1-2-2 v-26 a2 2 0 0 1 2-2 Z" stroke="#fff" stroke-width="2.2" fill="none" stroke-linejoin="round"/>',
  },
};

/** カテゴリー名をまとめ先に変換する。正式な名前はそのまま返す。 */
function mergeCategory(name) {
  const value = String(name || '').trim();
  if (!value) return FALLBACK_CATEGORY;
  if (CATEGORIES.includes(value)) return value;
  const hit = MERGE_RULES.find(rule => rule.pattern.test(value));
  return hit ? hit.to : FALLBACK_CATEGORY;
}

/** 正式な9カテゴリーぶんの categories.json を作る。既存の正式slugの見た目は引き継ぐ。 */
function buildCategories(existing) {
  const byName = new Map((existing || []).map(c => [c.name, c]));
  return CATEGORIES.map(name => {
    const prev = byName.get(name);
    if (prev && prev.slug && !/^category-\d+$/.test(prev.slug) && prev.from && prev.to && prev.icon) {
      return { name, from: prev.from, to: prev.to, icon: prev.icon, slug: prev.slug };
    }
    const look = APPEARANCE[name];
    if (!look) throw new Error(`カテゴリー「${name}」の見た目（色・アイコン・slug）が未定義です`);
    return { name, from: look.from, to: look.to, icon: look.icon, slug: look.slug };
  });
}

/**
 * agents と categories をその場で書き換えて、まとめ直す（promoteCategories と同じ呼び出し方）。
 * @returns {{ reclassifiedCount: number, changed: boolean }} changed が true のときだけ保存すればよい
 */
function mergeCategories(agents, categories) {
  let reclassifiedCount = 0;
  for (const agent of agents || []) {
    const to = mergeCategory(agent.category);
    if (to !== agent.category) {
      agent.category = to;
      reclassifiedCount += 1;
    }
  }
  const before = JSON.stringify(categories);
  const next = buildCategories(categories);
  categories.splice(0, categories.length, ...next);
  const categoriesChanged = before !== JSON.stringify(categories);
  return { reclassifiedCount, changed: reclassifiedCount > 0 || categoriesChanged };
}

module.exports = { MERGE_RULES, APPEARANCE, mergeCategory, buildCategories, mergeCategories };
