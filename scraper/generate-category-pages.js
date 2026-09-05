'use strict';

/**
 * categories.json の各カテゴリーについて、静的なランディングページ
 * category/{slug}/index.html を生成する（SEO/AEO対策の一環）。
 *
 * - 各カテゴリーの色・アイコン（categories.json）と、index.html の共通CSS（<style>ブロック）を
 *   そのまま流用し、見た目をトップページと揃える。
 * - カード表示はホーム画面の buildHomeCardHTML（index.html）相当（アイコン・カテゴリーピル・
 *   社名・特徴抜粋のみ、stats-gridは持たない）を、このスクリプト内で自己完結的に再実装する
 *   （ブラウザJSではなくNode側で静的HTMLとして書き出すため）。
 * - 1ページ最大200件（completenessScore降順）。超過分は「もっと見る」で
 *   トップページの該当カテゴリー絞り込み（/?category=...）へ誘導する。
 * - 該当エージェントが0件のカテゴリーはページを生成しない（薄いページを作らないため）。
 *
 * GitHub Actionsパイプラインでは prerender.js の後・generate-sitemap.js の前に実行する想定。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AGENTS_PATH = path.join(ROOT, 'agents.json');
const CATEGORIES_PATH = path.join(ROOT, 'categories.json');
const INDEX_HTML_PATH = path.join(ROOT, 'index.html');
const CATEGORY_DIR = path.join(ROOT, 'category');

const BASE_URL = 'https://agent-zukan.net';
const MAX_AGENTS_PER_PAGE = 200;

// 初期投入済み9カテゴリーの手動スラッグ対応表（ローマ字変換ではなく分かりやすい英語表記）。
const ORIGINAL_SLUG_MAP = {
  'IT・Web': 'it-web',
  '管理部門・コンサル': 'management-consulting',
  '施工管理・建設': 'construction',
  '営業・マーケティング': 'sales-marketing',
  '外資・グローバル': 'global',
  'スタートアップ・ベンチャー': 'startup',
  '地方転職・UIターン': 'regional',
  '第二新卒・ポテンシャル層': 'second-newgrad',
  'その他': 'other',
};

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/**
 * categories.json の各エントリに slug フィールドがまだ無ければ割り当てる（初回のみ生成し、
 * 以降は categories.json に保存された値をそのまま再利用する）。
 * 初期9カテゴリーは手動対応表、それ以外（動的に昇格したカテゴリー）は日本語のみで
 * ローマ字変換の対象にできないため、連番フォールバック（category-1, category-2...）を使う。
 */
function ensureSlugs(categories) {
  let changed = false;
  const usedSlugs = new Set(categories.map(c => c.slug).filter(Boolean));
  let seq = 1;
  for (const c of categories) {
    if (c.slug) continue;
    let slug = ORIGINAL_SLUG_MAP[c.name];
    if (!slug || usedSlugs.has(slug)) {
      do {
        slug = `category-${seq}`;
        seq += 1;
      } while (usedSlugs.has(slug));
    }
    c.slug = slug;
    usedSlugs.add(slug);
    changed = true;
  }
  return changed;
}

function extractStyleBlock(indexHtml) {
  const match = indexHtml.match(/<style>[\s\S]*?<\/style>/);
  if (!match) throw new Error('Could not find <style> block in index.html');
  return match[0];
}

function isDisclosed(value) {
  if (!value) return false;
  return !String(value).startsWith('非公開');
}

/** index.html の completenessScore(agent, "candidate") と同じロジック（求職者モード固定）。 */
function completenessScore(agent) {
  let score = 0;
  if (isDisclosed(agent.targetAge)) score++;
  if (isDisclosed(agent.region)) score++;
  if (isDisclosed(agent.jobCount)) score++;
  if ((agent.reviews && agent.reviews.length > 0) || agent.reviewNote) score++;
  if (agent.features && agent.features.length > 0) score++;
  if (agent.appeal && agent.appeal.length > 0) score++;
  return score;
}

/** index.html の displaySortValue(agent, mode) と同じロジック（求職者モード固定）。featuredを最優先、同順位内はcompletenessScore降順。 */
function displaySortValue(agent) {
  return (agent.featured ? 1 : 0) * 1000 + completenessScore(agent);
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** index.html の eyecatchHTML(agent, "thumb") 相当。 */
function eyecatchHTML(agent, categoryStyle) {
  if (agent.featured) {
    return `<div class="eyecatch-square thumb featured">
        <div class="featured-star"><span class="featured-text">イチオシ!</span></div>
      </div>`;
  }
  const style = categoryStyle[agent.category] || Object.values(categoryStyle)[0];
  const favicon = agent.faviconUrl
    ? `<img class="favicon" src="${escapeHtml(agent.faviconUrl)}" alt="" onerror="this.remove()">`
    : '';
  return `<div class="eyecatch-square thumb" style="background:linear-gradient(135deg, ${style.from}, ${style.to});">
      <svg viewBox="0 0 64 64" fill="none">${style.icon}</svg>
      ${favicon}
    </div>`;
}

/** index.html の zukanScore(agent, "candidate") 相当。featuredは無条件5。 */
function zukanScore(agent) {
  if (agent.featured) return 5;
  const raw = completenessScore(agent);
  const ratio = raw / 6;
  return Math.max(1, Math.min(4, Math.round(1 + ratio * 4)));
}

/** index.html の zukanScoreBadge(agent, "candidate") 相当。 */
function zukanScoreBadge(agent) {
  const score = zukanScore(agent);
  const filled = '★'.repeat(score);
  const empty = '☆'.repeat(5 - score);
  return `<span class="rating-badge"><span class="star">${filled}</span><span class="star-empty">${empty}</span><span class="count">（図鑑スコア）</span></span>`;
}

/** index.html の ratingBadge(review, estimated, agent, "candidate") 相当。
 * 実際の口コミ（agent.reviews[0]）があればそちらを優先し、無ければ図鑑スコアにフォールバックする。 */
function ratingBadge(agent) {
  const review = agent.reviews && agent.reviews[0];
  if (!review) return zukanScoreBadge(agent);
  const tag = agent.real
    ? '<span class="count">（推定）</span>'
    : `<span class="count">（${review.count}件）</span>`;
  return `<span class="rating-badge"><span class="star">★</span>${review.rating.toFixed(1)}${tag}</span>`;
}

/** index.html の buildHomeCardHTML(agent, "candidate") 相当（求職者モード固定）。
 * featured/非featuredを問わず、イチオシバッジ/アイコンと社名の間に★評価バッジ
 * （ratingBadge/zukanScoreBadge）を表示する（buildHomeCardHTMLと同じ見た目・位置）。 */
function homeCardHTML(agent, categoryStyle) {
  const excerpt = agent.appeal || '';
  const ratingHTML = `<div class="home-card-rating">${ratingBadge(agent)}</div>`;
  return `<a class="home-card" href="/agent/${encodeURIComponent(agent.id)}/">
      ${eyecatchHTML(agent, categoryStyle)}
      ${ratingHTML}
      <span class="category-pill">${escapeHtml(agent.category)}</span>
      <h4>${escapeHtml(agent.name)}</h4>
      <p class="home-card-excerpt">${escapeHtml(excerpt)}</p>
      ${agent.featured ? '<span class="pr-label">PR</span>' : ''}
    </a>`;
}

function buildCollectionPageJsonLd({ categoryName, pageUrl, description, pageAgents }) {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: `${categoryName}に強い転職エージェント一覧`,
    description,
    url: pageUrl,
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: pageAgents.map((a, idx) => ({
        '@type': 'ListItem',
        position: idx + 1,
        item: {
          '@type': 'EmploymentAgency',
          name: a.name,
          url: `${BASE_URL}/agent/${encodeURIComponent(a.id)}/`,
        },
      })),
    },
  };
}

function buildPageHtml({ categoryName, slug, styleBlock, totalCount, pageAgents, categoryStyle }) {
  const pageUrl = `${BASE_URL}/category/${slug}/`;
  const title = `${categoryName}に強い転職エージェント一覧｜転職エージェント図鑑`;
  const description = `${categoryName}に強みを持つ転職エージェント・人材紹介会社を${totalCount}社掲載。対応エリアや特徴を比較して、あなたに合った1社を見つけられます。`;
  const jsonLd = buildCollectionPageJsonLd({
    categoryName,
    pageUrl,
    description,
    pageAgents,
  });
  const truncated = totalCount > MAX_AGENTS_PER_PAGE;
  const moreLinkHtml = truncated
    ? `<a class="home-more-link" href="/?category=${encodeURIComponent(categoryName)}">もっと見る（全${totalCount}社）→</a>`
    : '';

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${pageUrl}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${pageUrl}">
<meta property="og:image" content="${BASE_URL}/ogp-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Shippori+Mincho:wght@600&family=Zen+Kaku+Gothic+New:wght@400;500;700&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-WBGS0QRR5M"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-WBGS0QRR5M');
</script>
${styleBlock}
</head>
<body>
<header>
  <div class="inner">
    <h1 class="home-link" onclick="location.href='/'">転職エージェント<span class="mark">図鑑</span></h1>
    <p class="tagline">迷わず選べる、エージェントの図鑑。</p>
  </div>
</header>
<div class="wrap">
  <a class="back-btn" href="/" style="display:inline-flex;text-decoration:none;margin-top:24px;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>トップに戻る</a>

  <div class="home-section" style="margin-top:24px;">
    <div class="home-section-head">
      <h3><span>${escapeHtml(categoryName)}に強い転職エージェント（${totalCount}社）</span></h3>
    </div>
    <div class="home-section-grid">
      ${pageAgents.map(a => homeCardHTML(a, categoryStyle)).join('\n      ')}
    </div>
    ${moreLinkHtml}
  </div>
</div>
<footer>
  掲載情報は、厚生労働省委託「職業紹介優良事業者認定制度」（jesra.or.jp）および厚生労働省「人材サービス総合サイト」の公開データをもとに、自動クロールにより毎日更新しています。
  <div class="footer-links"><a href="/">トップページ</a> / <a href="/privacy.html">プライバシーポリシー</a> / <a href="/faq.html">よくある質問</a></div>
</footer>
</body>
</html>
`;
}

function main() {
  const agents = readJson(AGENTS_PATH, []);
  const categories = readJson(CATEGORIES_PATH, []);
  if (agents.length === 0 || categories.length === 0) {
    console.log('No agents/categories found — skipping category page generation.');
    return;
  }

  const slugsChanged = ensureSlugs(categories);
  if (slugsChanged) {
    writeJson(CATEGORIES_PATH, categories);
    console.log('Assigned slug(s) to categories.json and saved.');
  }

  const indexHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const styleBlock = extractStyleBlock(indexHtml);

  const categoryStyle = {};
  for (const c of categories) categoryStyle[c.name] = { from: c.from, to: c.to, icon: c.icon };

  fs.mkdirSync(CATEGORY_DIR, { recursive: true });

  let generated = 0;
  let skipped = 0;
  for (const c of categories) {
    const matched = agents
      .filter(a => a.category === c.name)
      .sort((a, b) => displaySortValue(b) - displaySortValue(a));

    if (matched.length === 0) {
      skipped += 1;
      continue;
    }

    const pageAgents = matched.slice(0, MAX_AGENTS_PER_PAGE);
    const html = buildPageHtml({
      categoryName: c.name,
      slug: c.slug,
      styleBlock,
      totalCount: matched.length,
      pageAgents,
      categoryStyle,
    });

    const outDir = path.join(CATEGORY_DIR, c.slug);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf8');
    generated += 1;
    console.log(`[category] ${c.name} (${c.slug}): ${matched.length} agent(s), ${pageAgents.length} shown on page.`);
  }

  console.log(`Generated ${generated} category page(s), skipped ${skipped} empty categor${skipped === 1 ? 'y' : 'ies'}.`);
}

if (require.main === module) {
  main();
}

module.exports = { ensureSlugs, completenessScore, displaySortValue, buildPageHtml, ORIGINAL_SLUG_MAP };
