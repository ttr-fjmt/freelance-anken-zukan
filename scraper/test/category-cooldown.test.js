'use strict';

/**
 * 収穫逓減スロットル（data/discovery-runs.json）の検証。
 *
 * この仕組みは「費用を下げるために実行を減らす」ものなので、減らしすぎる方向の事故が
 * 一番怖い。特に次の3点を固定する:
 *   - 伸びているカテゴリーの頻度は絶対に下げない
 *   - どれだけ0件が続いても、恒久的に止めない（7日ごとに必ず再挑戦する）
 *   - APIの一時的な失敗を「もう出てこない」と誤解しない
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ZERO_STREAK_THRESHOLD,
  COOLDOWN_DAYS,
  MAX_ROWS_PER_CATEGORY,
  appendRuns,
  pruneHistory,
  categoryStatus,
  selectCategories,
  describeDeferred,
  recordRuns,
  readHistory,
  addDays,
} = require('../lib/category-cooldown');

/** listed 件数の並びから履歴を組み立てる。日付は1日ずつ遡って振る。 */
function historyFor(category, listedCounts, { lastDate = '2026-09-09', extra = {} } = {}) {
  return listedCounts.map((listed, i) => ({
    date: addDays(lastDate, i - (listedCounts.length - 1)),
    category,
    found: listed,
    listed,
    skipped: 0,
    ...extra,
  }));
}

test('categoryStatus: 末尾から連続している0件の回数を数える', () => {
  const history = historyFor('IT・Web開発', [3, 2, 0, 0]);
  assert.deepStrictEqual(categoryStatus(history, 'IT・Web開発').zeroStreak, 2);

  // 途中に0があっても、後で1件でも出ていれば連続は切れている。
  assert.deepStrictEqual(categoryStatus(historyFor('IT・Web開発', [0, 0, 0, 1]), 'IT・Web開発').zeroStreak, 0);
});

test('新規が出ているカテゴリーは毎日実行する（頻度を下げない）', () => {
  const history = historyFor('IT・Web開発', [0, 0, 2]);
  const { run, deferred } = selectCategories(['IT・Web開発'], { history, date: '2026-09-09' });

  assert.deepStrictEqual(run, ['IT・Web開発']);
  assert.deepStrictEqual(deferred, []);
});

test(`${ZERO_STREAK_THRESHOLD}回続けて新規0件なら、その日は見送る`, () => {
  const history = historyFor('コンサル・士業', [1, 0, 0, 0], { lastDate: '2026-09-08' });
  const { run, deferred } = selectCategories(['コンサル・士業'], { history, date: '2026-09-09' });

  assert.deepStrictEqual(run, []);
  assert.strictEqual(deferred.length, 1);
  assert.strictEqual(deferred[0].category, 'コンサル・士業');
  assert.strictEqual(deferred[0].zeroStreak, ZERO_STREAK_THRESHOLD);
  assert.strictEqual(deferred[0].nextEligibleDate, addDays('2026-09-08', COOLDOWN_DAYS));
});

test(`クールダウン中でも${COOLDOWN_DAYS}日経てば必ず再挑戦する（恒久的に止めない）`, () => {
  // 0件が20回続いていても、最後の実行から7日経っていれば実行する。
  const history = historyFor('コンサル・士業', new Array(20).fill(0), { lastDate: '2026-09-02' });

  const sixDaysLater = selectCategories(['コンサル・士業'], { history, date: '2026-09-08' });
  assert.deepStrictEqual(sixDaysLater.run, [], '6日目はまだ見送る');

  const sevenDaysLater = selectCategories(['コンサル・士業'], { history, date: '2026-09-09' });
  assert.deepStrictEqual(sevenDaysLater.run, ['コンサル・士業'], '7日目には必ず再挑戦する');
});

test('1件でも掲載できたらクールダウンは即座に解除される', () => {
  const history = [
    ...historyFor('コンサル・士業', [0, 0, 0], { lastDate: '2026-09-08' }),
    { date: '2026-09-09', category: 'コンサル・士業', found: 1, listed: 1, skipped: 0 },
  ];

  const { run, deferred } = selectCategories(['コンサル・士業'], { history, date: '2026-09-10' });
  assert.deepStrictEqual(run, ['コンサル・士業']);
  assert.deepStrictEqual(deferred, []);
});

test('API失敗の回（error: true）は判定に使わない', () => {
  // 0件が2回 + 失敗が3回。失敗を0件として数えると閾値を超えてしまうが、超えてはいけない。
  const history = [
    ...historyFor('デザイン', [0, 0], { lastDate: '2026-09-05' }),
    ...historyFor('デザイン', [0, 0, 0], { lastDate: '2026-09-08', extra: { error: true } }),
  ];

  assert.strictEqual(categoryStatus(history, 'デザイン').zeroStreak, 2);
  assert.deepStrictEqual(selectCategories(['デザイン'], { history, date: '2026-09-09' }).run, ['デザイン']);
});

test('一度も実行していないカテゴリーは必ず実行する', () => {
  const { run } = selectCategories(['事務・バックオフィス'], { history: [], date: '2026-09-09' });
  assert.deepStrictEqual(run, ['事務・バックオフィス']);
});

test('渡されたカテゴリーの並び順を保つ（回転の意図を壊さない）', () => {
  const history = historyFor('コンサル・士業', [0, 0, 0], { lastDate: '2026-09-09' });
  const { run } = selectCategories(['ライティング・編集', 'コンサル・士業', 'IT・Web開発'], { history, date: '2026-09-09' });

  assert.deepStrictEqual(run, ['ライティング・編集', 'IT・Web開発']);
});

test('appendRuns: perCategory をそのまま履歴に足し、error だけ引き継ぐ', () => {
  const history = appendRuns(
    [
      { category: 'IT・Web開発', label: 'IT・Web開発', found: 4, listed: 2, skipped: 2 },
      { category: 'コンサル・士業', label: 'コンサル・士業', found: 0, listed: 0, skipped: 0, error: true },
    ],
    { date: '2026-09-09', history: [] }
  );

  assert.deepStrictEqual(history, [
    { date: '2026-09-09', category: 'IT・Web開発', found: 4, listed: 2, skipped: 2 },
    { date: '2026-09-09', category: 'コンサル・士業', found: 0, listed: 0, skipped: 0, error: true },
  ]);
});

test(`pruneHistory: 1カテゴリーにつき直近${MAX_ROWS_PER_CATEGORY}件だけ残す`, () => {
  const many = historyFor('IT・Web開発', new Array(MAX_ROWS_PER_CATEGORY + 5).fill(1));
  const pruned = pruneHistory(many);

  assert.strictEqual(pruned.length, MAX_ROWS_PER_CATEGORY);
  // 新しい方を残す（古い方から捨てる）。
  assert.strictEqual(pruned[pruned.length - 1].date, many[many.length - 1].date);
});

test('describeDeferred: 運営者が読んで分かる説明になっている', () => {
  const history = historyFor('コンサル・士業', [0, 0, 0], { lastDate: '2026-09-08' });
  const { deferred } = selectCategories(['コンサル・士業'], { history, date: '2026-09-09' });
  const [line] = describeDeferred(deferred);

  assert.match(line, /新規0件/);
  assert.match(line, /再挑戦/);
  assert.match(line, /2026-09-15/);
});

test('recordRuns: ファイルに書き出し、読み戻せる', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-runs-'));
  const historyPath = path.join(dir, 'discovery-runs.json');
  try {
    recordRuns([{ category: 'IT・Web開発', found: 1, listed: 1, skipped: 0 }], {
      date: '2026-09-09',
      historyPath,
    });
    recordRuns([{ category: 'IT・Web開発', found: 0, listed: 0, skipped: 0 }], {
      date: '2026-09-10',
      historyPath,
    });

    const history = readHistory(historyPath);
    assert.strictEqual(history.length, 2);
    assert.strictEqual(categoryStatus(history, 'IT・Web開発').zeroStreak, 1);
    assert.strictEqual(categoryStatus(history, 'IT・Web開発').lastRunDate, '2026-09-10');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recordRuns: 履歴が壊れていても発見処理を止めない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-runs-'));
  const historyPath = path.join(dir, 'discovery-runs.json');
  try {
    fs.writeFileSync(historyPath, '{ this is not json', 'utf8');

    // 例外を投げず、全カテゴリーを実行する側に倒れること。
    assert.deepStrictEqual(readHistory(historyPath), []);
    assert.doesNotThrow(() =>
      recordRuns([{ category: 'IT・Web開発', found: 1, listed: 1, skipped: 0 }], { date: '2026-09-09', historyPath })
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
