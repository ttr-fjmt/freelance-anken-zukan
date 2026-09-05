'use strict';

/**
 * agents.json の各サービス詳細ページを、Puppeteerで index.html?ssg=1#/agent/{id} を
 * レンダリングして agent/{id}/index.html として静的出力する。
 *
 * agent-zukanのprerender.jsと同じ設計を踏襲している:
 * - data/ssg-manifest.json に { [agentId]: 生成時点のエージェントデータのハッシュ } を保存し、
 *   前回生成時からデータが変化していないエージェントは再生成をスキップする。
 * - 出力ファイルが明らかに大きい場合（一覧・フィルターのDOMが誤って混入した場合など）は
 *   処理を停止しエラーとして原因を報告する。
 * - agents.json から削除されたエージェントの静的ページ・マニフェストエントリは掃除する。
 *
 * agent-zukan版からの拡張点:
 * - フリーランス案件図鑑は受注側(候補者)・発注側(企業)の2モードを持つ。canonical URL・
 *   JSON-LD等のSEO上の主表現は、既存のindex.html自体の設計（updateCanonicalが候補者
 *   モードの時だけ /agent/{id}/ を指す）に合わせ、引き続き受注側(候補者)モードとする
 *   （agent-zukan側の「企業モードは対象外」という設計をそのまま踏襲）。
 * - ただし発注側(企業)モードの紹介文もクローラーが読み取れるよう、候補者モードの
 *   ページに #ssgCompanyContent という非表示のdivを追加で埋め込む。既存の
 *   #detailView のid・構造やモード切り替えUI・JSの動作には一切影響しない
 *   （このdivは既存JSからは一切参照されない、SEO専用の補助コンテンツ）。
 * - index.htmlのupdateMetaForAgent()はog:urlを常時location.hrefから設定する
 *   （企業モードのハッシュURLを共有された場合に、そのURLをog:urlに反映するための
 *   意図的な挙動で、実際の本番ドメインでのライブ閲覧では正しく動作する）。しかし
 *   このスクリプトのSSGキャプチャ時はlocation.hrefがローカル検証サーバーのURL
 *   （http://localhost:PORT/...?ssg=1#/agent/{id}）になってしまうため、静的ファイルの
 *   og:urlだけはキャプチャ後に本番の正しいURLへ上書きする（index.html側の動的な
 *   挙動自体は変更しない）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const AGENTS_PATH = path.join(ROOT, 'agents.json');
const SITE_ORIGIN = 'https://freelance-anken-zukan.net';
const MANIFEST_PATH = path.join(ROOT, 'data', 'ssg-manifest.json');
const OUT_DIR = path.join(ROOT, 'agent');

const PORT = 8935;
const SIZE_TARGET_BYTES = 90 * 1024; // 目安90KB（候補者モード本体+企業モード補助コンテンツの分、agent-zukanの60KBより少し高めに設定）
const SIZE_ERROR_THRESHOLD_BYTES = 250 * 1024; // これを超えたら明らかに異常としてエラー停止

const MIME = {
  '.html': 'text/html',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/** エージェントの構造化データ全体をハッシュ化する（表示内容が変わればハッシュも変わる）。 */
function computeAgentHash(agent) {
  return crypto.createHash('sha256').update(JSON.stringify(agent)).digest('hex');
}

function startStaticServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';
      const filePath = path.join(ROOT, urlPath);
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.on('error', reject);
    server.listen(PORT, () => resolve(server));
  });
}

// テスト用: 設定すると先頭 N 件のみ処理する（CI上での小規模動作確認向け）。未設定なら全件処理する。
const LIMIT = process.env.PRERENDER_LIMIT ? parseInt(process.env.PRERENDER_LIMIT, 10) : null;

/**
 * 1エージェント分の静的HTMLを組み立てる。
 * 1. 候補者モードで ?ssg=1#/agent/{id} をレンダリングする（meta/JSON-LD/canonicalは
 *    このモードの内容がそのままページ全体に反映される）。
 * 2. 企業モードで ?ssg=1#/agent/{id}?mode=company をレンダリングし、#detailView の
 *    中身だけを取り出す。
 * 3. 候補者モードのページに、企業モードの中身を非表示のdiv（#ssgCompanyContent）として
 *    DOM上で追加してから、ページ全体のHTMLを取得する（文字列置換ではなくDOM API経由で
 *    追加することで、Puppeteerが返すシリアライズ済みHTMLの空白・改行の違いに左右されない
 *    確実な埋め込みにしている）。
 */
async function renderAgentHTML(browser, id) {
  const candidatePage = await browser.newPage();
  try {
    const candidateUrl = `http://localhost:${PORT}/index.html?ssg=1#/agent/${encodeURIComponent(id)}`;
    await candidatePage.goto(candidateUrl, { waitUntil: 'networkidle0', timeout: 30000 });
    await candidatePage.waitForSelector('#detailView.show', { timeout: 10000 });

    const companyPage = await browser.newPage();
    let companyDetailHTML = '';
    try {
      const companyUrl = `http://localhost:${PORT}/index.html?ssg=1#/agent/${encodeURIComponent(id)}?mode=company`;
      await companyPage.goto(companyUrl, { waitUntil: 'networkidle0', timeout: 30000 });
      await companyPage.waitForSelector('#detailView.show', { timeout: 10000 });
      companyDetailHTML = await companyPage.$eval('#detailView', el => el.innerHTML);
    } finally {
      await companyPage.close();
    }

    await candidatePage.evaluate(innerHTML => {
      const div = document.createElement('div');
      div.id = 'ssgCompanyContent';
      div.hidden = true;
      div.setAttribute('aria-hidden', 'true');
      div.innerHTML = innerHTML;
      document.body.appendChild(div);
    }, companyDetailHTML);

    const canonicalUrl = `${SITE_ORIGIN}/agent/${encodeURIComponent(id)}/`;
    const html = (await candidatePage.content())
      .replace(/<meta http-equiv="origin-trial" content="[^"]*">/g, '')
      .replace(
        /(<meta property="og:url" id="og-url" content=")[^"]*(")/,
        `$1${canonicalUrl}$2`
      );

    if (!html.includes('id="ssgCompanyContent"')) {
      throw new Error(`Failed to inject company-mode SSG content for agent "${id}" — DOM injection did not take effect.`);
    }

    return html;
  } finally {
    await candidatePage.close();
  }
}

async function main() {
  const agents = readJson(AGENTS_PATH, []);
  if (agents.length === 0) {
    console.log(`No agents found at ${AGENTS_PATH} — skipping prerender.`);
    return;
  }

  const manifest = readJson(MANIFEST_PATH, {});
  const currentIds = new Set(agents.map(a => String(a.id)));

  // agents.json から削除された（廃業等で消えた）エージェントの静的ページを掃除する。
  let pruned = 0;
  for (const id of Object.keys(manifest)) {
    if (!currentIds.has(id)) {
      const dir = path.join(OUT_DIR, id);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      delete manifest[id];
      pruned += 1;
    }
  }

  const puppeteer = require('puppeteer');
  const server = await startStaticServer();

  let browser;
  try {
    // GitHub Actionsのrunnerはrootで実行されるため、Chromeのデフォルトサンドボックスは
    // 権限不足で起動直後にネイティブクラッシュする。--no-sandbox 系フラグで回避する。
    // --disable-dev-shm-usage は /dev/shm の容量不足によるクラッシュ対策。
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  } catch (err) {
    await new Promise(resolve => server.close(resolve));
    throw new Error(`puppeteer.launch() failed (browser could not start): ${err.message}`);
  }

  let generated = 0;
  let skipped = 0;

  const targets = LIMIT ? agents.slice(0, LIMIT) : agents;
  if (LIMIT) console.log(`PRERENDER_LIMIT=${LIMIT} set — processing only the first ${targets.length} agent(s).`);

  try {
    for (const agent of targets) {
      const id = String(agent.id);
      const hash = computeAgentHash(agent);
      if (manifest[id] === hash) {
        skipped += 1;
        continue;
      }

      const html = await renderAgentHTML(browser, id);

      const sizeBytes = Buffer.byteLength(html, 'utf8');
      if (sizeBytes > SIZE_ERROR_THRESHOLD_BYTES) {
        throw new Error(
          `Prerendered page for agent "${id}" is ${(sizeBytes / 1024).toFixed(1)}KB, ` +
            `far larger than the ~${SIZE_TARGET_BYTES / 1024}KB target ` +
            `(error threshold ${(SIZE_ERROR_THRESHOLD_BYTES / 1024).toFixed(0)}KB). ` +
            `This likely means list/filter markup leaked into the SSG output (the agent-zukan "~730KB bug") — ` +
            `investigate ?ssg=1 handling in index.html before continuing.`
        );
      }

      const outDir = path.join(OUT_DIR, id);
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf8');

      manifest[id] = hash;
      generated += 1;
      console.log(`[prerender] ${id}: ${(sizeBytes / 1024).toFixed(1)}KB -> agent/${id}/index.html`);
    }
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }

  writeJson(MANIFEST_PATH, manifest);
  console.log(
    `Prerender finished: generated=${generated}, skipped(unchanged)=${skipped}, pruned=${pruned}, ` +
      `processed=${targets.length}, totalAgents=${agents.length}`
  );
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { computeAgentHash };
