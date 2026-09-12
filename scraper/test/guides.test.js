'use strict';

/**
 * 解説記事（/guide/）のガード。
 * 「公式情報で確認できたことだけを書く」約束を機械的に確かめる。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { GUIDES, SOURCES } = require('../generate-guide-pages');
const { buildEntries } = require('../generate-sitemap');

const ROOT = path.join(__dirname, '..', '..');
const BASE = 'https://freelance-anken-zukan.net';
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('記事が3本以上あり、すべて書き出されている', () => {
  assert.ok(GUIDES.length >= 3);
  assert.ok(fs.existsSync(path.join(ROOT, 'guide', 'index.html')), 'guide/index.html が無い（node generate-guide-pages.js を実行）');
  for (const g of GUIDES) {
    assert.ok(fs.existsSync(path.join(ROOT, 'guide', g.slug, 'index.html')), `guide/${g.slug}/ が無い`);
  }
});

test('記事ページは検索対象で、AdSense・アクセス解析・正しい canonical を持つ', () => {
  const pages = [['guide/index.html', `${BASE}/guide/`]]
    .concat(GUIDES.map(g => [`guide/${g.slug}/index.html`, `${BASE}/guide/${g.slug}/`]));
  for (const [rel, url] of pages) {
    const html = read(rel);
    assert.ok(html.includes('adsbygoogle.js?client=ca-pub-'), `${rel} に AdSense のタグが無い`);
    assert.ok(html.includes(`<link rel="canonical" href="${url}">`), `${rel} の canonical が違う`);
    assert.ok(!/name=["']robots["']/.test(html), `${rel} が検索対象外になっている`);
    assert.ok(html.includes("gtag('config', 'G-YS6S43LSBK')"), `${rel} にアクセス解析のタグが無い`);
    assert.strictEqual((html.match(/<h1[\s>]/g) || []).length, 1, `${rel} の h1 が1つではない`);
  }
});

test('すべての記事に、公式情報の出典が付いている', () => {
  for (const g of GUIDES) {
    assert.ok(g.sources.length > 0, `${g.slug} に出典が無い`);
    for (const key of g.sources) {
      assert.ok(SOURCES[key], `${g.slug} の出典 ${key} が未定義`);
      assert.match(SOURCES[key].url, /^https:\/\/([a-z0-9-]+\.)*(mhlw\.go\.jp|jftc\.go\.jp)\//, `${key} が公式のページではない`);
    }
    assert.ok(read(`guide/${g.slug}/index.html`).includes('出典・参考にした公式情報'), `${g.slug} に出典欄が出ていない`);
  }
});

test('記事に割合（％）や金額を書いていない（料率・相場は公式情報で確認できていないため）', () => {
  for (const g of GUIDES) {
    const text = g.body.replace(/<[^>]+>/g, '');
    assert.ok(!/\d+(\.\d+)?\s*[%％]/.test(text), `${g.slug} に割合の数字がある`);
    assert.ok(!/\d[\d,]*\s*(円|万円)/.test(text), `${g.slug} に金額がある`);
  }
});

test('記事の日付・期間は、確認済みのものだけ', () => {
  // 公式情報で確認した数字だけを許す。新しい数字を書くときは出典を確認してからここに足す。
  const allowed = new Set(['令和6年11月1日', '60日', '30日', '6か月']);
  for (const g of GUIDES) {
    const text = g.body.replace(/<[^>]+>/g, '');
    const found = text.match(/令和\d+年\d+月\d+日|\d+\s*(日|か月|ヶ月|年)(?![本])/g) || [];
    for (const v of found) {
      assert.ok(allowed.has(v.replace(/\s/g, '')), `${g.slug} に未確認の数字「${v}」がある`);
    }
  }
});

test('記事どうし・固定ページからのリンクがつながっている', () => {
  for (const g of GUIDES) {
    const html = read(`guide/${g.slug}/index.html`);
    for (const other of GUIDES.filter(o => o.slug !== g.slug)) {
      assert.ok(html.includes(`/guide/${other.slug}/`), `${g.slug} から ${other.slug} へのリンクが無い`);
    }
  }
  for (const rel of ['index.html', 'faq.html', 'privacy.html']) {
    assert.ok(read(rel).includes('href="/guide/"'), `${rel} からガイドへのリンクが無い`);
  }
});

test('サイトマップに記事が載っている', () => {
  const agents = JSON.parse(read('agents.json'));
  const categories = JSON.parse(read('categories.json'));
  const locs = buildEntries(agents, categories).map(e => e.loc);
  assert.ok(locs.includes(`${BASE}/guide/`));
  for (const g of GUIDES) assert.ok(locs.includes(`${BASE}/guide/${g.slug}/`), `${g.slug} がサイトマップに無い`);
});

test('AdSense のタグが、主要な固定ページすべてにある', () => {
  for (const rel of ['index.html', 'faq.html', 'privacy.html']) {
    assert.ok(read(rel).includes('adsbygoogle.js?client=ca-pub-'), `${rel} に AdSense のタグが無い`);
  }
});
