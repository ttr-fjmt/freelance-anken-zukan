'use strict';

/**
 * agents.json の各求職者向け詳細ページを、Puppeteerで index.html?ssg=1#/agent/{id} を
 * レンダリングして agent/{id}/index.html として静的出力する（企業モードは対象外）。
 *
 * - data/ssg-manifest.json に { [agentId]: 生成時点のエージェントデータのハッシュ } を保存し、
 *   前回生成時からデータが変化していないエージェントは再生成をスキップする
 *   （structure.js の _rawHash 差分検知と同じ「ハッシュ比較で再生成要否を判定する」設計を踏襲）。
 * - 出力ファイルが明らかに大きい場合（一覧・フィルターのDOMが誤って混入した場合など）は
 *   処理を停止しエラーとして原因を報告する。
 * - agents.json から削除されたエージェントの静的ページ・マニフェストエントリは掃除する。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const AGENTS_PATH = path.join(ROOT, 'agents.json');
const MANIFEST_PATH = path.join(ROOT, 'data', 'ssg-manifest.json');
const OUT_DIR = path.join(ROOT, 'agent');

const PORT = 8935;
const SIZE_TARGET_BYTES = 60 * 1024; // 目安60KB
const SIZE_ERROR_THRESHOLD_BYTES = 200 * 1024; // これを超えたら明らかに異常としてエラー停止

const MIME = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

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

      const page = await browser.newPage();
      try {
        const url = `http://localhost:${PORT}/index.html?ssg=1#/agent/${encodeURIComponent(id)}`;
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
        await page.waitForSelector('#detailView.show', { timeout: 10000 });
        const html = (await page.content()).replace(
          /<meta http-equiv="origin-trial" content="[^"]*">/g,
          ''
        );

        const sizeBytes = Buffer.byteLength(html, 'utf8');
        if (sizeBytes > SIZE_ERROR_THRESHOLD_BYTES) {
          throw new Error(
            `Prerendered page for agent "${id}" is ${(sizeBytes / 1024).toFixed(1)}KB, ` +
              `far larger than the ~${SIZE_TARGET_BYTES / 1024}KB target ` +
              `(error threshold ${(SIZE_ERROR_THRESHOLD_BYTES / 1024).toFixed(0)}KB). ` +
              `This likely means list/filter markup leaked into the SSG output again (the ~730KB bug) — ` +
              `investigate ?ssg=1 handling in index.html before continuing.`
          );
        }

        const outDir = path.join(OUT_DIR, id);
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf8');

        manifest[id] = hash;
        generated += 1;
        console.log(`[prerender] ${id}: ${(sizeBytes / 1024).toFixed(1)}KB -> agent/${id}/index.html`);
      } finally {
        await page.close();
      }
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
