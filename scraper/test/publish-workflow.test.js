'use strict';

/**
 * 毎日の自動公開ワークフローの見張り。
 *
 * 【なぜ要るか】
 * 姉妹サイト（settle-in-japan）で、記事が1本増えたときに作り直すページの並びから
 * 1つ抜けていたため、公開が検査で止まり、記事が出ない日があった。
 * 「記事が増えたら作り直すもの」を、ここで固定しておく。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const WORKFLOWS = path.join(__dirname, '..', '..', '.github', 'workflows');
const publish = fs.readFileSync(path.join(WORKFLOWS, 'publish-article.yml'), 'utf8');

test('記事を書いたあと、記事ページとサイトマップを作り直している', () => {
  for (const script of ['generate-guide-pages.js', 'generate-sitemap.js']) {
    assert.ok(publish.includes(`node ${script}`), `${script} を作り直していません`);
  }
});

test('公開する前に、もう一度テストを通している', () => {
  const afterWrite = publish.slice(publish.indexOf('Rebuild guide pages'));
  assert.ok(afterWrite.includes('npm test'), '作り直したあとの検査がありません');
});

test('新しい記事は git status で見つけている（git diff では新規ファイルが見えない）', () => {
  assert.ok(publish.includes('git status --porcelain -- data/articles'), '新規ファイルの確認が git status ではありません');
});

test('APIキーは Actions の secrets から渡している', () => {
  assert.ok(publish.includes('secrets.ANTHROPIC_API_KEY'), 'APIキーの渡し方が違います');
});

test('Node は 22 以降を使う（npm test のファイル指定が Node 20 では効かない）', () => {
  // Node 20 の node --test は "test/*.test.js" を展開できず、1件も見つけられない（実際に止まった）。
  const version = publish.match(/node-version: "(\d+)"/);
  assert.ok(version, 'node-version の指定がありません');
  assert.ok(Number(version[1]) >= 22, `node-version が ${version[1]} になっています（22以上にしてください）`);
});

test('日次の実行が、他のワークフローとぶつからないようにしてある', () => {
  assert.ok(publish.includes('group: repo-content-write'), 'concurrency の設定がありません');
});
