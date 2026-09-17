'use strict';

/**
 * 公式ページを取得して、本文を data/raw/<id>.txt に保存する。
 *
 * 【なぜ分けてあるか】
 * クラウド（Claude Code on the web）のセッションは許可ドメインしか見られない。
 * GitHub Actions からは出られるので、「取得」は Actions
 * （.github/workflows/fetch-official.yml）で、「読んで記事を書く」は
 * write-next-article.js で、と分けている。
 *
 * 保存するのは本文のテキストだけ（HTMLタグ・スクリプト・スタイルは落とす）。
 * 記事に書いた引用がこの本文に実在するかを、lib/article-guards.js が照合する。
 *
 * 実行例:
 *   node fetch-official.js                # data/sources.json の全件
 *   node fetch-official.js mhlwShoukai    # id を指定して1件だけ
 *   node fetch-official.js --links jinzai # そのページの中のリンクを一覧する（出典を増やすとき）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCES_PATH = path.join(ROOT, 'data', 'sources.json');
const RAW_DIR = path.join(ROOT, 'data', 'raw');

// HTTPヘッダーに使えるのは ASCII だけ。日本語を入れると送信前に例外になり、1件も取得できない。
const USER_AGENT =
  'freelance-anken-zukan-bot/1.0 (+https://github.com/ttr-fjmt/freelance-anken-zukan; verifying official sources)';

/** 連続アクセスの間隔。公式サイトに負荷をかけないため。 */
const DELAY_MS = 3000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** HTMLから本文テキストだけを取り出す。 */
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** ページの中のリンクを「文字\tURL」で取り出す（出典を増やすときの手がかり）。 */
function linksIn(html, baseUrl) {
  const out = [];
  for (const m of String(html).matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = htmlToText(m[2]).replace(/\s+/g, ' ').trim();
    if (!label) continue;
    try {
      out.push({ label, url: new URL(m[1], baseUrl).toString() });
    } catch {
      /* 壊れたURLは飛ばす */
    }
  }
  return out;
}

/**
 * 文字の種類を見て本文を読む。
 * 官公庁のページには Shift_JIS のものが残っていて、UTF-8 として読むと化ける。
 */
function decodeBody(buffer, contentType) {
  const head = buffer.slice(0, 2048).toString('latin1');
  const declared =
    (contentType || '').match(/charset=([\w-]+)/i) || head.match(/charset=["']?([\w-]+)/i);
  const charset = (declared ? declared[1] : 'utf-8').toLowerCase();
  const alias = { 'shift_jis': 'shift_jis', 'shift-jis': 'shift_jis', 'sjis': 'shift_jis', 'x-sjis': 'shift_jis', 'windows-31j': 'shift_jis', 'cp932': 'shift_jis', 'euc-jp': 'euc-jp' };
  const name = alias[charset] || charset;
  try {
    return new TextDecoder(name).decode(buffer);
  } catch {
    console.log(`  文字の種類 "${charset}" を読めないため UTF-8 として読みます`);
    return buffer.toString('utf8');
  }
}

async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ja' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return decodeBody(buffer, res.headers.get('content-type'));
}

async function main() {
  const args = process.argv.slice(2);
  const wantLinks = args.includes('--links');
  const only = args.filter(a => !a.startsWith('--'));

  const sources = JSON.parse(fs.readFileSync(SOURCES_PATH, 'utf8'));
  const targets = only.length ? sources.filter(s => only.includes(s.id)) : sources;
  if (!targets.length) {
    console.error(`該当する出典がありません: ${only.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(RAW_DIR, { recursive: true });
  let ok = 0;
  let failed = 0;

  for (const [i, source] of targets.entries()) {
    if (i > 0) await delay(DELAY_MS);
    process.stdout.write(`[${i + 1}/${targets.length}] ${source.id} … `);
    try {
      const html = await fetchPage(source.url);
      const text = htmlToText(html);
      if (text.length < 200) throw new Error(`本文が短すぎます（${text.length}字）`);
      fs.writeFileSync(path.join(RAW_DIR, `${source.id}.txt`), `${text}\n`, 'utf8');
      console.log(`${text.length}字 保存しました`);
      ok += 1;
      if (wantLinks) {
        for (const link of linksIn(html, source.url)) console.log(`    ${link.label}\t${link.url}`);
      }
    } catch (error) {
      console.log(`取得できませんでした（${error.message}）`);
      failed += 1;
    }
  }

  console.log(`\n取得できた: ${ok}件 / 取得できなかった: ${failed}件`);
  // 1件も取れなかったときだけ失敗にする（一部が落ちても、取れた分は使える）。
  if (ok === 0) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { htmlToText, linksIn, decodeBody };
