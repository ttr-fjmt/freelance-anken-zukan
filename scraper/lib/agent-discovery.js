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
const { fetchText, politeDelay } = require('./http');
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
 * 日本国内のフリーランス向け案件紹介・マッチングサービスを、Claudeにweb_searchで
 * 実際に検索させ、excludeNames に無い新規候補のみ最大maxCandidates件返す。
 */
async function discoverCandidates(excludeNames, maxCandidates) {
  const anthropic = getAnthropicClient();

  const response = await anthropic.messages.create({
    model: DISCOVERY_MODEL,
    max_tokens: 2000,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
    messages: [{
      role: 'user',
      content:
        `日本国内で、フリーランス(業務委託・準委任契約)向けに案件紹介・` +
        `マッチングを行っているエージェント/サービスを、Web検索を使って` +
        `実在するものだけ探してください。\n\n` +
        `除外リスト(既に掲載済み、これらは含めない): ${excludeNames.join('、')}\n\n` +
        `条件:\n` +
        `- 検索で実在を確認できた企業のみ回答すること。知識だけで` +
        `  推測したり、実在確認ができない企業を創作しないこと\n` +
        `- 最大${maxCandidates}件まで\n` +
        `- 個人ブログ・まとめ記事ではなく、エージェント/サービスを` +
        `  実際に運営する企業自体を対象にすること\n\n` +
        `検索が終わったら、最後に必ず以下の形式のJSON配列のみを出力` +
        `してください(前後に説明文やコードフェンスを付けないこと)。\n` +
        `[{"name": "会社名", "website": "公式サイトURL"}, ...]\n` +
        `該当なしの場合は空配列[]を出力してください。`,
    }],
  });

  const textBlocks = response.content.filter(b => b.type === 'text');
  const lastText = textBlocks[textBlocks.length - 1];
  if (!lastText) {
    console.error('agent-discovery: AI応答にtextブロックが含まれていませんでした。');
    return [];
  }

  const candidates = extractJsonArray(lastText.text);
  const excludeCores = new Set((excludeNames || []).map(n => companyNameCore(n)));
  return candidates.filter(c => !excludeCores.has(companyNameCore(c.name))).slice(0, maxCandidates);
}

/** candidate.website を https/http の順で1回ずつ試すためのURL候補を組み立てる。 */
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

/** 構造化AIのプロンプトに渡すページ本文抽出テキストの上限文字数。 */
const PAGE_TEXT_MAX_CHARS = 4000;

/**
 * candidate.website へ実際にHTTPリクエストを送り、取得できたページ本文に
 * candidate.name（法人格を除いた主要部分）が実在するかを機械的に照合する。
 * lib/website-enrich.js の verifyDomainMatch と同じ考え方（最初に取得できた
 * レスポンスの内容で判定し、fetch自体が失敗した場合のみ次のスキームへフォール
 * バックする）。
 *
 * 一致した場合は、後続の buildDiscoveredAgentFields() に渡すための本文抽出
 * テキスト（pageText、先頭 PAGE_TEXT_MAX_CHARS 文字）も併せて返す。これにより、
 * 会社名だけの乏しい情報からAIに特徴を「作文」させるのではなく、実際に取得した
 * ページ本文からの抽出・要約に基づいて生成させることができる。
 */
async function verifyCandidate(candidate) {
  const nameCore = companyNameCore(candidate.name);
  if (!nameCore || nameCore.length < 2) {
    return { ok: false, reason: 'name_mismatch' };
  }

  const urls = candidateFetchUrls(candidate.website);
  if (urls.length === 0) {
    return { ok: false, reason: 'fetch_failed' };
  }

  let lastError = null;
  for (const url of urls) {
    await politeDelay();
    try {
      const html = await fetchText(url, { timeoutMs: 15000 });
      const $ = cheerio.load(html);
      // script/styleの中身はページ本文ではないため、名寄せ照合・AIへの本文抽出のどちらからも除く。
      $('script, style, noscript').remove();
      const titleText = $('title').text();
      const rawBodyText = $('body').text();
      const matchText = `${titleText} ${rawBodyText}`.replace(/[\s　]+/g, '');
      if (!matchText.includes(nameCore)) {
        return { ok: false, reason: 'name_mismatch' };
      }
      const pageText = rawBodyText
        .replace(/[ \t　]+/g, ' ')
        .replace(/\n\s*\n+/g, '\n')
        .trim()
        .slice(0, PAGE_TEXT_MAX_CHARS);
      return { ok: true, pageText };
    } catch (err) {
      lastError = err;
    }
  }
  return { ok: false, reason: 'fetch_failed', error: lastError ? lastError.message : 'unknown error' };
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
  discoverCandidates,
  candidateFetchUrls,
  verifyCandidate,
  buildDiscoveredAgentFields,
};
