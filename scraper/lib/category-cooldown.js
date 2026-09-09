'use strict';

/**
 * カテゴリー別の「収穫逓減」スロットル（data/discovery-runs.json）。
 *
 * 【何のための仕組みか】
 * 日次ディスカバリーは、1カテゴリーにつき Sonnet + web_search を1回呼ぶ。掲載件数が
 * 伸びているうちは1件あたりの費用が安く、毎日回す価値がある。しかし国内のフリーランス
 * エージェント・案件サービスの母集団は有限なので、いずれカテゴリーごとに「もう新しい
 * ものが出てこない」状態になる。そこから先は、同じ費用を払って新規0件を毎日確認する
 * だけになる。
 *
 * そこで、直近の実績（新規掲載が何件出たか）を見て、出なくなったカテゴリーだけ自動的に
 * 週1回まで落とす。伸びているカテゴリーの頻度は一切下げない。
 *
 * 【絶対に止めない】
 * どれだけ0件が続いても、7日に1回は必ず再挑戦する（恒久的に無効化しない）。
 * 新しいサービスは後から生まれるため、「二度と見に行かない」は誤りになる。
 * 1件でも掲載できた時点で連続0件はリセットされ、翌日から毎日に戻る。
 *
 * 中身は実行1回・1カテゴリーで1行:
 *   [{ "date": "2026-09-09", "category": "ITエンジニア", "found": 5, "listed": 2, "skipped": 3 }, ...]
 *
 * listed は「実在照合を通った件数」（discoverCandidates の perCategory と同じ意味）で、
 * 最終的に agents.json に入った件数ではない。照合まで通ったなら、そのカテゴリーには
 * まだ新しい母集団が残っている、と判断してよい。後段の1件が落ちたことを理由に
 * クールダウンへ入れてしまうのは誤りなので、意図的にこちらを使っている。
 * 検索呼び出し自体が失敗した回は "error": true を立てて記録し、判定には使わない
 * （APIの一時的な失敗を「もう出てこない」と誤解しないため）。
 *
 * skillup-zukan の lib/genre-cooldown.js と同じ仕組み（あちらはジャンル単位）。
 */

const fs = require('fs');
const path = require('path');

const HISTORY_PATH =
  process.env.DISCOVERY_RUNS_PATH || path.join(__dirname, '..', '..', 'data', 'discovery-runs.json');

/** 何回続けて新規0件だったらクールダウンに入れるか。 */
const ZERO_STREAK_THRESHOLD = 3;

/** クールダウン中のカテゴリーを再挑戦させる間隔（日）。 */
const COOLDOWN_DAYS = 7;

/** 1カテゴリーあたり何回分の履歴を残すか（ファイルを無制限に太らせないため）。 */
const MAX_ROWS_PER_CATEGORY = 20;

/** UTCではなく日本時間の日付で数える（運用者が見る「その日」と一致させるため）。 */
function jstDateString(now = new Date()) {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

function parseDate(dateString) {
  const [y, m, d] = dateString.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function daysBetween(fromDate, toDate) {
  return Math.round((parseDate(toDate) - parseDate(fromDate)) / 86400000);
}

function addDays(dateString, days) {
  return new Date(parseDate(dateString) + days * 86400000).toISOString().slice(0, 10);
}

function readHistory(historyPath = HISTORY_PATH) {
  if (!fs.existsSync(historyPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    // 履歴が壊れていても発見処理は止めない。全カテゴリーを実行する側に倒す。
    console.warn(`category-cooldown: 履歴を読めませんでした（全カテゴリーを対象にします）: ${err.message}`);
    return [];
  }
}

/** 1カテゴリーあたり直近 MAX_ROWS_PER_CATEGORY 件だけ残す。並び順（古い→新しい）は保つ。 */
function pruneHistory(history) {
  const countByCategory = new Map();
  const keep = [];

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const row = history[i];
    const count = countByCategory.get(row.category) || 0;
    if (count >= MAX_ROWS_PER_CATEGORY) continue;
    countByCategory.set(row.category, count + 1);
    keep.push(row);
  }

  return keep.reverse();
}

/**
 * discoverCandidates() の perCategory をそのまま履歴に足す。
 * 上限件数で打ち切られて実行されなかったカテゴリーは perCategory に入らないので、
 * 「実行していないのに0件」と記録されることはない。
 */
function appendRuns(perCategory, { date = jstDateString(), history = readHistory() } = {}) {
  const rows = (perCategory || []).map(c => ({
    date,
    category: c.category,
    found: c.found || 0,
    listed: c.listed || 0,
    skipped: c.skipped || 0,
    ...(c.error ? { error: true } : {}),
  }));

  return pruneHistory([...history, ...rows]);
}

function writeHistory(history, { historyPath = HISTORY_PATH } = {}) {
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2) + '\n', 'utf8');
  return historyPath;
}

/** perCategory を履歴に記録して書き出す。記録の失敗で発見処理を落とさない。 */
function recordRuns(perCategory, { date = jstDateString(), historyPath = HISTORY_PATH } = {}) {
  if (!perCategory || perCategory.length === 0) return null;
  try {
    const history = appendRuns(perCategory, { date, history: readHistory(historyPath) });
    return writeHistory(history, { historyPath });
  } catch (err) {
    console.warn(`category-cooldown: 実行履歴の記録に失敗しました（処理は継続します）: ${err.message}`);
    return null;
  }
}

/**
 * あるカテゴリーの、末尾から数えた連続0件回数と、最後に実行した日付。
 * error: true の回は「実行しなかった」ものとして無視する。
 */
function categoryStatus(history, category) {
  const rows = (history || []).filter(r => r.category === category && !r.error);
  let zeroStreak = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if ((rows[i].listed || 0) > 0) break;
    zeroStreak += 1;
  }
  return {
    zeroStreak,
    lastRunDate: rows.length > 0 ? rows[rows.length - 1].date : null,
    runCount: rows.length,
  };
}

/**
 * 今日実行するカテゴリーを選ぶ。
 *
 * 戻り値:
 *   run:      今日実行するカテゴリー（渡された並び順を保つ）
 *   deferred: 今日は見送るカテゴリーと、その理由・次に実行する日
 */
function selectCategories(categories, { history = readHistory(), date = jstDateString() } = {}) {
  const run = [];
  const deferred = [];

  for (const category of categories) {
    const { zeroStreak, lastRunDate } = categoryStatus(history, category);

    if (zeroStreak < ZERO_STREAK_THRESHOLD || !lastRunDate) {
      run.push(category);
      continue;
    }

    if (daysBetween(lastRunDate, date) >= COOLDOWN_DAYS) {
      run.push(category);
      continue;
    }

    deferred.push({
      category,
      zeroStreak,
      lastRunDate,
      nextEligibleDate: addDays(lastRunDate, COOLDOWN_DAYS),
    });
  }

  return { run, deferred };
}

/** 見送ったカテゴリーを、運営者が読んで分かる1行にする。 */
function describeDeferred(deferred) {
  return deferred.map(
    d => `${d.category}: 直近${d.zeroStreak}回続けて新規0件のため今日は見送り（次は${d.nextEligibleDate}に再挑戦）`
  );
}

module.exports = {
  HISTORY_PATH,
  ZERO_STREAK_THRESHOLD,
  COOLDOWN_DAYS,
  MAX_ROWS_PER_CATEGORY,
  jstDateString,
  daysBetween,
  addDays,
  readHistory,
  pruneHistory,
  appendRuns,
  writeHistory,
  recordRuns,
  categoryStatus,
  selectCategories,
  describeDeferred,
};
