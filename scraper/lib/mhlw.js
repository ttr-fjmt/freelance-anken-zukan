'use strict';

/**
 * 厚生労働省「人材サービス総合サイト」（jinzai.hellowork.mhlw.go.jp）の
 * 職業紹介事業者検索・詳細ページを取得するための軽量クライアント。
 *
 * このサイトの検索・ページングは、隠しフィールドを多数持つ単一のフォーム
 * （name="multiForm1"）を毎回 POST し続けるという実装になっており、サーバー側の
 * セッション（JSESSIONID Cookie）に依存する。個別の詳細ページ自体は GET のみで
 * セッション非依存に取得できることを確認済み。
 *
 * Cookie管理は、このサイトが単純な JSESSIONID のみを発行するため、
 * tough-cookie 等の重量級ライブラリは使わず、Set-Cookie を素直に保持して
 * 次のリクエストに Cookie ヘッダーとして付け直すだけの最小実装にしている。
 */

const cheerio = require('cheerio');
const { USER_AGENT, sleep } = require('./http');

const BASE = 'https://jinzai.hellowork.mhlw.go.jp/JinzaiWeb/';
const RESULTS_PER_PAGE = 20;

/**
 * 1日（1回のワークフロー実行）あたりに新規取得する詳細ページ数の上限。
 * ここ1箇所を変更すれば、Actionsの実行時間見積もりと合わせて調整できる。
 * 環境変数 MHLW_DAILY_DETAIL_LIMIT でも上書き可能。
 */
const DAILY_DETAIL_LIMIT = Number(process.env.MHLW_DAILY_DETAIL_LIMIT || 500);

/** 都道府県チェックボックスの name 属性一覧（サイトのHTMLから実測して確認済み）。 */
const PREFECTURES = [
  { name: '北海道', field: 'cbHokkaido' },
  { name: '青森', field: 'cbAomori' },
  { name: '岩手', field: 'cbIwate' },
  { name: '宮城', field: 'cbMiyagi' },
  { name: '秋田', field: 'cbAkita' },
  { name: '山形', field: 'cbYamagata' },
  { name: '福島', field: 'cbFukushima' },
  { name: '茨城', field: 'cbIbaragi' },
  { name: '栃木', field: 'cbTochigi' },
  { name: '群馬', field: 'cbGunma' },
  { name: '埼玉', field: 'cbSaitama' },
  { name: '千葉', field: 'cbChiba' },
  { name: '東京', field: 'cbTokyo' },
  { name: '神奈川', field: 'cbKanagawa' },
  { name: '新潟', field: 'cbNigata' },
  { name: '富山', field: 'cbToyama' },
  { name: '石川', field: 'cbIshikawa' },
  { name: '福井', field: 'cbFukui' },
  { name: '山梨', field: 'cbYamanashi' },
  { name: '長野', field: 'cbNagano' },
  { name: '岐阜', field: 'cbGifu' },
  { name: '静岡', field: 'cbShizuoka' },
  { name: '愛知', field: 'cbAichi' },
  { name: '三重', field: 'cbMie' },
  { name: '滋賀', field: 'cbShiga' },
  { name: '京都', field: 'cbKyoto' },
  { name: '大阪', field: 'cbOsaka' },
  { name: '兵庫', field: 'cbHyogo' },
  { name: '奈良', field: 'cbNara' },
  { name: '和歌山', field: 'cbWakayama' },
  { name: '鳥取', field: 'cbTottori' },
  { name: '島根', field: 'cbShimane' },
  { name: '岡山', field: 'cbOkayama' },
  { name: '広島', field: 'cbHiroshima' },
  { name: '山口', field: 'cbYamaguchi' },
  { name: '徳島', field: 'cbTokushima' },
  { name: '香川', field: 'cbKagawa' },
  { name: '愛媛', field: 'cbEhime' },
  { name: '高知', field: 'cbKochi' },
  { name: '福岡', field: 'cbFukuoka' },
  { name: '佐賀', field: 'cbSaga' },
  { name: '長崎', field: 'cbNagasaki' },
  { name: '熊本', field: 'cbKumamoto' },
  { name: '大分', field: 'cbOita' },
  { name: '宮崎', field: 'cbMiyazaki' },
  { name: '鹿児島', field: 'cbKagoshima' },
  { name: '沖縄', field: 'cbOkinawa' },
];

/** MHLW用の間隔（既定4〜6秒）。政府インフラへの配慮として jesra より広めに取る。 */
function politeDelayMhlw() {
  const min = Number(process.env.MHLW_MIN_DELAY_MS || 4000);
  const jitter = Number(process.env.MHLW_JITTER_MS || 2000);
  return sleep(min + Math.random() * jitter);
}

/**
 * 日曜22:00〜月曜08:00 (JST) のメンテナンス時間帯かどうかを判定する。
 * サイトの「お問い合わせ先」ページに明記されている定期メンテナンス時間。
 */
function isInMhlwMaintenanceWindow(date = new Date()) {
  const jstParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(date);
  const weekday = jstParts.find(p => p.type === 'weekday').value; // "Sun".."Sat"
  const hour = Number(jstParts.find(p => p.type === 'hour').value); // 0-23 (24 for midnight in some locales)
  const h = hour === 24 ? 0 : hour;

  if (weekday === 'Sun' && h >= 22) return true;
  if (weekday === 'Mon' && h < 8) return true;
  return false;
}

/** 単純な Cookie 保持のみ行うセッション。 */
function createSession() {
  const cookies = new Map();

  function cookieHeader() {
    return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  function captureCookies(res) {
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const raw of setCookies) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }

  async function request(url, body, { timeoutMs = 20000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { 'User-Agent': USER_AGENT, 'Accept-Language': 'ja,en;q=0.5' };
      const header = cookieHeader();
      if (header) headers['Cookie'] = header;
      const opts = { method: body ? 'POST' : 'GET', headers, signal: controller.signal };
      if (body) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        opts.body = body.toString();
      }
      const res = await fetch(url, opts);
      captureCookies(res);
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${url}`);
        err.status = res.status;
        throw err;
      }
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  return { get: url => request(url, null), post: (url, body) => request(url, body) };
}

/**
 * フォーム内の全 input/select/textarea を、現在のDOM状態通りに
 * name=value のペア列へシリアライズする（ブラウザの form.submit() と同じ挙動）。
 * overrides で明示的に上書き・追加したいフィールドだけ変更する。
 */
function serializeForm($, formSelector, overrides) {
  const form = $(formSelector);
  const pairs = [];

  form.find('input, select, textarea').each((_, el) => {
    const $el = $(el);
    const tag = el.tagName.toLowerCase();
    const type = ($el.attr('type') || 'text').toLowerCase();
    const name = $el.attr('name');
    if (!name) return;

    if (tag === 'input' && ['submit', 'image', 'button', 'reset'].includes(type)) return;
    if (tag === 'input' && ['checkbox', 'radio'].includes(type)) {
      if ($el.attr('checked') !== undefined) pairs.push([name, $el.attr('value') || 'on']);
      return;
    }
    if (tag === 'select') {
      let opt = $el.find('option[selected]').first();
      if (!opt.length) opt = $el.find('option').first();
      pairs.push([name, opt.attr('value') || '']);
      return;
    }
    pairs.push([name, $el.attr('value') || '']);
  });

  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      const idx = pairs.findIndex(p => p[0] === key);
      if (idx >= 0) pairs[idx][1] = value;
      else pairs.push([key, value]);
    }
  }

  const usp = new URLSearchParams();
  for (const [key, value] of pairs) usp.append(key, value);
  return usp;
}

/** 検索結果テキストから総件数を取り出す。 */
function extractTotalCount($) {
  const m = $('body').text().match(/検索結果\s*([\d,]+)\s*件/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

/** トップページ→検索画面遷移→都道府県検索 まで一気に行い、結果一覧の $ を返す。 */
async function searchPrefecture(session, prefectureField) {
  let html = await session.get(`${BASE}GICB101010.do?action=initDisp&screenId=GICB101010`);
  let $ = cheerio.load(html);

  let body = serializeForm($, 'form[name=multiForm1]', { action: 'transition', params: '1' });
  html = await session.post(`${BASE}GICB101010.do`, body);
  $ = cheerio.load(html);

  body = serializeForm($, 'form[name=multiForm1]', { action: 'search', params: '', [prefectureField]: '1' });
  html = await session.post(`${BASE}GICB102030.do`, body);
  $ = cheerio.load(html);

  const bodyText = $('body').text();
  if (/サーバーでエラーが発生しました/.test(bodyText)) {
    throw new Error(`MHLW returned a security/server error page while searching ${prefectureField}`);
  }

  return { $, totalCount: extractTotalCount($) };
}

/** 現在の結果一覧 $ から、指定ページへ遷移した後の $ を返す。 */
async function gotoResultPage(session, $, pageNumber) {
  const body = serializeForm($, 'form[name=multiForm1]', { action: 'page', params: String(pageNumber) });
  const html = await session.post(`${BASE}GICB102030.do`, body);
  const next$ = cheerio.load(html);

  if (/サーバーでエラーが発生しました/.test(next$('body').text())) {
    throw new Error(`MHLW returned a security/server error page while paging to page ${pageNumber}`);
  }
  return next$;
}

/** 結果一覧ページから、各事業所の許可番号と詳細ページURLを抽出する（重複除去済み）。 */
function extractResultRows($) {
  const seen = new Set();
  const rows = [];
  $('a[href*="action=detail"]').each((_, a) => {
    const href = $(a).attr('href');
    if (!href || seen.has(href)) return;
    seen.add(href);
    const m = href.match(/detkey_Detail=([^&]+)/);
    const permitNumber = m ? decodeURIComponent(m[1]).split(',')[0].trim() : null;
    rows.push({ permitNumber, detailUrl: new URL(href, BASE).toString() });
  });
  return rows;
}

function textOf($, el) {
  return $(el).text().replace(/\s+/g, ' ').trim();
}

/** 職業紹介事業詳細ページから、事実情報のみを抽出する。 */
function extractDetailFields(html) {
  const $ = cheerio.load(html);
  const bodyText = $('body').text();
  if (/サーバーでエラーが発生しました/.test(bodyText)) {
    throw new Error('MHLW returned a security/server error page for this detail URL');
  }

  const byId = id => {
    const el = $(`#${id}`);
    return el.length ? textOf($, el) : null;
  };

  const yearlyStats = [];
  $('td.searchDet_data_center').each((_, td) => {
    const label = textOf($, td);
    if (!/^(令和|平成|昭和)\d+年度$/.test(label)) return;
    const tds = $(td).nextAll('td.searchDet_data_center');
    const nums = tds
      .slice(0, 5)
      .map((_, cell) => textOf($, cell).replace(/[^\d]/g, ''))
      .get()
      .map(v => (v === '' ? null : Number(v)));
    yearlyStats.push({
      fiscalYear: label,
      placements4moPlusFixedTerm: nums[0] ?? null,
      placements4moPlusIndefiniteTerm: nums[1] ?? null,
      placementsUnder4moFixedTerm: nums[2] ?? null,
      turnoverCount: nums[3] ?? null,
      turnoverUnknownCount: nums[4] ?? null,
    });
  });

  return {
    permitNumber: byId('ID_lbKyokatodokedeNo'),
    permitDate: byId('ID_lbKyokatodokedeDate'),
    businessOwnerName: byId('ID_lbJigyonushiName'),
    establishmentName: byId('ID_lbJigyoshoName'),
    address: byId('ID_lbJigyoshoAddress'),
    phone: byId('ID_lbTel'),
    handledOccupations: byId('ID_lbToriatsukaiShokushu'),
    handledRegion: byId('ID_lbToriatsukaiChiiki'),
    handledOther: byId('ID_lbToriatsukaiSonota'),
    yearlyStats,
  };
}

module.exports = {
  BASE,
  RESULTS_PER_PAGE,
  DAILY_DETAIL_LIMIT,
  PREFECTURES,
  politeDelayMhlw,
  isInMhlwMaintenanceWindow,
  createSession,
  serializeForm,
  extractTotalCount,
  searchPrefecture,
  gotoResultPage,
  extractResultRows,
  extractDetailFields,
};
