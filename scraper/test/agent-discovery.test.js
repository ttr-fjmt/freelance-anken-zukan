'use strict';

/**
 * discoverCandidates() の対象カテゴリーの絞り込み（収穫逓減スロットル用）の検証。
 *
 * クールダウンで見送ると決めたカテゴリーが、本当に web_search を呼ばずに済んでいるか
 * ——ここが効いていないと、費用は下がらないのに「見送りました」というログだけが出る、
 * という一番たちの悪い壊れ方をする。
 */

const test = require('node:test');
const assert = require('node:assert');

const discovery = require('../lib/agent-discovery');

/** module.exports 経由の呼び出しを差し替える（このリポジトリの既存のモック方式に合わせる）。 */
async function withStubs(stubs, fn) {
  const original = {};
  for (const [key, value] of Object.entries(stubs)) {
    original[key] = discovery[key];
    discovery[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(original)) discovery[key] = value;
  }
}

test('categories を渡すと、そのカテゴリーだけ検索する', async () => {
  const searched = [];
  await withStubs(
    {
      searchCategoryCandidates: async category => {
        searched.push(category);
        return [];
      },
      discoverFromComparisonArticles: async () => [],
    },
    async () => {
      await discovery.discoverCandidates([], 10, {
        categories: ['デザイン', 'ライティング・編集'],
        includeComparisonArticles: false,
      });
    }
  );

  assert.deepStrictEqual(searched, ['デザイン', 'ライティング・編集']);
});

test('includeComparisonArticles: false なら比較記事の検索を呼ばない', async () => {
  let comparisonCalls = 0;
  await withStubs(
    {
      searchCategoryCandidates: async () => [],
      discoverFromComparisonArticles: async () => {
        comparisonCalls += 1;
        return [];
      },
    },
    async () => {
      await discovery.discoverCandidates([], 10, { categories: [], includeComparisonArticles: false });
    }
  );

  assert.strictEqual(comparisonCalls, 0);
});

test('既定では全カテゴリー＋比較記事を対象にする（従来どおりの挙動）', async () => {
  const searched = [];
  let comparisonCalls = 0;
  await withStubs(
    {
      searchCategoryCandidates: async category => {
        searched.push(category);
        return [];
      },
      discoverFromComparisonArticles: async () => {
        comparisonCalls += 1;
        return [];
      },
    },
    async () => {
      await discovery.discoverCandidates([], 10);
    }
  );

  assert.deepStrictEqual(searched, [...discovery.SEARCH_CATEGORIES]);
  assert.strictEqual(comparisonCalls, 1);
});

test('検索呼び出しが失敗した回には error: true が立つ（クールダウン判定から除外するため）', async () => {
  const { perCategory } = await withStubs(
    {
      searchCategoryCandidates: async () => {
        throw new Error('rate limited');
      },
      discoverFromComparisonArticles: async () => [],
    },
    async () =>
      discovery.discoverCandidates([], 10, { categories: ['デザイン'], includeComparisonArticles: false })
  );

  assert.deepStrictEqual(perCategory, [
    { category: 'デザイン', found: 0, listed: 0, skipped: 0, error: true },
  ]);
});
