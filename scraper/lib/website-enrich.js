'use strict';

/**
 * MHLW由来エージェント（公式サイトURLを厚労省の元データ自体が持たない）向けの、
 * 公式サイトドメイン推定・検証ロジック。
 *
 * 誤ったドメインを採用してしまうと、実在の別会社のロゴ（favicon）を無関係な
 * エージェントに表示してしまうリスクがあるため、AIの推測は一切無条件で信用せず、
 * 必ず2段階で確認する（呼び出し側 scraper/enrich-mhlw-websites.js が両方を実行する）。
 *   1. inferCompanyDomain(): AIに「確信が持てる場合のみ」ドメインを答えさせる
 *      （少しでも不確かなら null を返すよう厳格に指示する）。
 *   2. verifyDomainMatch(): AIが返したドメインへ実際にHTTPリクエストを送り、
 *      取得できたページ本文に会社名（法人格を除いた主要部分）が実際に含まれて
 *      いるかを機械的に照合する。一致しない限り採用しない。
 */

const cheerio = require('cheerio');
const { fetchText } = require('./http');

/**
 * 1日（1回のワークフロー実行）あたりに新規で試行するエージェント数の上限。
 * ここ1箇所を変更すれば調整できる（scrape-mhlw.js の DAILY_DETAIL_LIMIT と同じ考え方）。
 * 環境変数 MHLW_WEBSITE_ENRICH_DAILY_LIMIT でも上書き可能。
 */
const DAILY_ENRICH_LIMIT = Number(process.env.MHLW_WEBSITE_ENRICH_DAILY_LIMIT || 100);

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

/** 会社名から除去する法人格表記。長い（より具体的な）ものを先に判定させる。 */
const LEGAL_FORMS = [
  '特定非営利活動法人',
  '独立行政法人',
  '社会福祉法人',
  '医療法人社団',
  '医療法人財団',
  '一般社団法人',
  '公益社団法人',
  '一般財団法人',
  '公益財団法人',
  '事業協同組合',
  '生活協同組合',
  '農業協同組合',
  '商工組合',
  '協同組合',
  '合名会社',
  '合資会社',
  '合同会社',
  '有限会社',
  '株式会社',
  '医療法人',
  'NPO法人',
  '学校法人',
];

/** 会社名から法人格・空白を取り除いた「主要部分」を取り出す（例: "株式会社ヘイフィールド" → "ヘイフィールド"）。 */
function companyNameCore(name) {
  if (!name) return '';
  let core = name;
  for (const form of LEGAL_FORMS) {
    core = core.split(form).join('');
  }
  return core.replace(/[\s　]+/g, '').trim();
}

/**
 * Claude Haikuに、確信が持てる場合のみ会社の公式サイトドメインを答えさせる。
 * 少しでも不確かな場合は必ず null を返すよう、ツール定義・プロンプト双方で厳格に指示する。
 * 戻り値はホスト名文字列（例: "example.co.jp"）または null。
 */
async function inferCompanyDomain(facts, anthropic) {
  const tool = {
    name: 'infer_company_domain',
    description:
      '日本の企業名・所在地・事業内容から、その企業の公式サイトのドメイン名を、確信が持てる場合のみ回答する。',
    input_schema: {
      type: 'object',
      properties: {
        domain: {
          type: ['string', 'null'],
          description:
            '企業の公式サイトのドメイン名（例: example.co.jp）。' +
            '実在すると確信が持てる場合のみ回答する。' +
            '少しでも不確かな場合、似た名前の別会社と混同する可能性がある場合、' +
            'または該当企業の情報を知らない場合は、絶対に推測や創作をせず' +
            '必ずnullを返すこと。誤ったドメインを答えることは実在の別企業への' +
            '信用毀損につながるため、確信が持てない限りnullを選ぶこと。',
        },
      },
      required: ['domain'],
      additionalProperties: false,
    },
  };

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 300,
    tools: [tool],
    tool_choice: { type: 'tool', name: 'infer_company_domain' },
    messages: [
      {
        role: 'user',
        content:
          `以下は日本の職業紹介事業者の公開情報です。\n` +
          `事業主名称: ${facts.businessOwnerName || '(不明)'}\n` +
          `事業所名称: ${facts.establishmentName || ''}\n` +
          `所在地: ${facts.address || ''}\n` +
          `取扱職種: ${facts.handledOccupations || ''}\n\n` +
          `この企業の公式サイトのドメイン名を、確信が持てる場合のみ` +
          `infer_company_domainツールで回答してください。`,
      },
    ],
  });

  const toolUse = msg.content.find(b => b.type === 'tool_use');
  if (!toolUse) throw new Error('AI response did not include a tool_use block');

  const domain = toolUse.input && toolUse.input.domain;
  if (typeof domain !== 'string' || !domain.trim()) return null;

  // AIが "https://example.co.jp/" のようにプロトコル・パス付きで返してくる可能性に備え、
  // ホスト名だけを取り出す（末尾ドット等はURLパースで自然に落ちる）。
  try {
    const parsed = new URL(domain.includes('://') ? domain : `https://${domain.trim()}`);
    return parsed.hostname || null;
  } catch {
    return null;
  }
}

/**
 * domain の実サイトへ実際にアクセスし、取得できたページ（title + body）に
 * nameCore（会社名の法人格を除いた主要部分）が含まれているかを機械的に照合する。
 * https→httpの順で1回ずつ試す程度のシンプルな対応（verify-links.jsのような
 * 2段階再確認は行わない。一致しなければ即座に不採用とする設計のため）。
 */
async function verifyDomainMatch(domain, nameCore) {
  if (!nameCore || nameCore.length < 2) {
    return { matched: false, reason: 'name_too_short', error: null };
  }

  let lastError = null;
  for (const scheme of ['https', 'http']) {
    try {
      const html = await fetchText(`${scheme}://${domain}/`, { timeoutMs: 15000 });
      const $ = cheerio.load(html);
      const text = `${$('title').text()} ${$('body').text()}`.replace(/[\s　]+/g, '');
      const matched = text.includes(nameCore);
      return { matched, reason: matched ? null : 'name_mismatch', error: null };
    } catch (err) {
      lastError = err;
    }
  }
  return { matched: false, reason: 'fetch_failed', error: lastError ? lastError.message : 'unknown error' };
}

module.exports = { DAILY_ENRICH_LIMIT, companyNameCore, inferCompanyDomain, verifyDomainMatch };
