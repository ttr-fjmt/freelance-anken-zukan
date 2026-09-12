'use strict';

/**
 * agents.json のカテゴリーを正式な9分類にまとめ直し、categories.json を作り直す。
 * 日次の発見（discover-agents.js）と A8 取り込み（import-a8.js）でも同じ処理が走るので、
 * 普段は手で実行する必要はない。分類のルールを変えたときなどに使う。
 *
 * 実行: cd scraper && node merge-categories.js
 */

const fs = require('fs');
const path = require('path');
const { mergeCategories } = require('./lib/category-merge');

const ROOT = path.join(__dirname, '..');
const AGENTS_PATH = path.join(ROOT, 'agents.json');
const CATEGORIES_PATH = path.join(ROOT, 'categories.json');

function readJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function main() {
  const agents = readJson(AGENTS_PATH, []);
  const categories = readJson(CATEGORIES_PATH, []);
  const beforeNames = categories.map(c => c.name);
  const result = mergeCategories(agents, categories);
  if (!result.changed) {
    console.log('カテゴリーはすでに正式な分類と揃っています。');
    return;
  }
  writeJson(AGENTS_PATH, agents);
  writeJson(CATEGORIES_PATH, categories);
  console.log(`カテゴリーをまとめ直しました（${result.reclassifiedCount}件を付け替え）。`);
  console.log(`  前: ${beforeNames.join('、')}`);
  for (const c of categories) {
    console.log(`  ${c.name.padEnd(18)}${String(agents.filter(a => a.category === c.name).length).padStart(4)}件  (${c.slug})`);
  }
}

if (require.main === module) main();
