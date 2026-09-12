'use strict';

/**
 * 検索対象（インデックス）の線引きのガード。
 *
 * 中身が確認できていないページ・終了したサービスのページを検索対象として送らないこと、
 * 逆に中身のあるページを誤って外さないことを固定する。
 * 静的ページ・カテゴリーページ・サイトマップの3か所で同じ線引きになっていることも確かめる。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  ROBOTS_NOINDEX,
  isIndexableAgent,
  isIndexableCategory,
  withRobotsNoindex,
} = require('../lib/indexing');
const { buildEntries } = require('../generate-sitemap');

const SCRAPER = path.join(__dirname, '..');
const ROOT = path.join(SCRAPER, '..');

test('特徴が確認できているページは、紹介文に関係なく検索対象にする', () => {
  assert.strictEqual(isIndexableAgent({ features: ['高単価案件'], appeal: '詳細情報が確認できませんでした。' }), true);
});

test('公式サイトの本文を確認できなかったページは検索対象にしない', () => {
  assert.strictEqual(isIndexableAgent({ features: [], appeal: '詳細情報が確認できませんでした。公式サイトでご確認ください。' }), false);
  assert.strictEqual(isIndexableAgent({ features: [], oneLiner: '公式サイトの本文が取得できないため詳細不明' }), false);
});

test('終了・閉鎖が告知されているサービスは検索対象にしない', () => {
  assert.strictEqual(isIndexableAgent({ features: [], appeal: '本サービスは2024年7月31日をもってサイト閉鎖となっているため、現在は利用できません。' }), false);
  assert.strictEqual(isIndexableAgent({ features: [], oneLiner: '2026年3月31日をもってサービス提供を終了した案件マッチングサービス' }), false);
});

test('「プロジェクト終了後」のような言い回しだけでは外さない', () => {
  assert.strictEqual(isIndexableAgent({ features: [], appeal: 'プロジェクト終了後も継続的に案件を紹介するサービスです。' }), true);
});

test('特徴の抽出が漏れただけで紹介文に中身があるページは、検索対象のまま', () => {
  assert.strictEqual(isIndexableAgent({ features: [], appeal: 'ファッション業界の幅広い職種に対応した専門的な案件マッチングが可能です。' }), true);
});

test('中身のあるサービスが1件も無いカテゴリーは検索対象にしない', () => {
  const agents = [
    { id: 'a', category: 'デザイン', features: [], appeal: '詳細情報が確認できませんでした。' },
    { id: 'b', category: 'IT・Web開発', features: ['リモート案件'] },
  ];
  assert.strictEqual(isIndexableCategory(agents, 'デザイン'), false);
  assert.strictEqual(isIndexableCategory(agents, 'IT・Web開発'), true);
});

test('noindex は文字コード指定の直後に1つだけ入る', () => {
  const html = '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>x</title></head><body></body></html>';
  const once = withRobotsNoindex(html);
  assert.ok(once.includes(`<meta charset="UTF-8">\n${ROBOTS_NOINDEX}`));
  assert.strictEqual(withRobotsNoindex(once), once);
});

test('サイトマップに、検索対象外のサービスとカテゴリーを載せない', () => {
  const agents = [
    { id: '1', category: 'IT・Web開発', features: ['高単価'] },
    { id: '2', category: 'IT・Web開発', features: [], appeal: '詳細情報が確認できませんでした。' },
    { id: '3', category: 'デザイン', features: [], appeal: '2023年12月1日をもってサービスを終了しております。' },
  ];
  const categories = [{ name: 'IT・Web開発', slug: 'it-web' }, { name: 'デザイン', slug: 'design' }];
  const locs = buildEntries(agents, categories).map(e => e.loc);
  assert.ok(locs.some(l => l.endsWith('/agent/1/')));
  assert.ok(!locs.some(l => l.endsWith('/agent/2/')), '中身の無いページが載っている');
  assert.ok(!locs.some(l => l.endsWith('/agent/3/')), '終了したサービスが載っている');
  assert.ok(locs.some(l => l.endsWith('/category/it-web/')));
  assert.ok(!locs.some(l => l.endsWith('/category/design/')));
});

test('実データで、特徴が確認できているページを誤って外していない', () => {
  const agents = JSON.parse(fs.readFileSync(path.join(ROOT, 'agents.json'), 'utf8'));
  const wrong = agents.filter(a => (a.features || []).length > 0 && !isIndexableAgent(a));
  assert.deepStrictEqual(wrong.map(a => a.id), []);
  // 外すのは一部に限られるはず。大半が外れていたら線引きが壊れている。
  const excluded = agents.filter(a => !isIndexableAgent(a)).length;
  assert.ok(excluded < agents.length * 0.3, `検索対象外が多すぎる（${excluded}/${agents.length}）`);
});

test('静的ページとカテゴリーページの生成で、同じ線引きを使っている', () => {
  const prerender = fs.readFileSync(path.join(SCRAPER, 'prerender.js'), 'utf8');
  assert.match(prerender, /isIndexableAgent\(agent\)/);
  assert.match(prerender, /withRobotsNoindex\(/);
  const category = fs.readFileSync(path.join(SCRAPER, 'generate-category-pages.js'), 'utf8');
  assert.match(category, /isIndexableCategory\(agents, c\.name\)/);
  assert.match(category, /ROBOTS_NOINDEX/);
});
