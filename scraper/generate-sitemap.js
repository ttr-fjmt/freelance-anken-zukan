'use strict';

/**
 * agents.json から求職者向け個別ページ（実パス /agent/{id}/、企業モードは対象外）のURLを
 * 生成し、固定ページ（トップ・プライバシーポリシー）と合わせて sitemap.xml を出力する。
 * 1ファイルあたり上限50,000URL（sitemaps.org仕様）を超える場合は、
 * sitemap-1.xml, sitemap-2.xml ... に分割し、sitemap.xml をそれらを束ねる
 * sitemapindex として出力する（現在の件数では発生しない想定だが、念のため対応）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AGENTS_PATH = path.join(ROOT, 'agents.json');
const CATEGORIES_PATH = path.join(ROOT, 'categories.json');
const SITEMAP_PATH = path.join(ROOT, 'sitemap.xml');

const BASE_URL = 'https://agent-zukan.net';
const MAX_URLS_PER_SITEMAP = 50000;

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function xmlEscape(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function urlEntry({ loc, changefreq, priority }) {
  return (
    '  <url>\n' +
    `    <loc>${xmlEscape(loc)}</loc>\n` +
    `    <changefreq>${changefreq}</changefreq>\n` +
    `    <priority>${priority}</priority>\n` +
    '  </url>'
  );
}

function urlsetXml(entries) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    entries.map(urlEntry).join('\n') +
    '\n</urlset>\n'
  );
}

function sitemapIndexXml(sitemapFilenames) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    sitemapFilenames
      .map(name => `  <sitemap>\n    <loc>${BASE_URL}/${name}</loc>\n  </sitemap>`)
      .join('\n') +
    '\n</sitemapindex>\n'
  );
}

function buildEntries(agents, categories = []) {
  const entries = [
    { loc: `${BASE_URL}/`, changefreq: 'daily', priority: '1.0' },
    { loc: `${BASE_URL}/privacy.html`, changefreq: 'yearly', priority: '0.3' },
  ];
  // faq.html は存在する場合のみ含める（PART 3で新規作成。ローカル動作確認等でまだ無い環境でも
  // sitemap生成自体は落ちないようにする）。
  if (fs.existsSync(path.join(ROOT, 'faq.html'))) {
    entries.push({ loc: `${BASE_URL}/faq.html`, changefreq: 'monthly', priority: '0.4' });
  }
  for (const a of agents) {
    if (!a.id) continue;
    entries.push({
      loc: `${BASE_URL}/agent/${encodeURIComponent(a.id)}/`,
      changefreq: 'weekly',
      priority: '0.6',
    });
  }
  // 該当エージェントが1件も無いカテゴリーは generate-category-pages.js がページ自体を
  // 生成しない（薄いページを作らないため）ので、ここでも同じ条件でスキップする。
  for (const c of categories) {
    if (!c.slug) continue;
    const hasAgents = agents.some(a => a.category === c.name);
    if (!hasAgents) continue;
    entries.push({
      loc: `${BASE_URL}/category/${c.slug}/`,
      changefreq: 'daily',
      priority: '0.5',
    });
  }
  return entries;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function main() {
  const agents = readJson(AGENTS_PATH, []);
  const categories = readJson(CATEGORIES_PATH, []);
  const entries = buildEntries(agents, categories);

  if (entries.length <= MAX_URLS_PER_SITEMAP) {
    fs.writeFileSync(SITEMAP_PATH, urlsetXml(entries), 'utf8');
    console.log(`Wrote ${SITEMAP_PATH} with ${entries.length} URLs (agents=${agents.length}).`);
    return;
  }

  // 上限超過時は分割し、sitemap.xml はそれらを束ねる sitemapindex にする。
  const parts = chunk(entries, MAX_URLS_PER_SITEMAP);
  const filenames = parts.map((_, i) => `sitemap-${i + 1}.xml`);
  parts.forEach((part, i) => {
    fs.writeFileSync(path.join(ROOT, filenames[i]), urlsetXml(part), 'utf8');
  });
  fs.writeFileSync(SITEMAP_PATH, sitemapIndexXml(filenames), 'utf8');
  console.log(
    `URL count (${entries.length}) exceeded ${MAX_URLS_PER_SITEMAP} — ` +
      `split into ${filenames.length} sitemap files, sitemap.xml is now a sitemap index.`
  );
}

if (require.main === module) {
  main();
}

module.exports = { buildEntries };
