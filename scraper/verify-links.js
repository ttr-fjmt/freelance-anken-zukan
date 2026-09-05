'use strict';

/**
 * agents.json 全件（featured===true を除く）の website について生死を確認し、
 * 到達不能なエージェントを削除する一括メンテナンススクリプト。
 *
 * 判定方針（誤削除を避けるための分類）:
 *   - no_company_website: mhlw由来エージェントで、website が自社サイトではなく
 *                    MHLW「人材サービス総合サイト」の詳細ページURL自身になっているケース
 *                    （生データに serviceUrl が無いための structure.js のフォールバック）。
 *                    MHLW自身のURLを叩いても常に生存するだけで無意味なため、
 *                    verifyLink() すら呼ばず対象外とする（削除・linkVerified変更なし）。
 *   - invalid_url  : website が空/空白/URLとして不正な形式。今回のPART 2の対象外とし、
 *                    削除もフラグ変更も行わない（別問題として現状維持）。
 *   - http_403     : サーバーは応答しているがボット等をブロックしているだけの可能性が高い。
 *                    生存とみなし、削除もフラグ変更も行わず現状維持する。
 *   - http_other   : 403/404以外の非2xx/3xx（401/429/500/503等）。サーバー自体は応答して
 *                    おり、一時的な問題の可能性が高いため、削除対象にはしない（現状維持）。
 *   - http_404     : 明確に「ページが存在しない」という応答。最も強いシグナルのため即削除。
 *   - dns_failure  : ドメイン自体が存在しない（DNS解決エラー ENOTFOUND）。
 *   - connection_error: TLSハンドシェイク失敗・タイムアウト・接続拒否等、接続自体ができない
 *                    その他のケース。
 *   dns_failure と connection_error は「一時的な問題の可能性」を考慮し、即削除にはしない。
 *   data/link-check-pending.json に初回失敗を記録し、次回実行時に24時間以上あけて再度
 *   同様に失敗した場合にのみ削除する（2段階確認）。
 *
 * 使い方:
 *   node verify-links.js                 本番実行（agents.json を書き換え、削除ログを出力）
 *   node verify-links.js --dry-run        実際には書き込まず、結果集計のみ表示
 *   node verify-links.js --limit=20       先頭N件（featured除く）のみ対象にする（動作確認用）
 *   node verify-links.js --sample=50      対象全体からランダムにN件抽出する（動作確認用、--limitと排他）
 */

const fs = require('fs');
const path = require('path');

const { politeDelay } = require('./lib/http');
const { verifyLink } = require('./lib/link-check');
const { buildFaviconUrl } = require('./structure');

const ROOT = path.join(__dirname, '..');
const AGENTS_PATH = path.join(ROOT, 'agents.json');
const REMOVED_LOG_PATH = path.join(ROOT, 'data', 'removed-agents-log.json');
const PENDING_PATH = path.join(ROOT, 'data', 'link-check-pending.json');
const REPORT_PATH = path.join(ROOT, 'data', 'link-check-report.json');

const RECHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24時間

// mhlw「人材サービス総合サイト」の詳細ページのホスト名。website がこのホストを含む場合、
// 自社サイトを持たず structure.js が detailUrl にフォールバックしただけと判断する。
const MHLW_PORTAL_HOST = 'jinzai.hellowork.mhlw.go.jp';

function isNoCompanyWebsite(agent) {
  return typeof agent.website === 'string' && agent.website.includes(MHLW_PORTAL_HOST);
}

// 2段階確認（pending）の対象となるカテゴリ。それ以外の失敗系（http_403/http_other）は
// 「サーバーは生きて応答している」ため、確認回数によらず削除対象にしない。
const PENDING_ELIGIBLE_CATEGORIES = new Set(['dns_failure', 'connection_error']);

function parseArgs(argv) {
  const args = { dryRun: false, limit: null, sample: null };
  for (const raw of argv) {
    if (raw === '--dry-run') args.dryRun = true;
    else if (raw.startsWith('--limit=')) args.limit = parseInt(raw.slice('--limit='.length), 10);
    else if (raw.startsWith('--sample=')) args.sample = parseInt(raw.slice('--sample='.length), 10);
  }
  return args;
}

/** Fisher-Yatesで先頭N件をランダム抽出する（--sample用、動作確認目的なのでシード固定は不要）。 */
function randomSample(array, n) {
  const copy = array.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(n, copy.length));
}

/** 新499件（8e57ed7以降にassembleEntryを通過）は featured/affiliateUrl フィールドを持つが、
 * 旧562件（rawHashキャッシュでreuseされ続けているエントリ）は持たない。この差分を利用して
 * サンプルテストの内訳を「旧データ / 新データ」でタグ付けするための簡易判定。 */
function eraTag(agent) {
  return 'featured' in agent ? 'new' : 'old';
}

/** stripProtocol と同じ正規化（structure.js と保存形式を揃える）。 */
function stripProtocol(url) {
  if (!url) return null;
  return url.replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/#$/, '');
}

function loadJsonIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.warn(`Failed to parse ${filePath}: ${err.message}. Starting fresh.`);
    return fallback;
  }
}

async function main() {
  const { dryRun, limit, sample } = parseArgs(process.argv.slice(2));

  const agents = JSON.parse(fs.readFileSync(AGENTS_PATH, 'utf8'));
  const pending = loadJsonIfExists(PENDING_PATH, {}); // { [agentId]: { id, name, website, category, firstFailedAt, lastCheckedAt } }

  const targets = [];
  const skippedFeatured = [];
  const noCompanyWebsiteAgents = [];
  for (const agent of agents) {
    if (agent.featured === true) skippedFeatured.push(agent);
    else if (isNoCompanyWebsite(agent)) noCompanyWebsiteAgents.push(agent);
    else targets.push(agent);
  }

  let checkList;
  if (sample) checkList = randomSample(targets, sample);
  else if (limit) checkList = targets.slice(0, limit);
  else checkList = targets;

  const jesraCount = targets.filter(a => a.source === 'jesra').length;
  const mhlwCheckableCount = targets.filter(a => a.source === 'mhlw').length;
  console.log(
    `Checking ${checkList.length} of ${targets.length} checkable agent(s) ` +
      `(jesra=${jesraCount}, mhlw-with-own-site=${mhlwCheckableCount})` +
      (limit ? ` (--limit=${limit})` : '') +
      (sample ? ` (--sample=${sample}, random)` : '') +
      `; ${skippedFeatured.length} featured skipped, ${noCompanyWebsiteAgents.length} no_company_website skipped.` +
      (dryRun ? ' [dry-run]' : '')
  );

  const removedIds = new Set();
  const removedEntries = [];
  const updatedWebsites = [];
  const counts = {
    alive: 0,
    invalid_url: 0,
    http_403: 0,
    http_other: 0,
    http_404_deleted: 0,
    pending_first_strike: 0,
    pending_confirmed_deleted: 0,
    pending_too_soon: 0,
  };
  const now = Date.now();
  const eraTally = { old: {}, new: {} }; // 旧562件 / 新499件 別のカテゴリ内訳（サンプル検証用）

  for (let i = 0; i < checkList.length; i++) {
    const agent = checkList[i];
    const era = eraTag(agent);
    const label = `${agent.name || agent.id} [${era}]`;
    const result = await verifyLink(agent.website);
    const prefix = `[${i + 1}/${checkList.length}]`;

    eraTally[era][result.category] = (eraTally[era][result.category] || 0) + 1;

    if (result.category === 'invalid_url') {
      counts.invalid_url += 1;
      console.log(`${prefix} SKIP invalid_url (data issue, not a link-check target) ${label} <${agent.website}>`);
    } else if (result.category === 'alive') {
      counts.alive += 1;
      // 復帰したら pending 記録は消す
      if (pending[agent.id]) delete pending[agent.id];
      agent.linkVerified = true;
      agent.lastLinkCheckAt = new Date(now).toISOString();
      if (result.redirected && result.finalUrl) {
        const normalized = stripProtocol(result.finalUrl);
        if (normalized && normalized !== agent.website) {
          updatedWebsites.push({ id: agent.id, name: label, from: agent.website, to: normalized });
          agent.website = normalized;
          const newFavicon = buildFaviconUrl(result.finalUrl);
          if (newFavicon && newFavicon !== agent.faviconUrl) {
            agent.faviconUrl = newFavicon;
          }
        }
      }
      console.log(`${prefix} OK   status=${result.status ?? '-'}${result.redirected ? ' (redirected)' : ''} ${label} <${agent.website}>`);
    } else if (result.category === 'http_403') {
      counts.http_403 += 1;
      console.log(`${prefix} SKIP http_403 (likely bot-blocked, treated as alive) ${label} <${agent.website}>`);
    } else if (result.category === 'http_other') {
      counts.http_other += 1;
      console.log(`${prefix} SKIP http_other status=${result.status ?? '-'} (server responding, ambiguous) ${label} <${agent.website}>`);
    } else if (result.category === 'http_404') {
      counts.http_404_deleted += 1;
      removedIds.add(agent.id);
      removedEntries.push({
        id: agent.id,
        name: agent.name,
        website: agent.website,
        reason: 'http_404',
        checkedAt: new Date(now).toISOString(),
      });
      if (pending[agent.id]) delete pending[agent.id];
      console.log(`${prefix} DEAD http_404 (immediate delete) ${label} <${agent.website}>`);
    } else if (PENDING_ELIGIBLE_CATEGORIES.has(result.category)) {
      const prior = pending[agent.id];
      if (!prior) {
        pending[agent.id] = {
          id: agent.id,
          name: agent.name,
          website: agent.website,
          category: result.category,
          firstFailedAt: new Date(now).toISOString(),
          lastCheckedAt: new Date(now).toISOString(),
        };
        counts.pending_first_strike += 1;
        agent.linkVerified = false;
        agent.lastLinkCheckAt = new Date(now).toISOString();
        console.log(`${prefix} PEND ${result.category} (1st failure, recorded) ${label} <${agent.website}>`);
      } else {
        const elapsed = now - new Date(prior.firstFailedAt).getTime();
        if (elapsed >= RECHECK_INTERVAL_MS) {
          counts.pending_confirmed_deleted += 1;
          removedIds.add(agent.id);
          removedEntries.push({
            id: agent.id,
            name: agent.name,
            website: agent.website,
            reason: `${result.category} (confirmed twice: ${prior.firstFailedAt} and ${new Date(now).toISOString()})`,
            checkedAt: new Date(now).toISOString(),
          });
          delete pending[agent.id];
          console.log(`${prefix} DEAD ${result.category} (2nd failure ${Math.round(elapsed / 3600000)}h later, delete) ${label} <${agent.website}>`);
        } else {
          counts.pending_too_soon += 1;
          prior.lastCheckedAt = new Date(now).toISOString();
          console.log(`${prefix} PEND ${result.category} (still within 24h of 1st failure, not yet confirmed) ${label} <${agent.website}>`);
        }
      }
    } else {
      // 未分類の category が来た場合の保険（現行の分類漏れがあれば気付けるように）。
      counts.http_other += 1;
      console.warn(`${prefix} WARN unrecognized category "${result.category}" treated as http_other for ${label} <${agent.website}>`);
    }

    if (i < checkList.length - 1) await politeDelay();
  }

  console.log(
    `\nDone. alive=${counts.alive} invalid_url=${counts.invalid_url} http_403=${counts.http_403} ` +
      `http_other=${counts.http_other} http_404_deleted=${counts.http_404_deleted} ` +
      `pending_first_strike=${counts.pending_first_strike} pending_too_soon=${counts.pending_too_soon} ` +
      `pending_confirmed_deleted=${counts.pending_confirmed_deleted} redirected-and-updated=${updatedWebsites.length}`
  );
  console.log(`Total deleted this run: ${removedIds.size}`);
  console.log(
    `By era — old(pre-8e57ed7, no featured field): ${JSON.stringify(eraTally.old)} | ` +
      `new(post-8e57ed7): ${JSON.stringify(eraTally.new)}`
  );
  console.log(`no_company_website (skipped entirely, no request sent): ${noCompanyWebsiteAgents.length}`);

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(
    REPORT_PATH,
    JSON.stringify(
      {
        generatedAt: new Date(now).toISOString(),
        dryRun,
        checked: checkList.length,
        counts,
        noCompanyWebsite: {
          count: noCompanyWebsiteAgents.length,
          reason: `website が ${MHLW_PORTAL_HOST} の詳細ページURL（自社サイトを持たないmhlw由来エージェントのフォールバック値）のため、verifyLink() の対象外とした`,
          ids: noCompanyWebsiteAgents.map(a => a.id),
        },
      },
      null,
      2
    ) + '\n',
    'utf8'
  );
  console.log(`Wrote ${path.relative(ROOT, REPORT_PATH)}`);

  if (dryRun) {
    console.log('[dry-run] agents.json / removed-agents-log.json / link-check-pending.json were not modified.');
    return;
  }

  const agentsChanged = removedIds.size > 0 || updatedWebsites.length > 0 || counts.alive > 0 || counts.pending_first_strike > 0;
  if (agentsChanged) {
    const remaining = removedIds.size > 0 ? agents.filter(a => !removedIds.has(a.id)) : agents;
    fs.writeFileSync(AGENTS_PATH, JSON.stringify(remaining, null, 2) + '\n', 'utf8');
  }

  if (removedEntries.length > 0) {
    const existingLog = loadJsonIfExists(REMOVED_LOG_PATH, []);
    const combinedLog = existingLog.concat(removedEntries);
    fs.mkdirSync(path.dirname(REMOVED_LOG_PATH), { recursive: true });
    fs.writeFileSync(REMOVED_LOG_PATH, JSON.stringify(combinedLog, null, 2) + '\n', 'utf8');
    console.log(`Removed ${removedIds.size} agent(s) from agents.json. Logged to ${path.relative(ROOT, REMOVED_LOG_PATH)}.`);
  }

  fs.mkdirSync(path.dirname(PENDING_PATH), { recursive: true });
  fs.writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2) + '\n', 'utf8');

  if (!agentsChanged && removedEntries.length === 0) {
    console.log('No changes needed.');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
