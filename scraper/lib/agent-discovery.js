'use strict';

/**
 * 新規フリーランス向け案件紹介エージェント/サービスを、Claude(web_search)に発見させ、
 * 実際にそのサイトへHTTPアクセスして実在照合したうえで掲載候補として採用するための
 * 2段階パイプライン（図鑑4-2の教訓: AIの「実在する」という自己申告を無条件に
 * 信用しない）。
 *
 *   1段階目 discoverCandidates(): Claude API に web_search ツールで実際にWeb検索させ、
 *     既存に無い新規候補（会社名+公式サイトURL）のみを回答させる。
 *   2段階目 verifyCandidate(): 候補ごとに実際に公式サイトへHTTPリクエストを送り、
 *     取得できたページ本文に会社名（法人格を除いた主要部分）が実在するか機械的に
 *     照合する。一致しなければ不採用（呼び出し側でスキップリストに記録する）。
 *
 * companyNameCore（法人格の除去ロジック）は lib/website-enrich.js のものをそのまま
 * 再利用し、表記揺れの扱いを既存のMHLWサイト推定ロジックと揃える。
 */

const cheerio = require('cheerio');
const { politeDelay } = require('./http');
const { companyNameCore } = require('./website-enrich');
const { CATEGORIES } = require('./schema');

const DISCOVERY_MODEL = process.env.ANTHROPIC_DISCOVERY_MODEL || 'claude-sonnet-4-6';
const STRUCTURE_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

/** ANTHROPIC_API_KEY が無い場合は呼び出し時点で明確に例外を投げる（呼び出し側で分岐しやすくするため）。 */
function getAnthropicClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic({ apiKey });
}

/**
 * AIの応答テキストから、前後の説明文やコードフェンスを無視してJSON配列だけを
 * 堅牢に抽出する。最初の "[" から最後の "]" までを切り出してパースする方式。
 * 失敗した場合は空配列を返し、エラーをログ出力する。
 */
function extractJsonArray(text) {
  if (typeof text !== 'string') return [];
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    console.error('agent-discovery: AI応答からJSON配列を検出できませんでした:', text);
    return [];
  }
  const jsonSlice = text.slice(start, end + 1);
  let parsed;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch (err) {
    console.error('agent-discovery: JSON配列のパースに失敗しました:', err.message);
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.error('agent-discovery: パース結果が配列ではありません:', jsonSlice);
    return [];
  }
  return parsed.filter(c => c && typeof c.name === 'string' && typeof c.website === 'string');
}

/**
 * discoverCandidates() が検索クエリを分けるカテゴリー一覧。1回の実行で広いクエリを
 * 1本だけ投げると同じような候補ばかり見つかり頭打ちになりやすいため、分野ごとに
 * 軽量な検索呼び出しを複数回行い、カバレッジを広げる。
 *
 * サイト掲載用のカテゴリー分類（lib/schema.js の CATEGORIES、buildDiscoveredAgentFields
 * が使う）から動的に導出する（「その他」は具体的な検索クエリを組み立てようがないため除く）。
 * 以前は別々に定義しており2つの一覧がズレる問題があったため、CATEGORIESを唯一の
 * ソースとして一本化した。
 */
/**
 * 検索の切り口としてのみ追加するカテゴリー（掲載用のCATEGORIESには含めない）。
 * 「副業」「複業」文脈のサービス（例: 複業クラウド、シューマツワーカー等）は、実質的に
 * フリーランス向け案件マッチングと同じ業態のものが多く、過去の発見でも「その他」経由で
 * 見つかっていた。検索クエリの切り口を増やすためだけの用途であり、この名前自体が
 * agentのcategory値として使われることはない（buildDiscoveredAgentFieldsの分類先は
 * 引き続きCATEGORIES(9分類)のみ）。
 */
const EXTRA_SEARCH_ONLY_CATEGORIES = ['副業・複業マッチング'];

// CATEGORIES（掲載用9分類、「その他」を除く8分類）+ 検索専用の追加分。
// CATEGORIESが変わってもここを手で書き換える必要が無いよう、引き続き動的に導出する。
const SEARCH_CATEGORIES = [...CATEGORIES.filter(c => c !== 'その他'), ...EXTRA_SEARCH_ONLY_CATEGORIES];

/** 1カテゴリーあたりの検索呼び出しで、AIに提案させる候補数の上限（軽量な呼び出しに留めるため）。 */
const PER_CATEGORY_SEARCH_LIMIT = 5;

/**
 * 指定した1カテゴリーについてのみ、Claude API に web_search ツールで実際に検索させ、
 * 該当するフリーランス向け案件紹介・マッチングサービスの候補を返す（会社名+公式サイトURL）。
 * discoverCandidates() のカテゴリーループから呼ばれる、軽量な単位の検索呼び出し。
 */
async function searchCategoryCandidates(category, excludeNames) {
  const anthropic = getAnthropicClient();

  const response = await anthropic.messages.create({
    model: DISCOVERY_MODEL,
    max_tokens: 1500,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
    messages: [{
      role: 'user',
      content:
        `日本国内で、「${category}」分野を中心に、フリーランス(業務委託・準委任契約)向けに` +
        `案件紹介・マッチングを行っているエージェント/サービスを、Web検索を使って` +
        `実在するものだけ探してください。\n\n` +
        `対象は「フリーランス」向けに限定せず、会社員の「副業」「複業」向けの案件紹介・` +
        `マッチングサービスも含めてください（実質的にフリーランス向けと同じ業態のサービスが` +
        `多いため）。\n\n` +
        `除外リスト(既に掲載済み・既に他カテゴリーで見つかった、これらは含めない): ${excludeNames.join('、')}\n\n` +
        `条件:\n` +
        `- 検索で実在を確認できた企業のみ回答すること。知識だけで` +
        `  推測したり、実在確認ができない企業を創作しないこと\n` +
        `- 最大${PER_CATEGORY_SEARCH_LIMIT}件まで\n` +
        `- 個人ブログ・まとめ記事ではなく、エージェント/サービスを` +
        `  実際に運営する企業自体を対象にすること\n` +
        `- 「${category}」分野の案件を専門・得意とする、またはこの分野の案件も扱っている` +
        `  サービスを対象にすること（フリーランス向け・副業/複業向けのいずれでも可）\n\n` +
        `検索が終わったら、最後に必ず以下の形式のJSON配列のみを出力` +
        `してください(前後に説明文やコードフェンスを付けないこと)。\n` +
        `[{"name": "会社名", "website": "公式サイトURL"}, ...]\n` +
        `該当なしの場合は空配列[]を出力してください。`,
    }],
  });

  const textBlocks = response.content.filter(b => b.type === 'text');
  const lastText = textBlocks[textBlocks.length - 1];
  if (!lastText) {
    console.error(`agent-discovery: [${category}] AI応答にtextブロックが含まれていませんでした。`);
    return [];
  }
  return extractJsonArray(lastText.text);
}

/**
 * SEARCH_CATEGORIES を順番にループし、カテゴリーごとに searchCategoryCandidates() で
 * 発見した候補を、その場で verifyCandidate() まで通す（AIの「実在する」という自己申告を
 * 無条件に信用しない、という2段階方式の原則はここでも維持する）。
 *
 * - 見つかった候補はカテゴリーをまたいで重複させないよう、都度 excludeNames に追加する
 *   （このループ内で見つかった分も含む。呼び出し元から渡された既存分と合わせて管理）。
 * - 累計の実在照合成功数（verified.length）が maxCandidates に達したら、以降の
 *   カテゴリーの検索呼び出し自体をスキップして終了する（無駄なAPI呼び出しを避けるため）。
 *   上限到達後にそのカテゴリー内で他に見つかっていた候補も、照合(HTTP fetch)はスキップする。
 * - 内部の searchCategoryCandidates / verifyCandidate 呼び出しは、テストでの差し替え
 *   （モック）を可能にするため、必ず module.exports 経由（後述）で行う。
 *
 * 戻り値:
 *   {
 *     verified: [{ candidate, category, pageText }, ...],   // 実在照合まで通った候補
 *     skipped:  [{ candidate, category, reason }, ...],     // 不一致・fetch失敗した候補
 *     perCategory: [{ category, found, listed, skipped }, ...], // カテゴリー別の内訳
 *   }
 */
async function discoverCandidates(excludeNames, maxCandidates) {
  const excludeCores = new Set((excludeNames || []).map(n => companyNameCore(n)));
  const verified = [];
  const skipped = [];
  const perCategory = [];

  for (const category of SEARCH_CATEGORIES) {
    if (verified.length >= maxCandidates) {
      console.log(`agent-discovery: 上限(${maxCandidates}件)に到達したため、残りのカテゴリーの検索をスキップします。`);
      break;
    }

    let rawCandidates;
    try {
      rawCandidates = await module.exports.searchCategoryCandidates(category, [...excludeCores]);
    } catch (err) {
      console.warn(`agent-discovery: [${category}] Web検索呼び出しに失敗しました: ${err.message}`);
      perCategory.push({ category, found: 0, listed: 0, skipped: 0 });
      continue;
    }

    let found = 0;
    let listed = 0;
    let skippedInCategory = 0;

    for (const candidate of rawCandidates) {
      const core = companyNameCore(candidate.name);
      if (excludeCores.has(core)) continue; // 既存掲載・他カテゴリーとの重複
      excludeCores.add(core);
      found += 1;

      if (verified.length >= maxCandidates) {
        // 上限到達後は、同カテゴリー内の残り候補についても実在照合(HTTPリクエスト)を行わない。
        continue;
      }

      const verification = await module.exports.verifyCandidate(candidate);
      if (verification.ok) {
        verified.push({ candidate, category, pageText: verification.pageText, verifiedUrl: verification.verifiedUrl });
        listed += 1;
      } else {
        skipped.push({ candidate, category, reason: verification.reason });
        skippedInCategory += 1;
      }
    }

    perCategory.push({ category, found, listed, skipped: skippedInCategory });
    console.log(`agent-discovery: [${category}] 発見${found}件・掲載${listed}件・スキップ${skippedInCategory}件`);
  }

  return { verified, skipped, perCategory };
}

/**
 * verifyCandidate() 専用のUser-Agent。lib/http.js の共通USER_AGENT（jesra/mhlw等の
 * 政府系サイトを日次巡回する際に、ボットとして正直に名乗るためのもの）とは目的が異なる。
 * 診断の結果、正直なbot UAだと単純にブロックされて誤ってfetch_failedと判定される
 * 実在企業サイトが複数見つかったため、候補サイトの実在照合に限り、実ブラウザに近い
 * User-Agentを使う（政府系サイトの巡回ポリシーには影響しない、この関数専用の設定）。
 */
const VERIFY_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchWithVerifyUA(url, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': VERIFY_UA, 'Accept-Language': 'ja,en;q=0.5' },
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

/** candidate.website を https/http の順で1回ずつ試すためのURL候補を組み立てる（パスはそのまま維持）。 */
function candidateFetchUrls(website) {
  let url;
  try {
    url = new URL(website.includes('://') ? website : `https://${website}`);
  } catch {
    return [];
  }
  const urls = [url.toString()];
  if (url.protocol === 'https:') {
    const httpUrl = new URL(url.toString());
    httpUrl.protocol = 'http:';
    urls.push(httpUrl.toString());
  }
  return urls;
}

/**
 * candidateFetchUrls() のパス指定が404・DNS解決失敗等で使えなかった場合のフォール
 * バック用に、オリジン（スキーム+ホストのみ、パス・クエリを除いたトップページ）の
 * URL候補を組み立てる。診断の結果、AIが提示したURLがパス違い（削除済みLP等）や
 * サブドメイン・ドメイン表記違い（www.の有無、ハイフンの有無等）で、トップページ
 * 自体は正常に存在するケースが複数見つかったため。
 */
function candidateRootUrls(website) {
  let url;
  try {
    url = new URL(website.includes('://') ? website : `https://${website}`);
  } catch {
    return [];
  }
  // "www." の有無だけが違うホスト（例: www.pe-bank.co.jp は名前解決不可だが
  // pe-bank.co.jp は実在、というケースが診断で見つかったため）も併せて試す。
  const hosts = [url.host, url.host.startsWith('www.') ? url.host.slice(4) : `www.${url.host}`];
  const urls = [];
  for (const host of hosts) {
    urls.push(`${url.protocol}//${host}/`);
    if (url.protocol === 'https:') {
      urls.push(`http://${host}/`);
    }
  }
  return urls;
}

/**
 * 会社名を「欧文名（日本語通称）」のような括弧書き併記形式の場合に、括弧外・括弧内に
 * 分割する（例: "TECHBIZ（テックビズフリーランス）" → outside:"TECHBIZ",
 * inside:"テックビズフリーランス"）。全角・半角どちらの括弧にも対応する。
 * 括弧が無い通常の名前は outside にそのまま名前全体を入れ、inside は null とする。
 */
function splitName(name) {
  const m = String(name).match(/^([^（(]*)[（(]([^）)]*)[）)]\s*$/);
  if (m) {
    return { outside: m[1].trim(), inside: m[2].trim() };
  }
  return { outside: String(name).trim(), inside: null };
}

/**
 * 照合に使う「主要部分」の候補一覧を組み立てる。括弧書き併記の名前は、括弧外・括弧内
 * それぞれに companyNameCore（法人格除去）を適用したうえで別々の候補として返す。
 * ページ本文にどちらか一方でも含まれていれば一致とみなす（診断の結果、実在企業でも
 * 括弧内の日本語通称・括弧外の欧文社名のどちらか片方しかページに載っていないケースが
 * 複数あり、括弧込み全体を1つの文字列として要求するのは厳しすぎたため）。
 */
function candidateNameCores(name) {
  const { outside, inside } = splitName(name);
  const cores = [companyNameCore(outside)];
  if (inside) cores.push(companyNameCore(inside));
  return cores.filter(core => core && core.length >= 2);
}

/** 構造化AIのプロンプトに渡すページ本文抽出テキストの上限文字数。 */
const PAGE_TEXT_MAX_CHARS = 4000;

function buildPageText(rawBodyText) {
  return rawBodyText
    .replace(/[ \t　]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
    .slice(0, PAGE_TEXT_MAX_CHARS);
}

/**
 * urls を順番に試し、最初にfetchが成功したURLの内容で名称照合を行う（fetch自体が
 * 失敗した場合のみ次のURLへフォールバックする。lib/website-enrich.js の
 * verifyDomainMatch と同じ考え方）。全URLでfetchが失敗した場合は { error } を返す。
 */
async function tryUrlsForMatch(urls, nameCores) {
  let lastError = null;
  for (const url of urls) {
    await politeDelay();
    try {
      const html = await module.exports.fetchWithVerifyUA(url);
      const $ = cheerio.load(html);
      // script/styleの中身はページ本文ではないため、名寄せ照合・AIへの本文抽出のどちらからも除く。
      $('script, style, noscript').remove();
      const titleText = $('title').text();
      const rawBodyText = $('body').text();
      const matchText = `${titleText} ${rawBodyText}`.replace(/[\s　]+/g, '');
      const matched = nameCores.some(core => matchText.includes(core));
      return { matched, url, pageText: buildPageText(rawBodyText) };
    } catch (err) {
      lastError = err;
    }
  }
  return { error: lastError ? lastError.message : 'unknown error' };
}

/**
 * candidate.website へ実際にHTTPリクエストを送り、取得できたページ本文に
 * candidate.name（括弧内・括弧外それぞれ、法人格を除いた主要部分）が実在するかを
 * 機械的に照合する。
 *
 * 1. まず記録されたURL（パスそのまま、https→http）を試す。fetchに成功した時点で、
 *    名称が一致すれば ok:true、一致しなければ name_mismatch で確定する（この時点では
 *    ルートドメインへのフォールバックは行わない — パスが生きているなら、そのページの
 *    内容で判定するのが筋のため）。
 * 2. パスありの全URLでfetch自体が失敗した場合（404・DNS解決失敗・タイムアウト等）
 *    のみ、オリジン（トップページ）へフォールバックする。トップページでfetchに成功
 *    すれば、そこで改めて名称照合を行う。
 *
 * 一致した場合は、実際にアクセスできたURL（verifiedUrl。パス直アクセスかルート
 * フォールバックかで記録されたcandidate.websiteと異なる場合がある）と、後続の
 * buildDiscoveredAgentFields() に渡すための本文抽出テキスト（pageText）を返す。
 */
async function verifyCandidate(candidate) {
  const nameCores = candidateNameCores(candidate.name);
  if (nameCores.length === 0) {
    return { ok: false, reason: 'name_mismatch' };
  }

  const pathUrls = candidateFetchUrls(candidate.website);
  if (pathUrls.length === 0) {
    return { ok: false, reason: 'fetch_failed' };
  }

  const pathAttempt = await tryUrlsForMatch(pathUrls, nameCores);
  if (pathAttempt.matched !== undefined) {
    return pathAttempt.matched
      ? { ok: true, verifiedUrl: pathAttempt.url, pageText: pathAttempt.pageText }
      : { ok: false, reason: 'name_mismatch' };
  }

  const rootUrls = candidateRootUrls(candidate.website).filter(u => !pathUrls.includes(u));
  if (rootUrls.length === 0) {
    return { ok: false, reason: 'fetch_failed', error: pathAttempt.error };
  }

  const rootAttempt = await tryUrlsForMatch(rootUrls, nameCores);
  if (rootAttempt.matched !== undefined) {
    return rootAttempt.matched
      ? { ok: true, verifiedUrl: rootAttempt.url, pageText: rootAttempt.pageText }
      : { ok: false, reason: 'name_mismatch' };
  }

  return { ok: false, reason: 'fetch_failed', error: rootAttempt.error || pathAttempt.error };
}

/**
 * 実在照合済みの候補について、structure.js の buildWithAI と同じ
 * tool-forced パターン（CATEGORIES enum を強制し、未知のカテゴリーが
 * 返ってきた場合は「その他」に丸める安全策も同様）で、掲載用の
 * category/oneLiner/appeal等を生成する。raw scrape データを前提とする
 * buildWithAI 自体はfactsBlockの形が異なるため直接共有できないが、
 * CATEGORIES・カテゴリークランプ処理という「考え方」は踏襲している。
 * existingHints は structure.js の topCategoryHints() の戻り値をそのまま渡す想定。
 *
 * pageText には verifyCandidate() が実際に取得したページ本文抽出テキスト
 * （先頭 PAGE_TEXT_MAX_CHARS 文字）を渡す。会社名・URLだけの乏しい情報から
 * AIに「作文」させるのではなく、実際に取得した本文からの抽出・要約に基づいて
 * 生成させることで、内容の薄い「非公開」だらけの結果になることを防ぐ
 * （本文に記載が無い項目は正直に null/空配列/"unknown"を出力させる）。
 */
async function buildDiscoveredAgentFields(candidate, pageText, anthropic, existingHints = []) {
  const tool = {
    name: 'structure_discovered_agent',
    description:
      'フリーランス案件図鑑サイトのスキーマに沿って、Web検索で発見し実在照合済みの' +
      'サービスの公式サイト本文を、事実の抽出・要約として構造化する。',
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: CATEGORIES,
          description:
            `次の${CATEGORIES.length}個の文字列のいずれか一つを一字一句そのまま使うこと（新しいカテゴリ名を作らない）: ` +
            CATEGORIES.join('、') +
            '。ページ本文の内容から最も近いものを選び、確信が持てない場合は「その他」を使う。',
        },
        categoryHint: {
          type: 'string',
          description:
            'category が「その他」の場合のみ、日本語2〜6文字程度の簡潔なサブカテゴリー推定値を指定する。' +
            'category が「その他」以外の場合は省略する（このフィールドを呼び出しに含めない）。' +
            '既存の表記があれば新しい言い回しを作らず、可能な限りそのまま再利用すること。',
        },
        oneLiner: { type: 'string', description: 'フリーランスとして案件を探す側向けの一言キャッチコピー（30字前後、誇張・断定は避ける）' },
        companyOneLiner: { type: 'string', description: '案件を発注・掲載したい企業側向けの一言キャッチコピー（30字前後）' },
        appeal: {
          type: 'string',
          description:
            'ページ本文から読み取れる具体的な特徴を3〜5点相当盛り込んだ2〜3文程度の特徴説明。' +
            '案件を探すフリーランス側にとっての魅力という視点で書く。本文に記載の無い内容を創作しないこと。',
        },
        companyAppeal: {
          type: 'string',
          description:
            '1〜2文程度の特徴説明。appealとは視点を変え、発注・掲載したい企業側がこのサービスを' +
            '使う意味・強みという視点で書く。本文に記載の無い内容を創作しないこと。',
        },
        contractTypes: {
          type: 'array',
          items: { type: 'string' },
          description:
            'ページ本文から読み取れる契約形態（例: "業務委託", "準委任", "請負"）。' +
            '複数記載があれば全て列挙する。本文に記載が読み取れなければ空配列 [] とする（推測で埋めない）。',
        },
        remoteRatio: {
          type: ['string', 'null'],
          description:
            'ページ本文から読み取れるリモート対応度（例: "フルリモート対応", "一部リモート可", "常駐中心"）。' +
            '記載が読み取れなければ null とする（推測で埋めない）。',
        },
        feeStructure: {
          type: 'object',
          description: '手数料体系。ページ本文に記載があれば分類し、無ければ type:"unknown" とする。',
          properties: {
            type: {
              type: 'string',
              enum: ['margin', 'monthlyFixed', 'commission', 'unknown'],
              description:
                'margin=マージン制（仲介手数料を差し引いた額を支払う形態）、' +
                'monthlyFixed=月額固定制、commission=成果報酬制、' +
                'unknown=本文から手数料体系が読み取れない場合。',
            },
            note: {
              type: ['string', 'null'],
              description: '手数料体系に関する補足（具体的な料率・条件等）。本文に記載が無ければ null とする。',
            },
          },
          required: ['type', 'note'],
          additionalProperties: false,
        },
        freelancerCount: {
          type: ['string', 'null'],
          description:
            'ページ本文に登録フリーランス数・登録者数等の記載があれば、その数値・表現をそのまま抽出する。' +
            '記載が無ければ null とする（推測で埋めない）。',
        },
      },
      required: [
        'category', 'oneLiner', 'companyOneLiner', 'appeal', 'companyAppeal',
        'contractTypes', 'remoteRatio', 'feeStructure', 'freelancerCount',
      ],
      additionalProperties: false,
    },
  };

  const hintVocabLine =
    existingHints.length > 0
      ? '既存のカテゴリーヒント候補（categoryHint を出力する際は、可能な限りこの中の表記をそのまま使うこと）: ' +
        existingHints.join('、') + '\n'
      : '';

  const factsBlock = pageText && pageText.trim()
    ? `以下は、実際に取得した公式サイト（${candidate.website}）のページ本文です。\n\n${pageText}`
    : `公式サイトの本文を取得できませんでした。手がかりは会社名と公式サイトURLのみです。\n` +
      `会社名: ${candidate.name}\n公式サイト: ${candidate.website}`;

  const msg = await anthropic.messages.create({
    model: STRUCTURE_MODEL,
    max_tokens: 1200,
    tools: [tool],
    tool_choice: { type: 'tool', name: 'structure_discovered_agent' },
    messages: [{
      role: 'user',
      content:
        `以下は、Web検索により実在を確認できたフリーランス向け案件紹介・マッチングサービス` +
        `「${candidate.name}」の公式サイトの内容です。\n\n` +
        factsBlock +
        '\n\nこの本文の内容に基づいて structure_discovered_agent ツールを呼び出し、' +
        'フリーランス案件図鑑サイト用のデータを構造化してください。\n\n' +
        '厳守事項:\n' +
        '- creative作文ではなく、あくまで本文に実際に記載されている内容の抽出・要約であること。' +
        '本文に基づかない具体的な数値・条件・実績を創作しないこと。\n' +
        '- 本文に記載が無い項目は、正直に null（contractTypesなら空配列 []、feeStructure.typeなら' +
        '"unknown"）としてください。存在しない情報を推測で埋めないこと。\n' +
        '- appeal/companyAppealは、本文から読み取れる具体的で内容のある特徴を根拠に書くこと' +
        '（「特に情報なし」のような空虚な記述は避ける。ただし本文に手がかりが乏しい場合は無理に' +
        '誇張せず、読み取れる範囲で簡潔にまとめる）。\n' +
        '- 誇張的な断定表現（業界No.1、必ず等）は使わないこと。\n' +
        `- categoryは structure_discovered_agent ツール定義に列挙された${CATEGORIES.length}個の文字列以外を絶対に使わないこと` +
        '（新しいカテゴリ名を作らない。該当が無ければ「その他」を使う）。\n' +
        '- categoryが「その他」の場合は、必ず categoryHint も出力すること（省略しない）。' +
        'category がその他以外の場合は categoryHint を出力しないこと。\n' +
        hintVocabLine,
    }],
  });

  const toolUse = msg.content.find(b => b.type === 'tool_use');
  if (!toolUse) throw new Error('AI response did not include a tool_use block');

  const result = toolUse.input;
  if (!CATEGORIES.includes(result.category)) {
    console.warn(`Unexpected category "${result.category}" from AI, clamping to "その他".`);
    result.category = 'その他';
  }
  result.categoryHint = result.category === 'その他' ? (result.categoryHint || null) : null;
  if (!Array.isArray(result.contractTypes)) result.contractTypes = [];
  if (!result.feeStructure || typeof result.feeStructure !== 'object') {
    result.feeStructure = { type: 'unknown', note: null };
  } else if (!['margin', 'monthlyFixed', 'commission', 'unknown'].includes(result.feeStructure.type)) {
    console.warn(`Unexpected feeStructure.type "${result.feeStructure.type}" from AI, clamping to "unknown".`);
    result.feeStructure.type = 'unknown';
  }
  return result;
}

module.exports = {
  getAnthropicClient,
  extractJsonArray,
  SEARCH_CATEGORIES,
  searchCategoryCandidates,
  discoverCandidates,
  fetchWithVerifyUA,
  candidateFetchUrls,
  candidateRootUrls,
  splitName,
  candidateNameCores,
  verifyCandidate,
  buildDiscoveredAgentFields,
};
