'use strict';

/**
 * 一時的な再検証スクリプト: data/agent-discover-skip.json 内の、verifyCandidate() の
 * 恒久修正（コミット0a86e0b: ブラウザUA・ルートドメインフォールバック・括弧分割
 * 名称照合の追加）より前に checkedAt が記録されたエントリを、現在の verifyCandidate()
 * で再検証する。
 *
 * - ok:true に転じた候補は、discover-agents.js と同じ手順（assembleDiscoveredEntry・
 *   nextId をそのまま再利用）で agents.json に新規追加し、スキップリストから除去する。
 * - 依然として ok:false の候補は、reason・checkedAt を更新してスキップリストに残す。
 *
 * 実行後は削除して構わない一回限りのスクリプト。
 *
 * 使い方: node reverify-old-skips.js [--dry-run]
 *   --dry-run: agents.json・categories.json・スキップリストへの書き込みを行わず、
 *              結果集計のみ表示する（ANTHROPIC_API_KEYが無い場合は書き込み自体
 *              行われないため、--dry-runを付けなくても安全に実行できる）。
 */

const fs = require('fs');
const path = require('path');

const { verifyCandidate, buildDiscoveredAgentFields, getAnthropicClient } = require('./lib/agent-discovery');
const { topCategoryHints } = require('./structure');
const { promoteCategories } = require('./promote-categories');
const { assembleDiscoveredEntry, nextId } = require('./discover-agents');

const AGENTS_PATH = path.join(__dirname, '..', 'agents.json');
const CATEGORIES_PATH = path.join(__dirname, '..', 'categories.json');
const SKIP_PATH = path.join(__dirname, '..', 'data', 'agent-discover-skip.json');

/** verifyCandidate()の恒久修正コミット(0a86e0b)の日時。これより前のcheckedAtを再検証対象とする。 */
const FIX_CUTOFF = new Date('2026-09-05T10:46:43.000Z');

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const skipList = readJson(SKIP_PATH, {});
  const targets = Object.entries(skipList).filter(([, v]) => new Date(v.checkedAt) < FIX_CUTOFF);

  console.log(`再検証対象: ${targets.length}件（checkedAtが${FIX_CUTOFF.toISOString()}より前）`);

  const agents = readJson(AGENTS_PATH, []);
  let nextIdNum = nextId(agents);
  const existingHints = topCategoryHints(agents);

  const rescued = [];
  const stillSkipped = [];

  for (const [name, entry] of targets) {
    const candidate = { name, website: entry.website };
    console.log(`\n検証中: ${name} <${entry.website}>`);
    const verification = await verifyCandidate(candidate);
    if (verification.ok) {
      console.log(`  → 実在確認OK（verifiedUrl=${verification.verifiedUrl}${verification.thinContent ? ', thinContent' : ''}）`);
      rescued.push({ name, candidate, verification });
    } else {
      console.log(`  → 依然としてNG（reason=${verification.reason}）`);
      stillSkipped.push({ name, entry, verification });
    }
  }

  console.log('\n=== 再検証サマリー（実在照合のみ） ===');
  console.log(`対象: ${targets.length}件`);
  console.log(`実在確認OKに転じた: ${rescued.length}件`);
  console.log(`依然としてNG: ${stillSkipped.length}件`);
  if (rescued.length > 0) {
    console.log('救済候補一覧:');
    rescued.forEach(r => console.log(`  - ${r.name} -> ${r.verification.verifiedUrl}`));
  }

  if (rescued.length === 0) {
    console.log('\n救済対象が無いため、agents.json / スキップリストへの書き込みは行いません。');
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log(
      '\nANTHROPIC_API_KEY が設定されていないため、AI構造化・ファイル書き込みは行いません' +
        '（実在照合の結果のみの確認モード）。本番環境（GitHub Actions等）で再実行してください。'
    );
    return;
  }

  const anthropic = getAnthropicClient();
  const now = new Date().toISOString();
  let added = 0;

  for (const { name, candidate, verification } of rescued) {
    console.log(`Structuring rescued candidate: ${name} <${candidate.website}>`);
    let ai;
    try {
      ai = await buildDiscoveredAgentFields(candidate, verification.pageText, anthropic, existingHints);
    } catch (err) {
      console.warn(`  Structuring failed for ${name}: ${err.message}. Will retry next run.`);
      continue;
    }

    const id = nextIdNum++;
    const newEntry = assembleDiscoveredEntry(candidate, ai, id, verification.verifiedUrl);
    agents.push(newEntry);
    added += 1;
    delete skipList[name];
    console.log(`  ADDED as id=${newEntry.id}, category=${newEntry.category}`);
  }

  for (const { name, entry, verification } of stillSkipped) {
    skipList[name] = {
      name,
      website: entry.website,
      reason: verification.reason,
      checkedAt: now,
    };
  }

  if (dryRun) {
    console.log('\n[dry-run] agents.json / categories.json / スキップリストへの書き込みはスキップしました。');
    return;
  }

  if (added > 0) {
    writeJson(AGENTS_PATH, agents);
    const categories = readJson(CATEGORIES_PATH, []);
    const result = promoteCategories(agents, categories);
    if (result.promotedNames.length > 0 || result.reclassifiedCount > 0) {
      writeJson(AGENTS_PATH, agents);
      writeJson(CATEGORIES_PATH, categories);
    }
  }
  writeJson(SKIP_PATH, skipList);

  console.log(`\n完了: ${added}件をagents.jsonに追加、${stillSkipped.length}件をスキップリストに残しました。`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main, FIX_CUTOFF };
