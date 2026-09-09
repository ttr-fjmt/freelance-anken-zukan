'use strict';

/**
 * API消費量の記録（data/usage-log/YYYY-MM.json）の検証。
 *
 * この記録は「どこにいくらかかっているか」を判断する唯一の根拠になるので、
 * 次の2点を固定する:
 *   - 価格表に無いモデルを 0円として集計しない（金額を過小に見せない）
 *   - 記録の失敗がパイプラインを止めない
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MODEL_PRICING,
  WEB_SEARCH_USD_PER_REQUEST,
  estimateCostUsd,
  normalizeUsage,
  createRecorder,
  instrumentClient,
  mergeUsageRows,
  writeUsageLog,
  logPathFor,
  scriptName,
} = require('../lib/usage-log');

/** messages.create だけを持つ、最小限の偽クライアント。 */
function fakeClient(responses) {
  const calls = [];
  let i = 0;
  return {
    calls,
    messages: {
      async create(params) {
        calls.push(params);
        const response = responses[Math.min(i, responses.length - 1)];
        i += 1;
        if (response instanceof Error) throw response;
        return response;
      },
    },
  };
}

test('estimateCostUsd: トークンとWeb検索の両方を積む', () => {
  const cost = estimateCostUsd({
    model: 'claude-sonnet-4-6',
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    web_search_requests: 100,
  });

  // 入力$3 + 出力$15 + 検索100回($1)
  assert.ok(Math.abs(cost - 19) < 1e-9, `実際: ${cost}`);
});

test('estimateCostUsd: キャッシュは書き込み1.25倍・読み出し0.1倍で計算する', () => {
  const cost = estimateCostUsd({
    model: 'claude-haiku-4-5-20251001',
    input_tokens: 0,
    output_tokens: 0,
    cache_write_tokens: 1_000_000,
    cache_read_tokens: 1_000_000,
    web_search_requests: 0,
  });

  // Haiku 4.5 の入力は $1/MTok。書き込み1.25 + 読み出し0.1 = 1.35
  assert.ok(Math.abs(cost - 1.35) < 1e-9, `実際: ${cost}`);
});

test('estimateCostUsd: 価格表に無いモデルは null（0で埋めない）', () => {
  assert.strictEqual(
    estimateCostUsd({ model: 'claude-未来のモデル', input_tokens: 1_000_000, output_tokens: 0 }),
    null
  );
});

test('価格表に、実際に使っているモデルが載っている', () => {
  // モデルを差し替えたのに価格表を更新し忘れると、金額が静かに欠ける。
  for (const model of ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-sonnet-5']) {
    assert.ok(MODEL_PRICING[model], `${model} が価格表にない`);
  }
  assert.strictEqual(WEB_SEARCH_USD_PER_REQUEST, 0.01);
});

test('normalizeUsage: 欠けている項目は0、web_search回数も拾う', () => {
  assert.deepStrictEqual(normalizeUsage({ input_tokens: 5, server_tool_use: { web_search_requests: 3 } }), {
    input_tokens: 5,
    cache_write_tokens: 0,
    cache_read_tokens: 0,
    output_tokens: 0,
    web_search_requests: 3,
  });

  assert.deepStrictEqual(normalizeUsage(undefined).input_tokens, 0);
});

test('createRecorder: 同じモデルの呼び出しを足し合わせる', () => {
  const recorder = createRecorder({ script: 'discover-schools', date: '2026-09-09' });
  recorder.record('claude-sonnet-4-6', { input_tokens: 10, output_tokens: 20 });
  recorder.record('claude-sonnet-4-6', { input_tokens: 5, output_tokens: 1, server_tool_use: { web_search_requests: 4 } });
  recorder.record('claude-haiku-4-5-20251001', { input_tokens: 100, output_tokens: 2 });

  const rows = recorder.rows();
  assert.strictEqual(recorder.callCount, 3);
  assert.strictEqual(rows.length, 2);

  const sonnet = rows.find(r => r.model === 'claude-sonnet-4-6');
  assert.strictEqual(sonnet.calls, 2);
  assert.strictEqual(sonnet.input_tokens, 15);
  assert.strictEqual(sonnet.output_tokens, 21);
  assert.strictEqual(sonnet.web_search_requests, 4);
  assert.strictEqual(sonnet.script, 'discover-schools');
});

test('createRecorder: 価格表に無いモデルは unpriced として残す', () => {
  const recorder = createRecorder({ script: 'x', date: '2026-09-09' });
  recorder.record('claude-未来のモデル', { input_tokens: 10 });

  const [row] = recorder.rows();
  assert.strictEqual(row.estimated_usd, null);
  assert.strictEqual(row.unpriced, true);
});

test('instrumentClient: 応答の usage を記録し、戻り値はそのまま返す', async () => {
  const recorder = createRecorder({ script: 'x', date: '2026-09-09' });
  const client = fakeClient([
    { model: 'claude-sonnet-4-6', usage: { input_tokens: 7, output_tokens: 3 }, content: [{ type: 'text', text: 'ok' }] },
  ]);

  const wrapped = instrumentClient(client, recorder);
  const response = await wrapped.messages.create({ model: 'claude-sonnet-4-6', messages: [] });

  assert.deepStrictEqual(response.content, [{ type: 'text', text: 'ok' }]);
  assert.strictEqual(recorder.callCount, 1);
  assert.strictEqual(recorder.rows()[0].input_tokens, 7);
  // 元のクライアントにパラメータがそのまま渡っている。
  assert.strictEqual(client.calls.length, 1);
});

test('instrumentClient: API呼び出しが失敗したら記録せず、例外をそのまま投げ直す', async () => {
  const recorder = createRecorder({ script: 'x', date: '2026-09-09' });
  const wrapped = instrumentClient(fakeClient([new Error('rate limited')]), recorder);

  await assert.rejects(() => wrapped.messages.create({ model: 'claude-sonnet-4-6', messages: [] }), /rate limited/);
  assert.strictEqual(recorder.callCount, 0);
});

test('mergeUsageRows: 同じ(日付・スクリプト・モデル)を足し合わせる', () => {
  const merged = mergeUsageRows(
    [{ date: '2026-09-09', script: 'discover-schools', model: 'm', calls: 1, input_tokens: 10, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, web_search_requests: 2, estimated_usd: 0.5 }],
    [{ date: '2026-09-09', script: 'discover-schools', model: 'm', calls: 2, input_tokens: 5, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, web_search_requests: 1, estimated_usd: 0.25 }]
  );

  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].calls, 3);
  assert.strictEqual(merged[0].input_tokens, 15);
  assert.strictEqual(merged[0].web_search_requests, 3);
  assert.strictEqual(merged[0].estimated_usd, 0.75);
});

test('mergeUsageRows: 片方でも価格不明なら合計金額を出さない', () => {
  const merged = mergeUsageRows(
    [{ date: '2026-09-09', script: 's', model: 'm', calls: 1, estimated_usd: 0.5 }],
    [{ date: '2026-09-09', script: 's', model: 'm', calls: 1, estimated_usd: null }]
  );

  assert.strictEqual(merged[0].estimated_usd, null);
  assert.strictEqual(merged[0].unpriced, true);
});

test('writeUsageLog: 月次ファイルへ書き、同じ月の2回目は追記される', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-log-'));
  try {
    const row = model => ({
      date: '2026-09-09',
      script: 'discover-schools',
      model,
      calls: 1,
      input_tokens: 10,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      output_tokens: 1,
      web_search_requests: 0,
      estimated_usd: 0.1,
    });

    const filePath = writeUsageLog([row('claude-sonnet-4-6')], { date: '2026-09-09', logDir: dir });
    assert.strictEqual(filePath, logPathFor('2026-09-09', dir));
    assert.match(path.basename(filePath), /^2026-09\.json$/);

    writeUsageLog([row('claude-sonnet-4-6'), row('claude-haiku-4-5-20251001')], { date: '2026-09-09', logDir: dir });

    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.strictEqual(saved.length, 2);
    assert.strictEqual(saved.find(r => r.model === 'claude-sonnet-4-6').calls, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeUsageLog: 呼び出しが0件なら空ファイルを作らない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-log-'));
  try {
    assert.strictEqual(writeUsageLog([], { date: '2026-09-09', logDir: dir }), null);
    assert.deepStrictEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('flushUsageLog: 二重に書き出さない（明示flush後に終了時flushが走っても増えない）', () => {
  const { getDefaultRecorder, flushUsageLog, resetDefaultRecorder, jstDateString } = require('../lib/usage-log');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-log-'));
  try {
    resetDefaultRecorder();
    getDefaultRecorder().record('claude-sonnet-4-6', { input_tokens: 100, output_tokens: 10 });

    const filePath = flushUsageLog({ logDir: dir });
    assert.ok(filePath, '1回目は書き出される');

    // プロセス終了時の自動書き出しに相当する2回目。
    assert.strictEqual(flushUsageLog({ logDir: dir }), null, '2回目は何もしない');

    const saved = JSON.parse(fs.readFileSync(logPathFor(jstDateString(), dir), 'utf8'));
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(saved[0].calls, 1, '同じ呼び出しが2回数えられていない');
    assert.strictEqual(saved[0].input_tokens, 100);
  } finally {
    resetDefaultRecorder();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scriptName: 実行ファイル名から拡張子を落とす', () => {
  assert.strictEqual(scriptName('/repo/scraper/discover-schools.js'), 'discover-schools');
  assert.strictEqual(scriptName(null), 'unknown');
});
