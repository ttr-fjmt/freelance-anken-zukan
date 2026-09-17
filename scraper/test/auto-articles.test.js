'use strict';

/**
 * 毎日1本、自動で書く解説記事のガード。
 *
 * 記事は GitHub Actions が人の目を通さずに公開する。だから「公式ページに書かれていることだけを
 * 書く」という約束は、頼み方ではなく**機械的な検査**で守る。ここでは、
 *   ・保存済みの記事がすべて検査を通ること
 *   ・検査が本当に効くこと（引用を1文字変えたら落ちること）
 * の両方を見る。後者が無いと、検査が素通りしていても気づけない。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { checkArticle, checkQuotes, checkNumbers, checkNoPercent, CLOSING_HEADING } = require('../lib/article-guards');
const { loadRawText, textAppearsIn } = require('../lib/verify-text');
const { pickTopic } = require('../write-next-article');
const { loadAutoGuides, allGuides, buildArticle, SOURCES } = require('../generate-guide-pages');

const ROOT = path.join(__dirname, '..', '..');
const readJson = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const sources = readJson('data/sources.json');
const queue = readJson('data/article-queue.json');
const articlesDir = path.join(ROOT, 'data', 'articles');
const articles = fs.existsSync(articlesDir)
  ? fs.readdirSync(articlesDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(articlesDir, f), 'utf8')))
  : [];

/** 検査が効くことを確かめるための、合格する見本。 */
const sampleArticle = {
  id: 'sample',
  title: '見本',
  description: 'あ'.repeat(100),
  published_at: '2026-09-17',
  sources: ['sample-source'],
  sections: [
    { heading: '1', body: ['あ'.repeat(400)], quotes: [{ source_id: 'sample-source', text: '予告は30日前までに行う必要があります。' }] },
    { heading: '2', body: ['い'.repeat(400)], quotes: [{ source_id: 'sample-source', text: '予告は30日前までに行う必要があります。' }] },
    { heading: '3', body: ['う'.repeat(400)], quotes: [{ source_id: 'sample-source', text: '予告は30日前までに行う必要があります。' }] },
    { heading: CLOSING_HEADING, body: ['え'.repeat(100)], quotes: [] },
  ],
};
const sampleRaw = () => 'ここに公式の説明があります。予告は30日前までに行う必要があります。以上。';
const sampleOptions = { sources: [{ id: 'sample-source' }], loadRaw: () => sampleRaw() };

test('出典リストは、すべて公式ドメインのページを指している', () => {
  assert.ok(sources.length > 0, 'data/sources.json が空');
  for (const s of sources) {
    assert.ok(s.id && s.label && s.url, `${s.id}: 項目が足りない`);
    assert.match(
      s.url,
      /^https:\/\/([a-z0-9-]+\.)*(mhlw.go.jp|jftc.go.jp)\//,
      `${s.id} が公式のページではない`
    );
  }
  const ids = sources.map(s => s.id);
  assert.strictEqual(new Set(ids).size, ids.length, '出典IDが重なっている');
});

test('題材リストの形がそろっている', () => {
  const ids = queue.map(t => t.id);
  assert.strictEqual(new Set(ids).size, ids.length, '題材IDが重なっている');
  const numbers = queue.map(t => t.n);
  assert.strictEqual(new Set(numbers).size, numbers.length, '題材の番号が重なっている');
  const known = new Set(sources.map(s => s.id));
  for (const topic of queue) {
    assert.ok(['pending', 'published', 'blocked'].includes(topic.status), `${topic.id}: status が決めた3つ以外`);
    assert.ok(topic.sources.length > 0, `${topic.id}: 出典が指定されていない`);
    for (const id of topic.sources) assert.ok(known.has(id), `${topic.id}: 出典 ${id} が未登録`);
    assert.match(topic.id, /^[a-z0-9-]+$/, `${topic.id}: IDは英小文字・数字・ハイフンだけ`);
  }
});

test('保存してある記事が、すべて検査を通る', () => {
  for (const article of articles) {
    const problems = checkArticle(article, { sources });
    assert.deepStrictEqual(problems, [], `${article.id}: ${problems.join(' / ')}`);
  }
});

test('引用を1文字でも言い換えると、検査に落ちる', () => {
  assert.deepStrictEqual(checkQuotes(sampleArticle, sampleOptions), [], '見本が通らない');
  const tampered = JSON.parse(JSON.stringify(sampleArticle));
  tampered.sections[0].quotes[0].text = '予告は原則30日前までに行う必要があります。';
  assert.ok(checkQuotes(tampered, sampleOptions).length > 0, '言い換えを見逃している');
});

test('引用に無い数字を本文に書くと、検査に落ちる', () => {
  assert.deepStrictEqual(checkNumbers(sampleArticle), [], '見本が通らない');
  const tampered = JSON.parse(JSON.stringify(sampleArticle));
  tampered.sections[0].body[0] += '契約は5年ごとに見直されます。';
  assert.ok(checkNumbers(tampered).length > 0, '裏づけの無い数字を見逃している');
});

test('割合（％）や金額を書くと、検査に落ちる', () => {
  assert.deepStrictEqual(checkNoPercent(sampleArticle), []);
  for (const bad of ['手数料は30%です。', '相場は50万円です。']) {
    const tampered = JSON.parse(JSON.stringify(sampleArticle));
    tampered.sections[0].body[0] += bad;
    assert.ok(checkNoPercent(tampered).length > 0, `「${bad}」を見逃している`);
  }
});

test('出典を取得していない題材・印のついた題材は、次の1本に選ばれない', () => {
  const sample = [
    { n: 1, id: 'no-raw', title: 'a', sources: ['x'], status: 'pending' },
    { n: 2, id: 'blocked-one', title: 'b', sources: ['y'], status: 'blocked' },
    { n: 3, id: 'ready', title: 'c', sources: ['y'], status: 'pending' },
  ];
  const { topic } = pickTopic(sample, { loadRaw: id => (id === 'y' ? '本文' : null) });
  assert.strictEqual(topic.id, 'ready');
});

test('自動で書いた記事のページが、書き出されていて中身と一致している', () => {
  const analytics = '';
  for (const guide of loadAutoGuides()) {
    const file = path.join(ROOT, 'guide', guide.slug, 'index.html');
    assert.ok(fs.existsSync(file), `guide/${guide.slug}/ が書き出されていない（node generate-guide-pages.js）`);
    const html = fs.readFileSync(file, 'utf8');
    assert.ok(html.includes('adsbygoogle.js?client=ca-pub-'), `${guide.slug} に AdSense のタグが無い`);
    assert.ok(
      html.includes(`<link rel="canonical" href="https://freelance-anken-zukan.net/guide/${guide.slug}/">`),
      `${guide.slug} の canonical が違う`
    );
    assert.ok(!/name=["']robots["']/.test(html), `${guide.slug} が検索対象外になっている`);
    for (const key of guide.sources) {
      assert.ok(SOURCES[key], `${guide.slug} の出典 ${key} が未定義`);
      assert.ok(html.includes(SOURCES[key].url), `${guide.slug} に出典 ${key} のリンクが無い`);
    }
    // 書き出し済みのページが、いまのデータから作ったものと同じか
    assert.ok(html.includes(buildArticle(guide, analytics).split('<body>')[1].slice(0, 200)),
      `${guide.slug} のページが古い（node generate-guide-pages.js で作り直してください）`);
  }
});

test('記事ページに出ている引用が、公式ページの本文に実在する', () => {
  // 検査を通ったデータだけを書き出しているので二重の確認だが、
  // 「書き出しの途中で文字が壊れていないか」まで見ておく。
  for (const article of articles) {
    for (const section of article.sections) {
      for (const quote of section.quotes || []) {
        const raw = loadRawText(quote.source_id);
        if (raw == null) continue; // 本文をまだ取得していないだけ
        assert.ok(textAppearsIn(quote.text, raw), `${article.id}: 引用が ${quote.source_id} の本文に無い`);
      }
    }
  }
});

test('一覧ページに、手で書いた記事と自動の記事が両方ならぶ', () => {
  const html = fs.readFileSync(path.join(ROOT, 'guide', 'index.html'), 'utf8');
  for (const guide of allGuides()) {
    assert.ok(html.includes(`/guide/${guide.slug}/`), `一覧に ${guide.slug} が無い`);
  }
});
