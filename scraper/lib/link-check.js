'use strict';

const DEFAULT_TIMEOUT_MS = 10000;

/**
 * scrape.js 等の巡回用ボットUA（lib/http.js の USER_AGENT）とは意図的に別のものを使う。
 * 生死確認は「一般の訪問者がアクセスできるか」を見たいだけなのに、自己申告のボットUAだと
 * WAF（CloudFront/Cloudflare等）に弾かれて実際には生きているサイトが403等の誤検出で
 * 「死んでいる」と判定されてしまうケースが確認されたため（例: 通常UAでは200、
 * ボットUAでは403）、一般的なブラウザUAを使う。
 */
const LINK_CHECK_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * website フィールドが空/空白/URLとして不正な形式かどうかを判定する。
 * 呼び出し側は、これに該当する場合はネットワークアクセスを行わず invalid_url として扱う
 * （データ不備であり、リンク切れとは別問題のため）。
 */
function isValidUrl(rawUrl) {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return false;
  const target = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(target);
    return !!parsed.hostname && parsed.hostname.includes('.');
  } catch {
    return false;
  }
}

/** DNS解決自体ができない（=ドメインが存在しない）場合のみ dns_failure。それ以外の接続系
 * エラー（TLSハンドシェイク失敗・タイムアウト・接続拒否・一時的なDNS障害等）は connection_error。 */
function classifyError(err) {
  if (err && err.name === 'AbortError') return 'connection_error';
  const code = err && err.cause && err.cause.code;
  if (code === 'ENOTFOUND') return 'dns_failure';
  return 'connection_error';
}

function classifyStatus(status) {
  if (status === 404) return 'http_404';
  if (status === 403) return 'http_403';
  return 'http_other';
}

async function attempt(method, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      headers: { 'User-Agent': LINK_CHECK_USER_AGENT, 'Accept-Language': 'ja,en;q=0.9' },
      signal: controller.signal,
    });
    return { status: res.status, finalUrl: res.url || url, redirected: res.redirected };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * URLの生死を確認する。まずHEADを試し、例外・非2xx/3xxで失敗した場合はGETにフォールバックする。
 * リダイレクトは自動追従し（Node fetchの既定挙動）、最終的に2xx/3xxへ到達すれば生存とみなす。
 *
 * @param {string} url プロトコル省略可（website フィールドの保存形式に合わせる）
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{
 *   category: 'alive'|'invalid_url'|'http_404'|'http_403'|'http_other'|'dns_failure'|'connection_error',
 *   alive: boolean, finalUrl: string|null, status: number|null, redirected: boolean, error: string|null
 * }>}
 */
async function verifyLink(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const trimmed = (url || '').trim();
  if (!isValidUrl(trimmed)) {
    return { category: 'invalid_url', alive: false, finalUrl: null, status: null, redirected: false, error: null };
  }
  const target = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let lastResult = null;
  let lastErrCategory = null;
  let lastErrMessage = null;

  for (const method of ['HEAD', 'GET']) {
    try {
      const result = await attempt(method, target, timeoutMs);
      if (result.status >= 200 && result.status < 400) {
        return { category: 'alive', alive: true, finalUrl: result.finalUrl, status: result.status, redirected: result.redirected, error: null };
      }
      lastResult = result;
      lastErrCategory = null;
      lastErrMessage = null;
    } catch (err) {
      lastResult = null;
      lastErrCategory = classifyError(err);
      lastErrMessage = err.message;
    }
  }

  if (lastResult) {
    return {
      category: classifyStatus(lastResult.status),
      alive: false,
      finalUrl: lastResult.finalUrl,
      status: lastResult.status,
      redirected: lastResult.redirected,
      error: null,
    };
  }
  return {
    category: lastErrCategory || 'connection_error',
    alive: false,
    finalUrl: null,
    status: null,
    redirected: false,
    error: lastErrMessage || 'unknown error',
  };
}

module.exports = { verifyLink, isValidUrl };
