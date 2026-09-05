'use strict';

/**
 * 厚生労働省「人材サービス総合サイト」から、全国の職業紹介事業者を段階的に取り込む。
 *
 * - 47都道府県を順に検索し、1回の実行につき処理する詳細ページ数は
 *   lib/mhlw.js の DAILY_DETAIL_LIMIT 件まで（1箇所で調整可能）。
 * - どの都道府県の何ページ目まで処理したかを data/mhlw-cursor.json に保存し、
 *   次回実行時はそこから再開する（同ファイルはリポジトリにコミットして永続化）。
 * - 取得した生データは data/mhlw-agents.json に許可番号キーで蓄積する
 *   （jesra側の data/raw-agents.json のように毎回まるごと上書きするのではなく、
 *   全国分を何日もかけて積み上げていく前提のため。同一許可番号は上書き更新）。
 * - 手数料・返戻金制度は今回取得しない（agents.json化の際は非公開のまま）。
 * - 日曜22:00〜月曜08:00 (JST) のメンテナンス時間帯は処理をスキップする
 *   （jesra側のスクレイピングには影響しない・このスクリプトのみ対象）。
 *
 * 【周回（サイクル）の考え方】
 * - cycle 1（初回サイクル）: 新規獲得優先。既存 agents.json / data/mhlw-agents.json に
 *   無い許可番号のみ詳細ページを取得する（既知のものは再訪問しない）。
 * - 全都道府県の最終ページまで処理し終えた時点で「1巡完了」とし、
 *   その周で一度も検出されなかった許可番号（＝廃業/許可取消等の可能性）を
 *   agents.json / data/mhlw-agents.json から削除したうえで cycle をインクリメントし、
 *   cursor を最初の都道府県・1ページ目にリセットする。
 * - cycle >= 2 では、既知の許可番号でもスキップせず毎回詳細ページを取得し直す。
 *   取得した内容は許可番号キーで data/mhlw-agents.json に上書き保存するだけで、
 *   実際に構造化AIを再実行するかどうかは structure.js 側の既存のハッシュ比較
 *   （_rawHash の差分検知）にすべて委ねる（ここでは再実装しない）。
 */

const fs = require('fs');
const path = require('path');

const mhlw = require('./lib/mhlw');
const { politeDelayMhlw } = mhlw;

const AGENTS_PATH = path.join(__dirname, '..', 'agents.json');
const MHLW_RAW_PATH = path.join(__dirname, '..', 'data', 'mhlw-agents.json');
const CURSOR_PATH = path.join(__dirname, '..', 'data', 'mhlw-cursor.json');
const CYCLE_SEEN_PATH = path.join(__dirname, '..', 'data', 'mhlw-cycle-seen.json');

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function loadCursor() {
  const cursor = readJson(CURSOR_PATH, { prefectureIndex: 0, page: 1, totalProcessed: 0, cycle: 1 });
  if (!cursor.cycle) cursor.cycle = 1; // 旧形式（cycle未記録）からの後方互換
  delete cursor.completed; // 旧形式の「完了したら永久停止」フラグはもう使わない
  return cursor;
}

function loadExistingPermitNumbers() {
  const set = new Set();
  const agents = readJson(AGENTS_PATH, []);
  for (const a of agents) {
    const p = a.companyDetail && a.companyDetail.permitNumber;
    if (p) set.add(p);
  }
  const mhlwRaw = readJson(MHLW_RAW_PATH, []);
  for (const r of mhlwRaw) {
    if (r.permitNumber) set.add(r.permitNumber);
  }
  return set;
}

/** newRecords を許可番号キーで既存の生データにupsertする（同一許可番号は上書き）。 */
function upsertMhlwRaw(newRecords) {
  const existing = readJson(MHLW_RAW_PATH, []);
  const byPermit = new Map(existing.map(r => [r.permitNumber, r]));
  for (const rec of newRecords) {
    byPermit.set(rec.permitNumber, rec);
  }
  writeJson(MHLW_RAW_PATH, [...byPermit.values()]);
}

/**
 * 1巡完了時の後処理。今回のサイクルで一度も検出されなかった許可番号を持つ
 * MHLW由来のエントリを agents.json / data/mhlw-agents.json から削除する。
 * 戻り値は削除件数。
 */
function pruneStaleMhlwEntries(cycleSeen) {
  const agents = readJson(AGENTS_PATH, []);
  const stale = agents.filter(
    a => a.source === 'mhlw' && a.companyDetail && a.companyDetail.permitNumber && !cycleSeen.has(a.companyDetail.permitNumber)
  );
  if (stale.length > 0) {
    const staleIds = new Set(stale.map(a => a.id));
    const stalePermits = new Set(stale.map(a => a.companyDetail.permitNumber));

    const prunedAgents = agents.filter(a => !staleIds.has(a.id));
    writeJson(AGENTS_PATH, prunedAgents);

    const mhlwRaw = readJson(MHLW_RAW_PATH, []);
    const prunedRaw = mhlwRaw.filter(r => !stalePermits.has(r.permitNumber));
    writeJson(MHLW_RAW_PATH, prunedRaw);
  }
  return stale.length;
}

async function main() {
  if (mhlw.isInMhlwMaintenanceWindow()) {
    console.log(
      'Current time is within the MHLW weekly maintenance window (Sun 22:00 - Mon 08:00 JST). ' +
        'Skipping MHLW ingestion this run (jesra scraping is unaffected).'
    );
    return;
  }

  const cursor = loadCursor();
  const isFirstCycle = cursor.cycle === 1;
  const existingPermitNumbers = loadExistingPermitNumbers(); // cycle 1 のスキップ判定にのみ使う
  const cycleSeen = new Set(readJson(CYCLE_SEEN_PATH, []));

  const seenThisRun = new Set();
  const newRecords = [];
  let skippedBranchCount = 0;
  let skippedAlreadyKnownCount = 0;

  const session = mhlw.createSession();
  let prefIndex = cursor.prefectureIndex;
  let resumePage = cursor.page;

  console.log(
    `Starting MHLW ingestion: cycle=${cursor.cycle} (${isFirstCycle ? 'first cycle, skip known permits' : 'revisit cycle, refetch known permits'}), ` +
      `prefectureIndex=${prefIndex} (${mhlw.PREFECTURES[prefIndex]?.name}), page=${resumePage}, ` +
      `dailyLimit=${mhlw.DAILY_DETAIL_LIMIT}, totalProcessedSoFar=${cursor.totalProcessed}`
  );

  outer: while (prefIndex < mhlw.PREFECTURES.length) {
    const pref = mhlw.PREFECTURES[prefIndex];
    console.log(`[${pref.name}] searching...`);
    let { $, totalCount } = await mhlw.searchPrefecture(session, pref.field);
    const totalPages = Math.ceil(totalCount / mhlw.RESULTS_PER_PAGE);
    console.log(`[${pref.name}] totalCount=${totalCount} totalPages=${totalPages} startingAtPage=${resumePage}`);

    if (resumePage > 1) {
      await politeDelayMhlw();
      $ = await mhlw.gotoResultPage(session, $, resumePage);
    }

    for (let page = resumePage; page <= totalPages; page++) {
      if (page > resumePage) {
        await politeDelayMhlw();
        $ = await mhlw.gotoResultPage(session, $, page);
      }

      const rows = mhlw.extractResultRows($);
      for (const row of rows) {
        if (!row.permitNumber) continue;

        // この許可番号が今サイクルの巡回で実際に検出されたことを記録する。
        // （既知としてスキップする場合も、詳細取得に失敗した場合も、
        //   検索結果に「行として存在した」事実自体は変わらないので必ず記録する）
        cycleSeen.add(row.permitNumber);

        if (seenThisRun.has(row.permitNumber)) {
          skippedBranchCount += 1;
          continue;
        }

        if (isFirstCycle && existingPermitNumbers.has(row.permitNumber)) {
          skippedAlreadyKnownCount += 1;
          continue;
        }

        if (newRecords.length >= mhlw.DAILY_DETAIL_LIMIT) {
          // 今日の上限に達した。このページの途中で止まった場合、次回はこのページから
          // 再開する（cycle 1 では既に取り込んだ許可番号は dedup で自動的にスキップされる）。
          resumePage = page;
          break outer;
        }

        await politeDelayMhlw();
        try {
          const html = await session.get(row.detailUrl);
          const fields = mhlw.extractDetailFields(html);
          seenThisRun.add(row.permitNumber);
          newRecords.push({
            ...fields,
            prefecture: pref.name,
            detailUrl: row.detailUrl,
            fetchedAt: new Date().toISOString(),
          });
          console.log(`  [${newRecords.length}/${mhlw.DAILY_DETAIL_LIMIT}] ${fields.permitNumber} ${fields.businessOwnerName}`);
        } catch (err) {
          console.warn(`  fetch failed for ${row.detailUrl}: ${err.message}`);
        }
      }
    }

    // この都道府県を最後まで処理し終えた（上限に達さず outer を抜けずに来た）
    console.log(`[${pref.name}] done.`);
    prefIndex += 1;
    resumePage = 1;
  }

  if (newRecords.length > 0) {
    upsertMhlwRaw(newRecords);
  }

  const cycleComplete = prefIndex >= mhlw.PREFECTURES.length;
  let nextCursor;
  let prunedCount = 0;

  if (cycleComplete) {
    prunedCount = pruneStaleMhlwEntries(cycleSeen);
    writeJson(CYCLE_SEEN_PATH, []); // 次サイクルの蓄積を0から開始
    nextCursor = {
      prefectureIndex: 0,
      page: 1,
      totalProcessed: cursor.totalProcessed + newRecords.length,
      cycle: cursor.cycle + 1,
    };
    console.log(
      `Cycle ${cursor.cycle} complete: pruned ${prunedCount} MHLW entries not re-confirmed this cycle. ` +
        `Starting cycle ${nextCursor.cycle} from the top.`
    );
  } else {
    writeJson(CYCLE_SEEN_PATH, [...cycleSeen]);
    nextCursor = {
      prefectureIndex: prefIndex,
      page: resumePage,
      totalProcessed: cursor.totalProcessed + newRecords.length,
      cycle: cursor.cycle,
    };
  }

  writeJson(CURSOR_PATH, nextCursor);

  console.log(
    `MHLW ingestion finished this run: newRecords=${newRecords.length}, ` +
      `skippedBranchDuplicates=${skippedBranchCount}, skippedAlreadyKnown=${skippedAlreadyKnownCount}, ` +
      `prunedStale=${prunedCount}, cursor=${JSON.stringify(nextCursor)}`
  );
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { loadCursor, loadExistingPermitNumbers, upsertMhlwRaw, pruneStaleMhlwEntries };
