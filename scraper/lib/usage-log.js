'use strict';

/**
 * Claude API の消費量の記録（data/usage-log/YYYY-MM.json）。
 *
 * 【何のための記録か】
 * このリポジトリの日次パイプラインは、カテゴリー別のWeb検索（discover-agents）と、
 * 実在照合後の構造化（Haiku）で Claude API を呼んでいる。どこにいくらかかっているかを
 * 測っていないと、「発見の頻度を落とすべきか」「モデルを変えるべきか」といった判断が
 * すべて推測になる。ここでは各呼び出しの usage を積み上げて、月次のファイルに残す。
 *
 * 【設計方針】
 * - 記録は絶対にパイプラインを止めない。書き込み失敗・未知のモデルなどは警告に留める。
 * - 金額は「公開価格からの概算」であって請求額ではない。未知のモデルは 0 で埋めずに
 *   estimated_usd: null とし、unpriced: true を立てる（DATA_QUALITY_POLICY.md の
 *   「確認できない情報は埋めない」と同じ扱い）。
 * - Anthropic クライアントを作っている箇所で instrumentClient() を通すだけで測定対象に
 *   なる。プロセス終了時に自動で書き出す。
 *
 * 中身は (日付 × スクリプト × モデル) で1行:
 *   [{ "date": "2026-09-09", "script": "discover-agents", "model": "claude-sonnet-4-6",
 *      "calls": 8, "input_tokens": 1234, "cache_read_tokens": 0, "cache_write_tokens": 0,
 *      "output_tokens": 5678, "web_search_requests": 42, "estimated_usd": 0.5312 }, ...]
 */

const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.USAGE_LOG_DIR || path.join(__dirname, '..', '..', 'data', 'usage-log');

/**
 * 公開価格（USD / 100万トークン）。https://www.anthropic.com/pricing の値を手で写したもの。
 *
 * cache_write は5分TTLの倍率(1.25倍)で計算している。このリポジトリは cache_control に
 * ttl を指定していないため既定の5分TTLになる。1時間TTLを使い始めたら2倍に直すこと。
 * cache_read は入力の 0.1 倍。
 *
 * モデルを増やしたら必ずここに足す。足し忘れると estimated_usd が null になり、
 * ログ側に unpriced: true が残るので、後から気づける。
 */
const MODEL_PRICING = {
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-opus-5': { input: 5, output: 25 },
};

/** Web検索ツールの課金は検索1回あたり（$10 / 1,000回）。トークンとは別建てで加算する。 */
const WEB_SEARCH_USD_PER_REQUEST = 10 / 1000;

const CACHE_WRITE_MULTIPLIER = 1.25; // 5分TTL
const CACHE_READ_MULTIPLIER = 0.1;

/** UTCではなく日本時間の日付で数える（discovery-log と揃える）。 */
function jstDateString(now = new Date()) {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

function logPathFor(date, logDir = LOG_DIR) {
  return path.join(logDir, `${date.slice(0, 7)}.json`);
}

/**
 * 1行分の概算コスト（USD）。価格表に無いモデルは null を返す（0 で埋めない）。
 */
function estimateCostUsd(row) {
  const price = MODEL_PRICING[row.model];
  if (!price) return null;

  const perToken = n => (n || 0) / 1e6;
  return (
    perToken(row.input_tokens) * price.input +
    perToken(row.cache_write_tokens) * price.input * CACHE_WRITE_MULTIPLIER +
    perToken(row.cache_read_tokens) * price.input * CACHE_READ_MULTIPLIER +
    perToken(row.output_tokens) * price.output +
    (row.web_search_requests || 0) * WEB_SEARCH_USD_PER_REQUEST
  );
}

/** SDKの usage オブジェクトを、このログの列名に読み替える。欠けている項目は0扱い。 */
function normalizeUsage(usage) {
  const u = usage || {};
  return {
    input_tokens: u.input_tokens || 0,
    cache_write_tokens: u.cache_creation_input_tokens || 0,
    cache_read_tokens: u.cache_read_input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    // web_search を使った応答にだけ入る。SDKのバージョンによっては無いので防御的に読む。
    web_search_requests: (u.server_tool_use && u.server_tool_use.web_search_requests) || 0,
  };
}

/**
 * 呼び出しを (日付 × スクリプト × モデル) で足し合わせる入れ物。
 */
function createRecorder({ script = scriptName(), date = jstDateString() } = {}) {
  const rows = new Map();

  function record(model, usage) {
    // 区切り文字が値に混ざらないよう、配列をJSON化したものをキーにする。
    const key = JSON.stringify([date, script, model]);
    const row =
      rows.get(key) ||
      {
        date,
        script,
        model,
        calls: 0,
        input_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        output_tokens: 0,
        web_search_requests: 0,
      };

    const u = normalizeUsage(usage);
    row.calls += 1;
    row.input_tokens += u.input_tokens;
    row.cache_read_tokens += u.cache_read_tokens;
    row.cache_write_tokens += u.cache_write_tokens;
    row.output_tokens += u.output_tokens;
    row.web_search_requests += u.web_search_requests;

    rows.set(key, row);
    return row;
  }

  return {
    record,
    /** 金額を付けた行の配列。呼び出しが無ければ空配列。 */
    rows() {
      return [...rows.values()].map(row => {
        const estimated = estimateCostUsd(row);
        return estimated === null
          ? { ...row, estimated_usd: null, unpriced: true }
          : { ...row, estimated_usd: Number(estimated.toFixed(6)) };
      });
    },
    get callCount() {
      return [...rows.values()].reduce((sum, r) => sum + r.calls, 0);
    },
  };
}

/** 実行中のスクリプト名（discover-agents.js → "discover-agents"）。 */
function scriptName(argv1 = process.argv[1]) {
  if (!argv1) return 'unknown';
  return path.basename(argv1).replace(/\.js$/, '');
}

/**
 * Anthropic クライアントの messages.create を差し替えて、応答の usage を recorder に流す。
 *
 * Proxy やラッパーオブジェクトで包むと、SDK内部のメソッドを呼んだときの this が
 * すり替わって壊れることがある。ここでは getAnthropicClient() が作ったばかりの、
 * 他と共有していないインスタンスに対してだけメソッドを上書きする（this はそのまま）。
 *
 * API呼び出しが失敗したときは記録せずに例外をそのまま投げ直す
 * （呼び出し側のリトライ・握りつぶしの挙動を変えないため）。
 */
function instrumentClient(client, recorder) {
  if (client.__usageInstrumented) return client;

  const originalCreate = client.messages.create.bind(client.messages);

  client.messages.create = async (...args) => {
    const response = await originalCreate(...args);
    try {
      // 応答が返したモデルIDを優先する（リクエストのエイリアスではなく実際に課金される方）。
      const model = (response && response.model) || (args[0] && args[0].model) || 'unknown';
      recorder.record(model, response && response.usage);
    } catch (err) {
      console.warn(`usage-log: 消費量の記録に失敗しました（処理は継続します）: ${err.message}`);
    }
    return response;
  };

  client.__usageInstrumented = true;
  return client;
}

/**
 * 既存の月次ログに新しい行をマージする。
 * 同じ (date, script, model) があれば足し合わせ、無ければ行を足す。
 */
function mergeUsageRows(existing, incoming) {
  const merged = (existing || []).map(row => ({ ...row }));

  for (const row of incoming) {
    const target = merged.find(r => r.date === row.date && r.script === row.script && r.model === row.model);
    if (!target) {
      merged.push({ ...row });
      continue;
    }
    for (const key of ['calls', 'input_tokens', 'cache_read_tokens', 'cache_write_tokens', 'output_tokens', 'web_search_requests']) {
      target[key] = (target[key] || 0) + (row[key] || 0);
    }
    if (row.estimated_usd === null || target.estimated_usd === null || target.estimated_usd === undefined) {
      // 片方でも価格不明なら合計も出さない（部分的な金額を全体の金額として見せないため）。
      target.estimated_usd = null;
      target.unpriced = true;
    } else {
      target.estimated_usd = Number((target.estimated_usd + row.estimated_usd).toFixed(6));
    }
  }

  return merged;
}

/**
 * 行を月次ファイルへ書き出す。呼び出しが1件も無ければ何もしない（空ファイルを作らない）。
 * 戻り値: 書き出したファイルパス、または null。
 */
function writeUsageLog(rows, { date = jstDateString(), logDir = LOG_DIR } = {}) {
  if (!rows || rows.length === 0) return null;

  const filePath = logPathFor(date, logDir);
  let existing = [];
  if (fs.existsSync(filePath)) {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(parsed)) existing = parsed;
  }

  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(mergeUsageRows(existing, rows), null, 2) + '\n', 'utf8');
  return filePath;
}

/**
 * プロセス全体で共有する recorder。getAnthropicClient() が返すクライアントは
 * すべてここに記録されるので、スクリプト側に書き足すコードは無い。
 */
let defaultRecorder = null;

function getDefaultRecorder() {
  if (!defaultRecorder) defaultRecorder = createRecorder();
  return defaultRecorder;
}

/** テスト用。プロセス内の積み上げを捨てる。 */
function resetDefaultRecorder() {
  defaultRecorder = null;
}

/**
 * 共有 recorder の内容を書き出して、サマリを1行表示する。
 * 呼び出しが無ければ黙って何もしない（テスト実行でファイルを作らないため）。
 *
 * 書き出しに成功したら積み上げを捨てる。明示的に呼んだあとにプロセス終了の
 * 自動書き出しが走っても、同じ消費量を二重に記録しないため。
 */
function flushUsageLog({ logDir = LOG_DIR } = {}) {
  if (!defaultRecorder || defaultRecorder.callCount === 0) return null;

  const recorder = defaultRecorder;
  const rows = recorder.rows();
  try {
    const filePath = writeUsageLog(rows, { logDir });
    // 書けた分だけ捨てる（失敗したときは残して、終了時の自動書き出しに再挑戦させる）。
    if (defaultRecorder === recorder) defaultRecorder = null;
    const priced = rows.filter(r => r.estimated_usd !== null);
    const total = priced.reduce((sum, r) => sum + r.estimated_usd, 0);
    const searches = rows.reduce((sum, r) => sum + (r.web_search_requests || 0), 0);
    const unpriced = rows.filter(r => r.estimated_usd === null).map(r => r.model);

    console.log(
      `API消費量: ${recorder.callCount}回の呼び出し・Web検索${searches}回、概算 $${total.toFixed(4)}` +
        (unpriced.length > 0 ? `（価格表に無いモデルが含まれるため一部未計上: ${[...new Set(unpriced)].join(', ')}）` : '') +
        ` → ${filePath ? path.relative(process.cwd(), filePath) : '(書き出しなし)'}`
    );
    return filePath;
  } catch (err) {
    // 記録の失敗でパイプラインを落とさない。
    console.warn(`usage-log: 書き出しに失敗しました（処理は継続します）: ${err.message}`);
    return null;
  }
}

let exitFlushInstalled = false;

/** プロセス終了時に自動で書き出す。二重登録はしない。 */
function installExitFlush() {
  if (exitFlushInstalled) return;
  exitFlushInstalled = true;
  process.on('exit', () => flushUsageLog());
}

module.exports = {
  LOG_DIR,
  MODEL_PRICING,
  WEB_SEARCH_USD_PER_REQUEST,
  jstDateString,
  logPathFor,
  scriptName,
  estimateCostUsd,
  normalizeUsage,
  createRecorder,
  instrumentClient,
  mergeUsageRows,
  writeUsageLog,
  getDefaultRecorder,
  resetDefaultRecorder,
  flushUsageLog,
  installExitFlush,
};
