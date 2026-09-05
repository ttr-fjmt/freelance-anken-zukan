'use strict';

/**
 * フロントエンド（index.html/404.html）の DEFAULT_CATEGORIES・CHIP_LABELS /
 * CATEGORY_STYLE、および scraper/lib/agent-discovery.js の SEARCH_CATEGORIES
 * （このCATEGORIESから「その他」を除いたものを動的に導出）と一致させること。
 * フリーランス向け案件紹介サービスの分野分類（agent-zukan時代の転職エージェント
 * 向け9分類から刷新）。
 */
const CATEGORIES = [
  'IT・Web開発',
  'デザイン',
  'ライティング・編集',
  '動画・クリエイティブ',
  'コンサル・士業',
  '事務・バックオフィス',
  '営業・マーケティング',
  'フリーランス案件マッチング',
  'その他',
];

const NOT_DISCLOSED = '非公開（お問い合わせで確認）';

module.exports = { CATEGORIES, NOT_DISCLOSED };
