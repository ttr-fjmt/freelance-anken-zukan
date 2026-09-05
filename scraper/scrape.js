'use strict';

/**
 * jesra.or.jp「職業紹介優良事業者認定制度」一覧から掲載事業者の詳細ページを
 * 自動発見し、各詳細ページの事実情報（企業名・サービス名・対応エリア等）を
 * 抽出して data/raw-agents.json に出力するスクレイパー。
 *
 * - robots.txt を尊重する（Disallow に該当するパスはスキップし、クロールを止める）
 * - 各リクエストの間隔を空ける（既定 3〜5秒、環境変数で調整可）
 * - 本文（事業者コメント等）はそのまま転載せず、後段の構造化ステップで
 *   事実情報の抽出・要約に用いるための生データとして保持するのみ
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const { politeDelay, fetchText, fetchBuffer, USER_AGENT } = require('./lib/http');
const { isUrlAllowed } = require('./lib/robots');
const pdfParse = require('pdf-parse');

const FEE_EXCERPT_MAX_CHARS = 4000;

const BASE = 'https://www.jesra.or.jp';
const LIST_URL = `${BASE}/yuryoshokai/certification/`;
const OUT_PATH = path.join(__dirname, '..', 'data', 'raw-agents.json');

const DETAIL_LINK_RE = /\/yuryoshokai\/certification\/\d+\/?$/;

/** dl.box > dd の「直下のテキストノードのみ」を取り出す（子要素の a/br のテキストを含めない）。 */
function directText($, dd) {
  return $(dd)
    .clone()
    .children()
    .remove()
    .end()
    .text()
    .replace(/\s+/g, ' ')
    .trim();
}

function fullText($, el) {
  return $(el).text().replace(/\s+/g, ' ').trim();
}

async function discoverDetailUrls() {
  const urls = new Set();
  let page = 1;
  let maxPage = 1;

  do {
    const url = page === 1 ? LIST_URL : `${LIST_URL}?page=${page}`;

    if (!(await isUrlAllowed(url, USER_AGENT))) {
      console.warn(`robots.txt disallows ${url} — stopping list crawl here.`);
      break;
    }

    console.log(`[list] fetching page ${page}: ${url}`);
    const html = await fetchText(url);
    const $ = cheerio.load(html);

    $('a[href*="/yuryoshokai/certification/"]').each((_, el) => {
      const href = $(el).attr('href');
      if (href && DETAIL_LINK_RE.test(href)) {
        urls.add(new URL(href, BASE).toString());
      }
    });

    let foundMax = maxPage;
    $('.pager a').each((_, el) => {
      const t = $(el).text().trim();
      if (/^\d+$/.test(t)) foundMax = Math.max(foundMax, parseInt(t, 10));
    });
    maxPage = foundMax;

    page += 1;
    if (page <= maxPage) await politeDelay();
  } while (page <= maxPage);

  console.log(`[list] discovered ${urls.size} detail URLs across ${maxPage} page(s).`);
  return [...urls];
}

/**
 * dd内の<a>群から「実際に使えるURL」を選ぶ。
 *
 * jesra.or.jpのテンプレートは、サービス名欄の先頭に必ず href="　"（全角スペース1〜2文字）
 * のダミーリンクを挿入しており、その後に実際の「求職者用」「求人者用」の本物のURLが続く
 * （例:「アスノヴァス エージェント<br><a href="　">　</a><br>求人者用<br><a href="...">...</a>
 * <br>求職者用<br><a href="...">...</a>」）。単純に最初の<a>を取ると必ずこのダミーリンクを
 * 拾ってしまうため、hrefが空/全角スペースのみでない候補だけに絞り込む。
 *
 * 1社で複数サービス（求職者用・求人者用のペアが複数組）を持つ場合は、直前のテキストに
 * 「求職者用」を含むリンクを優先する（サイトの主対象が求職者のため）。見つからなければ
 * 文書順で最初の有効な候補にフォールバックする。
 */
function pickServiceLink($, dd) {
  const candidates = [];
  dd.find('a').each((_, a) => {
    const href = ($(a).attr('href') || '').trim();
    if (!href) return;

    let precedingText = '';
    let node = a.prev;
    while (node) {
      if (node.type === 'tag' && node.name === 'a') break;
      if (node.type === 'text') precedingText = node.data + precedingText;
      node = node.prev;
    }
    candidates.push({ href, precedingText: precedingText.trim() });
  });
  if (candidates.length === 0) return null;
  const preferred = candidates.find(c => c.precedingText.includes('求職者用'));
  return (preferred || candidates[0]).href;
}

function extractDetailFields($) {
  const fields = {};
  $('.dtlCnt_wrap dl.box').each((_, dl) => {
    const dt = $(dl).find('dt').first();
    const dd = $(dl).find('dd').first();
    if (!dt.length || !dd.length) return;
    const key = fullText($, dt);
    fields[key] = {
      text: fullText($, dd),
      directText: directText($, dd),
      link: pickServiceLink($, dd),
    };
  });
  return fields;
}

async function scrapeDetail(url) {
  const html = await fetchText(url);
  const $ = cheerio.load(html);
  const fields = extractDetailFields($);

  const get = label => fields[label] || null;

  const permitCombined = get('厚生労働省 人材サービス総合サイトURL/許可番号');
  const permitMatch = permitCombined && permitCombined.text.match(/(\d{2}-[ユ般]-\d+)/);

  const serviceField = get('サービス名');
  const feeSiteField = get('手数料公表サイト');

  return {
    detailUrl: url,
    companyName: (get('企業名') || {}).text || null,
    certificationNumber: (get('認定番号') || {}).text || null,
    certificationPeriod: (get('認定日/有効期限') || {}).text || null,
    permitNumber: permitMatch ? permitMatch[1] : null,
    hellowworkUrl: permitCombined ? permitCombined.link : null,
    region: (get('対応エリア') || {}).text || null,
    industries: (get('対応業界') || {}).text || null,
    jobTypes: (get('対応職種') || {}).text || null,
    serviceName: serviceField ? serviceField.directText || serviceField.text : null,
    serviceUrl: serviceField ? serviceField.link : null,
    feeDisclosureUrl: feeSiteField ? feeSiteField.link : null,
    feeVariationNote: (get('手数料変動事例') || {}).text || null,
    operatorComment: (get('事業者コメント') || {}).text || null,
  };
}

/** HTML から可視テキストのみを大まかに取り出す（フィー公表サイトの抜粋用）。 */
function htmlToPlainText(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();
  return $('body')
    .text()
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** PDF から可視テキストのみを取り出す。壊れたPDF等は失敗時に null を返す。 */
async function pdfToPlainText(buffer) {
  const data = await pdfParse(buffer);
  return (data.text || '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * 手数料公表サイト（HTML または PDF）からテキストを抜粋する。
 * Content-Type ヘッダーと拡張子の両方で PDF 判定し、失敗時は null を返して
 * 既存の「非公開」表示を維持できるようにする。
 */
async function fetchFeeExcerpt(feeUrl) {
  if (!feeUrl || !/^https?:\/\//.test(feeUrl)) return null;
  try {
    if (!(await isUrlAllowed(feeUrl, USER_AGENT))) {
      console.warn(`robots.txt disallows fee page ${feeUrl} — skipping.`);
      return null;
    }
    const { buffer, contentType } = await fetchBuffer(feeUrl, { timeoutMs: 20000 });
    const isPdf = /application\/pdf/i.test(contentType) || /\.pdf(?:[?#]|$)/i.test(feeUrl);

    const text = isPdf
      ? await pdfToPlainText(buffer)
      : htmlToPlainText(buffer.toString('utf8'));

    if (!text) return null;
    return text.slice(0, FEE_EXCERPT_MAX_CHARS);
  } catch (err) {
    console.warn(`fee page fetch failed for ${feeUrl}: ${err.message}`);
    return null;
  }
}

async function main() {
  const startedAt = new Date().toISOString();

  const detailUrls = await discoverDetailUrls();
  const agents = [];

  for (let i = 0; i < detailUrls.length; i++) {
    const url = detailUrls[i];

    if (!(await isUrlAllowed(url, USER_AGENT))) {
      console.warn(`robots.txt disallows ${url} — skipping.`);
      continue;
    }

    console.log(`[detail] (${i + 1}/${detailUrls.length}) fetching ${url}`);
    await politeDelay();

    let detail;
    try {
      detail = await scrapeDetail(url);
    } catch (err) {
      console.warn(`detail fetch failed for ${url}: ${err.message}`);
      continue;
    }

    let feePageExcerpt = null;
    if (detail.feeDisclosureUrl) {
      await politeDelay();
      feePageExcerpt = await fetchFeeExcerpt(detail.feeDisclosureUrl);
    }

    agents.push({
      ...detail,
      feePageExcerpt,
      fetchedAt: new Date().toISOString(),
    });
  }

  const out = {
    sourceListUrl: LIST_URL,
    fetchedAt: startedAt,
    count: agents.length,
    agents,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${agents.length} agents to ${OUT_PATH}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { discoverDetailUrls, scrapeDetail, fetchFeeExcerpt };
