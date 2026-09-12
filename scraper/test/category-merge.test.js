'use strict';

/**
 * カテゴリーのまとめ方のガード。
 * 自動昇格で同じ意味のカテゴリーが増えた（転職エージェント図鑑では46種類）ことが二度と起きないよう、
 * まとめ先の判定・categories.json の中身・呼び出し元を固定する。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { mergeCategory, buildCategories, mergeCategories } = require('../lib/category-merge');
const { CATEGORIES } = require('../lib/schema');

const SCRAPER = path.join(__dirname, '..');
const ROOT = path.join(SCRAPER, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('同じ意味の言い換えは「フリーランス案件マッチング」にまとめる', () => {
  for (const name of ['フリーランス案件マッチングサービス', '案件マッチングサービス', 'フリーランスマッチングプラットフォーム']) {
    assert.strictEqual(mergeCategory(name), 'フリーランス案件マッチング', name);
  }
});

test('正式なカテゴリー名は付け替えない', () => {
  for (const name of CATEGORIES) assert.strictEqual(mergeCategory(name), name);
});

test('どのルールにも当たらない名前は「その他」にする', () => {
  assert.strictEqual(mergeCategory('よく分からない分類'), 'その他');
  assert.strictEqual(mergeCategory(''), 'その他');
  assert.strictEqual(mergeCategory(null), 'その他');
});

test('categories.json は正式な9分類で作り直され、自動採番のslugを作らない', () => {
  const built = buildCategories([{ name: 'フリーランス案件マッチングサービス', slug: 'category-1', from: '#000', to: '#000', icon: 'x' }]);
  assert.deepStrictEqual(built.map(c => c.name), CATEGORIES);
  assert.ok(built.every(c => c.slug && !/^category-\d+$/.test(c.slug) && c.from && c.to && c.icon));
});

test('mergeCategories はその場で書き換え、変化があったかを返す', () => {
  const agents = [{ category: 'フリーランス案件マッチングサービス' }, { category: 'IT・Web開発' }];
  const categories = [];
  const result = mergeCategories(agents, categories);
  assert.strictEqual(result.reclassifiedCount, 1);
  assert.strictEqual(result.changed, true);
  assert.strictEqual(agents[0].category, 'フリーランス案件マッチング');
  assert.strictEqual(categories.length, CATEGORIES.length);
  // 2回目は何も変わらない。
  assert.strictEqual(mergeCategories(agents, categories).changed, false);
});

test('実データの全サービスが正式なカテゴリーに入っている', () => {
  const agents = JSON.parse(read('agents.json'));
  const stray = [...new Set(agents.map(a => a.category))].filter(c => !CATEGORIES.includes(c));
  assert.deepStrictEqual(stray, [], `正式でないカテゴリー: ${stray.join('、')}`);
});

test('実データの categories.json が正式な9分類と一致している', () => {
  const categories = JSON.parse(read('categories.json'));
  assert.deepStrictEqual(categories.map(c => c.name), CATEGORIES);
  assert.ok(categories.every(c => !/^category-\d+$/.test(c.slug)), '自動採番のslugが残っている');
});

test('カテゴリーを自動で増やす仕組みは残っていない', () => {
  assert.ok(!fs.existsSync(path.join(SCRAPER, 'promote-categories.js')), 'promote-categories.js が残っている');
  for (const file of ['discover-agents.js', 'import-a8.js']) {
    const src = fs.readFileSync(path.join(SCRAPER, file), 'utf8');
    assert.ok(!src.includes('promoteCategories'), `${file} が自動昇格を呼んでいる`);
    assert.ok(src.includes('mergeCategories('), `${file} がまとめ直しを呼んでいない`);
  }
});

test('トップの「職種から探す」は掲載0件のカテゴリーを出さない', () => {
  const html = read('index.html');
  assert.match(html, /\.filter\(x => x\.n > 0\)/, '掲載0件のカテゴリーを除いていない');
});

test('カテゴリーページの生成で、消えたカテゴリーのページを掃除する', () => {
  const src = fs.readFileSync(path.join(SCRAPER, 'generate-category-pages.js'), 'utf8');
  assert.match(src, /removed stale page/, '古いカテゴリーページを掃除する処理が無い');
});
