'use strict';

const USER_AGENT =
  process.env.SCRAPER_USER_AGENT ||
  'TenshokuAgentZukanBot/1.0 (+https://github.com/ttr-fjmt/agent-zukan)';

const MIN_DELAY_MS = Number(process.env.SCRAPER_MIN_DELAY_MS || 3000);
const JITTER_MS = Number(process.env.SCRAPER_JITTER_MS || 2000);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 3〜5秒間隔（既定値）を空けるための、リクエスト間のポライトウェイト。 */
function politeDelay() {
  return sleep(MIN_DELAY_MS + Math.random() * JITTER_MS);
}

async function fetchText(url, { timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ja,en;q=0.5' },
      signal: controller.signal,
    });
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

/** PDF等バイナリも壊さず取得するための、Buffer + Content-Type 版フェッチ。 */
async function fetchBuffer(url, { timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ja,en;q=0.5' },
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} for ${url}`);
      err.status = res.status;
      throw err;
    }
    const contentType = res.headers.get('content-type') || '';
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, contentType };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { USER_AGENT, politeDelay, sleep, fetchText, fetchBuffer };
