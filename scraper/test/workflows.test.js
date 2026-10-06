'use strict';

/**
 * ワークフロー定義の不変条件。
 *
 * Claude API を呼ぶワークフローは、消費量の記録（data/usage-log/）も必ずコミットする。
 * ここを忘れると、実行のたびに費用は発生しているのに記録がリポジトリに残らず、
 * 「どこにいくらかかっているか」を後から追えなくなる。しかも記録が無いこと自体に
 * 気づけないので、テストとして固定しておく。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const WORKFLOW_DIR = path.join(__dirname, '..', '..', '.github', 'workflows');
const workflows = fs.readdirSync(WORKFLOW_DIR).filter(f => f.endsWith('.yml'));

test('ワークフローが1つ以上ある', () => {
  assert.ok(workflows.length >= 1, `見つかったワークフロー: ${workflows.length}件`);
});

for (const file of workflows) {
  const source = fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');
  if (!/ANTHROPIC_API_KEY:/.test(source)) continue;

  test(`${file}: API消費量の記録(data/usage-log)をコミットしている`, () => {
    // data/usage-log を名指しするか、data ごと add していればよい。
    assert.ok(
      /git add [^\n]*data\/usage-log/.test(source) || /git add -A -- "\$target"/.test(source),
      'Claude API を呼ぶのに data/usage-log をコミットしていない'
    );
  });
}

test('AIを呼ぶ部品が、消費量をファイルに書き出す設定になっている', () => {
  // 呼び出しは記録していても、終了時に書き出さないとファイルに残らない。
  // 実際にこれで記事作成の費用が丸ごと記録から抜けていた（2026-09-27 に発覚）。
  const ai = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ai.js'), 'utf8');
  assert.match(ai, /installExitFlush\(\)/, 'installExitFlush() を呼んでいません');
});

// 2026-10-06、転職エージェント図鑑で記事の保存が失敗した。記事公開は順番待ち（concurrency）で
// 先の処理が終わるのを待っていたが、読み込んだのは「待ち始めた時点」の古い版だったため、
// 待っている間に先の処理が保存した内容と食い違い、push が弾かれた。
// main へ書き戻すワークフローは、動き出した時点の最新を読み込むこと。
for (const file of workflows) {
  const src = fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');
  if (!/git push/.test(src)) continue;
  test(`${file}: 動き出した時点の最新の main を読み込む（順番待ちの間の更新と食い違わないように）`, () => {
    const checkouts = src.match(/uses: actions\/checkout@v\d+[\s\S]*?(?=\n\s*- (?:name|uses):|\n\S|$)/g) || [];
    assert.ok(checkouts.length > 0, 'actions/checkout が見つからない');
    for (const block of checkouts) {
      assert.match(block, /ref: \$\{\{ github\.ref_name \}\}/, 'checkout に ref: ${{ github.ref_name }} が無い');
    }
  });
}
