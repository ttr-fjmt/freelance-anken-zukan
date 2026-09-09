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
    assert.match(
      source,
      /git add data\/usage-log/,
      'Claude API を呼ぶのに data/usage-log をコミットしていない'
    );
  });
}
