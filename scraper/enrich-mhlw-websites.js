'use strict';

/**
 * MHLW「人材サービス総合サイト」由来のエージェント（agents.json内 source==="mhlw"）は、
 * 厚労省の元データ自体に会社の公式サイトURL項目が存在しないため、1社も faviconUrl を
 * 持たない（website はMHLW詳細ページURL自身へのフォールバック）。
 *
 * このスクリプトは、公式サイトのドメインをAI（Claude Haiku）に推定させたうえで、
 * 実際にそのURLへアクセスしてページ本文に会社名が含まれるかを機械的に照合し、
 * 一致した場合のみ website / faviconUrl を設定する。
 *
 * 【安全設計】AIの推測は無条件に信用しない。誤ったドメインを採用すると、実在の
 * 別会社のロゴを無関係なエージェントに表示してしまう信用毀損リスクがあるため、
 * 必ず lib/website-enrich.js の inferCompanyDomain（確信が持てなければ必ずnullを返す）
 * → verifyDomainMatch（実際にHTTPアクセスして会社名を照合）の2段階を経る。
 * 一致しなかった場合（AIがnullを返した場合を含む）は data/mhlw-website-skip.json に
 * 記録し、次回以降のバッチで再試行しない（無駄なAPI呼び出し・fetchを避けるため）。
 * AI呼び出し自体が例外で失敗した場合（レート制限・ネットワーク等の一時的な問題）は
 * スキップリストに記録せず、次回実行時に再試行する。
 *
 * - 1回の実行（1日1回、日次ワークフロー内）につき処理件数の上限は
 *   lib/website-enrich.js の DAILY_ENRICH_LIMIT 件まで（1箇所で調整可能）。
 * - 進捗は data/mhlw-website-enrich-cursor.json に累計件数として記録する
 *   （候補の抽出自体は毎回 source==="mhlw" && !faviconUrl && スキップリスト未登録、
 *   のフィルタで決まるため、位置的なカーソルではなくidベースのスキップリストで
 *   実質的な「前回どこまで処理したか」を管理する）。
 */

const fs = require('fs');
const path = require('path');

const { politeDelay } = require('./lib/http');
const { DAILY_ENRICH_LIMIT, companyNameCore, inferCompanyDomain, verifyDomainMatch } = require('./lib/website-enrich');
const { stripProtocol, buildFaviconUrl } = require('./structure');

const AGENTS_PATH = path.join(__dirname, '..', 'agents.json');
const MHLW_RAW_PATH = path.join(__dirname, '..', 'data', 'mhlw-agents.json');
const SKIP_PATH = path.join(__dirname, '..', 'data', 'mhlw-website-skip.json');
const CURSOR_PATH = path.join(__dirname, '..', 'data', 'mhlw-website-enrich-cursor.json');

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('ANTHROPIC_API_KEY is not set — skipping MHLW website enrichment (no safe non-AI fallback exists for domain inference).');
    return;
  }
  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey });

  const agents = readJson(AGENTS_PATH, []);
  const mhlwRawByPermit = new Map(readJson(MHLW_RAW_PATH, []).map(r => [r.permitNumber, r]));
  const skipList = readJson(SKIP_PATH, {});
  const cursor = readJson(CURSOR_PATH, { totalAttempted: 0, totalMatched: 0, totalSkipped: 0, lastRunAt: null });

  const allTargets = agents.filter(a => a.source === 'mhlw' && !a.faviconUrl && !skipList[a.id]);

  const candidates = [];
  let missingRawData = 0;
  for (const agent of allTargets) {
    const permitNumber = agent.companyDetail && agent.companyDetail.permitNumber;
    const raw = permitNumber ? mhlwRawByPermit.get(permitNumber) : null;
    if (!raw) {
      missingRawData += 1; // data/mhlw-agents.json 側にまだ無い等、一時的な事情の可能性があるためスキップリストには入れない
      continue;
    }
    candidates.push({ agent, raw });
  }
  candidates.sort((a, b) => (a.agent.id < b.agent.id ? -1 : a.agent.id > b.agent.id ? 1 : 0));

  const batch = candidates.slice(0, DAILY_ENRICH_LIMIT);
  console.log(
    `MHLW website enrichment: ${allTargets.length} agent(s) without faviconUrl (skip-list excluded), ` +
      `${candidates.length} with usable raw data (missingRawData=${missingRawData}), ` +
      `processing ${batch.length} this run (dailyLimit=${DAILY_ENRICH_LIMIT}).`
  );

  let matchedCount = 0;
  let skippedCount = 0;
  let aiErrorCount = 0;

  for (let i = 0; i < batch.length; i++) {
    const { agent, raw } = batch[i];
    const prefix = `[${i + 1}/${batch.length}]`;
    const facts = {
      businessOwnerName: raw.businessOwnerName,
      establishmentName: raw.establishmentName,
      address: raw.address,
      handledOccupations: raw.handledOccupations,
    };
    const nameCore = companyNameCore(raw.businessOwnerName || agent.name);
    const now = new Date().toISOString();

    let domain;
    try {
      domain = await inferCompanyDomain(facts, anthropic);
    } catch (err) {
      // AI呼び出し自体の失敗（レート制限・ネットワーク等）は「確信が持てない」判定とは別物なので、
      // スキップリストには入れず次回再試行する。
      aiErrorCount += 1;
      console.warn(`${prefix} AI call failed for ${agent.id} (${agent.name}): ${err.message}. Will retry next run.`);
      continue;
    }

    if (!domain) {
      skipList[agent.id] = { reason: 'ai_null', checkedAt: now, aiDomain: null };
      skippedCount += 1;
      console.log(`${prefix} SKIP ai_null (AI did not have confident knowledge) ${agent.id} ${agent.name}`);
      continue;
    }

    const result = await verifyDomainMatch(domain, nameCore);
    await politeDelay();

    if (result.matched) {
      agent.website = stripProtocol(`https://${domain}`);
      agent.faviconUrl = buildFaviconUrl(`https://${domain}`);
      matchedCount += 1;
      console.log(`${prefix} MATCH ${agent.id} ${agent.name} -> ${domain}`);
    } else {
      skipList[agent.id] = {
        reason: result.reason,
        checkedAt: now,
        aiDomain: domain,
        ...(result.error ? { error: result.error } : {}),
      };
      skippedCount += 1;
      console.log(`${prefix} SKIP ${result.reason} ${agent.id} ${agent.name} -> ${domain} (name "${nameCore}" not confirmed on page)`);
    }
  }

  if (matchedCount > 0) {
    writeJson(AGENTS_PATH, agents);
  }
  if (skippedCount > 0) {
    writeJson(SKIP_PATH, skipList);
  }

  const nextCursor = {
    totalAttempted: cursor.totalAttempted + matchedCount + skippedCount,
    totalMatched: cursor.totalMatched + matchedCount,
    totalSkipped: cursor.totalSkipped + skippedCount,
    lastRunAt: new Date().toISOString(),
  };
  writeJson(CURSOR_PATH, nextCursor);

  console.log(
    `MHLW website enrichment finished this run: matched=${matchedCount}, skipped=${skippedCount}, ` +
      `aiCallErrors=${aiErrorCount} (will retry), cumulativeTotals=${JSON.stringify(nextCursor)}`
  );
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main };
