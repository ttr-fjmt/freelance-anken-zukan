'use strict';

/**
 * 掲載範囲のガード。
 * 終了したサービス・フリーランス向けの案件サービスではない企業を一覧から外した（2026-09）。
 * 日次の発見で再び掲載されないよう、スキップリストに理由つきで残っていることを固定する。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const agents = JSON.parse(fs.readFileSync(path.join(ROOT, 'agents.json'), 'utf8'));
const skip = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'agent-discover-skip.json'), 'utf8'));

const REMOVED = [
  ['スポットコンサル（QEEE）', 'discontinued'],
  ['Bizseek（ビズシーク）', 'discontinued'],
  ['workhop（ワークホップ）', 'discontinued'],
  ['サイマル・インターナショナル', 'out_of_scope'],
];

test('外したサービスが一覧に戻っていない', () => {
  const names = new Set(agents.map(a => a.name));
  for (const [name] of REMOVED) assert.ok(!names.has(name), `${name} が一覧に戻っている`);
});

test('外したサービスは、理由つきでスキップリストに残っている（日次の発見で再掲載しないため）', () => {
  for (const [name, reason] of REMOVED) {
    assert.ok(skip[name], `${name} がスキップリストに無い`);
    assert.strictEqual(skip[name].reason, reason, `${name} の理由が違う`);
    assert.ok(skip[name].note, `${name} に外した理由の説明が無い`);
  }
});

test('日次の発見は、スキップリストの名前を候補から除外している', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'discover-agents.js'), 'utf8');
  assert.match(src, /Object\.keys\(skipList\)/, 'スキップリストを除外に使っていない');
});
