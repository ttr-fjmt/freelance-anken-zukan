'use strict';

/**
 * data/raw-agents.json（スクレイパーの生データ）を、フロントエンドの AGENTS 配列と
 * 同じスキーマに構造化して agents.json に出力する。
 *
 * - 既存の agents.json と生データのハッシュを比較し、差分がある事業者のみ
 *   Claude Haiku 4.5 (ANTHROPIC_API_KEY) に投げて再構造化する（コスト抑制）。
 * - ANTHROPIC_API_KEY が無い環境（ローカル動作確認など）では、生データから
 *   直接組み立てる非AIフォールバックで動作する（次回 API キーがある実行時に
 *   自動的に再構造化されるよう、そのエントリのハッシュは保存しない）。
 * - 事業者コメント等の本文をそのまま転載せず、事実情報の抽出・要約にとどめる。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { CATEGORIES, NOT_DISCLOSED } = require('./lib/schema');
const { politeDelay } = require('./lib/http');
const { verifyLink } = require('./lib/link-check');

const RAW_PATH = path.join(__dirname, '..', 'data', 'raw-agents.json');
const MHLW_RAW_PATH = path.join(__dirname, '..', 'data', 'mhlw-agents.json');
const OUT_PATH = path.join(__dirname, '..', 'agents.json');

/**
 * jesra/mhlw のスクレイプ対象外（_sourceUrl を持たない手動インポート系）の
 * エントリを、source フィールドで識別するための許可リスト。
 * 該当する既存エントリは、その日の raw batches に登場しなくても results から
 * 落とさず引き継ぐ（= 日次スクレイプによる誤削除を防ぐ）。今後インポート元が
 * 増えたらここに追記する。
 */
const UNSCRAPED_SOURCES = ['a8'];

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

function stableStringify(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

function computeJesraRawHash(raw) {
  const relevant = {
    companyName: raw.companyName,
    certificationNumber: raw.certificationNumber,
    certificationPeriod: raw.certificationPeriod,
    permitNumber: raw.permitNumber,
    region: raw.region,
    industries: raw.industries,
    jobTypes: raw.jobTypes,
    serviceName: raw.serviceName,
    serviceUrl: raw.serviceUrl,
    feeDisclosureUrl: raw.feeDisclosureUrl,
    feeVariationNote: raw.feeVariationNote,
    operatorComment: raw.operatorComment,
    feePageExcerpt: raw.feePageExcerpt,
  };
  return crypto.createHash('sha256').update(stableStringify(relevant)).digest('hex');
}

function computeMhlwRawHash(raw) {
  const relevant = {
    permitNumber: raw.permitNumber,
    permitDate: raw.permitDate,
    businessOwnerName: raw.businessOwnerName,
    establishmentName: raw.establishmentName,
    address: raw.address,
    phone: raw.phone,
    handledOccupations: raw.handledOccupations,
    handledRegion: raw.handledRegion,
    handledOther: raw.handledOther,
    // yearlyStats はネスト配列なので、stableStringify のトップレベル鍵フィルタで
    // 中身が消えないよう、先に文字列化してから渡す。
    yearlyStatsJson: JSON.stringify(raw.yearlyStats || []),
  };
  return crypto.createHash('sha256').update(stableStringify(relevant)).digest('hex');
}

function computeRawHash(raw, source) {
  return source === 'mhlw' ? computeMhlwRawHash(raw) : computeJesraRawHash(raw);
}

function stripProtocol(url) {
  if (!url) return null;
  return url.replace(/^https?:\/\//, '').replace(/\/+$/, '').replace(/#$/, '');
}

/** jesra.or.jp の詳細ページURLから、サイト内で一意な数値IDを取り出す（URLルーティングのslugに使う）。 */
function extractAgentId(detailUrl) {
  if (!detailUrl) return null;
  const m = detailUrl.match(/\/certification\/(\d+)\/?(?:[?#].*)?$/);
  return m ? m[1] : null;
}

/** 許可番号中の業態カナをURL-safeなローマ字に変換する（ユ→yu 等）。jesraの数値IDとは衝突しない。 */
const PERMIT_KANA_TO_ROMAJI = { ユ: 'yu', ム: 'mu', 特: 'toku', 地: 'chi' };

/** MHLW由来エージェントのIDを、許可番号から組み立てる（例: "01-ユ-300184" → "01-yu-300184"）。 */
function extractAgentIdFromPermitNumber(permitNumber) {
  if (!permitNumber) return null;
  const parts = permitNumber.split('-');
  if (parts.length !== 3) return permitNumber.replace(/[^\w-]/g, '');
  const [prefix, kana, suffix] = parts;
  return `${prefix}-${PERMIT_KANA_TO_ROMAJI[kana] || kana}-${suffix}`;
}

function computeId(raw, source) {
  return source === 'mhlw' ? extractAgentIdFromPermitNumber(raw.permitNumber) : extractAgentId(raw.detailUrl);
}

/** serviceUrl のドメインから Google の favicon 取得サービスの URL を組み立てる。 */
function buildFaviconUrl(serviceUrl) {
  if (!serviceUrl) return null;
  let domain;
  try {
    domain = new URL(serviceUrl).hostname;
  } catch {
    return null;
  }
  if (!domain) return null;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
}

function formatRegion(regionRaw) {
  if (!regionRaw) return NOT_DISCLOSED;
  const list = regionRaw.split('｜').map(s => s.trim()).filter(Boolean);
  if (list.length >= 47) return '全国47都道府県';
  if (list.length > 8) return `${list.slice(0, 6).join('、')} など${list.length}エリア対応`;
  return list.join('、');
}

function formatPipeList(text) {
  if (!text) return null;
  return text.split('｜').map(s => s.trim()).filter(Boolean).join('、');
}

/** MHLWの都道府県チェックボックス名（短縮名）を正式名称に変換する（例: "鳥取" → "鳥取県"）。 */
function prefectureFullName(short) {
  if (!short) return NOT_DISCLOSED;
  if (short === '北海道') return '北海道';
  if (short === '東京') return '東京都';
  if (short === '大阪') return '大阪府';
  if (short === '京都') return '京都府';
  return `${short}県`;
}

function computeRegion(raw, source) {
  return source === 'mhlw' ? prefectureFullName(raw.prefecture) : formatRegion(raw.region);
}

/** 年度別の就職者数・離職者数をAIプロンプト用に短い文へ要約する。 */
function summarizeYearlyStats(stats) {
  if (!stats || !stats.length) return '(不明)';
  const parts = stats
    .filter(s => s.placements4moPlusFixedTerm !== null || s.turnoverCount !== null)
    .map(s => `${s.fiscalYear}: 就職者${s.placements4moPlusFixedTerm ?? 0}名/離職者${s.turnoverCount ?? 0}名`);
  return parts.length ? parts.join('、') : '(不明)';
}

function todayJst() {
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date());
}

function buildJesraSourceNote(raw) {
  return (
    `厚生労働省委託「職業紹介優良事業者認定制度」掲載情報（${raw.detailUrl}）` +
    `${raw.feeDisclosureUrl ? 'および手数料公表サイト' : ''}をもとに作成。` +
    `取得日: ${todayJst()}。取得できなかった項目は「${NOT_DISCLOSED}」と表示しています。`
  );
}

function buildMhlwSourceNote(raw) {
  return (
    `厚生労働省『人材サービス総合サイト』掲載情報（${raw.detailUrl}）をもとに作成。` +
    `取得日: ${todayJst()}。手数料情報は今後のアップデートで追加予定です。` +
    `取得できなかった項目は「${NOT_DISCLOSED}」と表示しています。`
  );
}

function buildSourceNote(raw, source) {
  return source === 'mhlw' ? buildMhlwSourceNote(raw) : buildJesraSourceNote(raw);
}

const REVIEW_NOTE = '口コミデータは未収集です（今後のアップデートで追加予定）。';
const COMPANY_REVIEW_NOTE = '企業からの口コミデータは未収集です（今後のアップデートで追加予定）。';

/** ANTHROPIC_API_KEY が無い場合の非AIフォールバック（jesra由来）。事実の範囲を出ない組み立てのみ行う。 */
function buildOfflineJesra(raw) {
  const industriesJa = formatPipeList(raw.industries);
  const jobTypesJa = formatPipeList(raw.jobTypes);

  const features = [];
  if (industriesJa) features.push(`対応業界: ${industriesJa}`);
  if (jobTypesJa) features.push(`対応職種: ${jobTypesJa}`);
  if (raw.feeVariationNote) features.push(`手数料設定について: ${raw.feeVariationNote}`);
  while (features.length < 1) features.push(NOT_DISCLOSED);

  return {
    category: guessCategoryOffline(raw),
    targetAge: NOT_DISCLOSED,
    jobCount: NOT_DISCLOSED,
    feeRate: NOT_DISCLOSED,
    talentRange: NOT_DISCLOSED,
    oneLiner: raw.serviceName ? `${raw.serviceName}が提供する人材紹介サービス。` : NOT_DISCLOSED,
    companyOneLiner: raw.serviceName ? `${raw.serviceName}による採用支援。` : NOT_DISCLOSED,
    appeal: [industriesJa && `対応業界: ${industriesJa}`, jobTypesJa && `対応職種: ${jobTypesJa}`]
      .filter(Boolean)
      .join('。') || NOT_DISCLOSED,
    features,
    feeExplanation: raw.feeVariationNote || NOT_DISCLOSED,
    commitmentExplanation: NOT_DISCLOSED,
    companyAppeal: null,
    companyDetail: {
      placementRate: NOT_DISCLOSED,
      avgDays: NOT_DISCLOSED,
      trackRecord: NOT_DISCLOSED,
      refundPolicy: NOT_DISCLOSED,
      upfrontFee: NOT_DISCLOSED,
      minContract: NOT_DISCLOSED,
      exclusivity: NOT_DISCLOSED,
      capacity: NOT_DISCLOSED,
      sourcingMethod: NOT_DISCLOSED,
      reportingFreq: NOT_DISCLOSED,
      handoverPolicy: NOT_DISCLOSED,
      onboardingSupport: NOT_DISCLOSED,
      confidentiality: NOT_DISCLOSED,
    },
  };
}

function guessCategoryOffline(raw) {
  const hay = `${raw.industries || ''} ${raw.jobTypes || ''} ${raw.serviceName || ''}`;
  if (/IT|Web|エンジニア|システム/i.test(hay)) return 'IT・Web';
  if (/建設|施工|不動産/.test(hay)) return '施工管理・建設';
  if (/営業|マーケ|販売/.test(hay)) return '営業・マーケティング';
  if (/外資|グローバル|海外/.test(hay)) return '外資・グローバル';
  if (/管理部門|コンサル|経理|人事|バックオフィス/.test(hay)) return '管理部門・コンサル';
  return '管理部門・コンサル';
}

/** ANTHROPIC_API_KEY が無い場合の非AIフォールバック（MHLW由来）。 */
function buildOfflineMhlw(raw) {
  const occ = raw.handledOccupations || null;
  const region = raw.handledRegion || null;

  const features = [];
  if (occ) features.push(`取扱職種: ${occ}`);
  if (region) features.push(`取扱地域: ${region}`);
  if (raw.prefecture) features.push(`拠点: ${prefectureFullName(raw.prefecture)}`);
  while (features.length < 1) features.push(NOT_DISCLOSED);

  return {
    category: guessCategoryOfflineMhlw(raw),
    targetAge: NOT_DISCLOSED,
    jobCount: NOT_DISCLOSED,
    feeRate: NOT_DISCLOSED,
    talentRange: NOT_DISCLOSED,
    oneLiner: raw.businessOwnerName ? `${raw.businessOwnerName}が提供する職業紹介サービス。` : NOT_DISCLOSED,
    companyOneLiner: raw.businessOwnerName ? `${raw.businessOwnerName}による人材紹介サービス。` : NOT_DISCLOSED,
    appeal: [occ && `取扱職種: ${occ}`, region && `取扱地域: ${region}`].filter(Boolean).join('。') || NOT_DISCLOSED,
    features,
    feeExplanation: NOT_DISCLOSED,
    commitmentExplanation: NOT_DISCLOSED,
    companyAppeal: null,
    companyDetail: {
      placementRate: NOT_DISCLOSED,
      avgDays: NOT_DISCLOSED,
      trackRecord: NOT_DISCLOSED,
      refundPolicy: NOT_DISCLOSED,
      upfrontFee: NOT_DISCLOSED,
      minContract: NOT_DISCLOSED,
      exclusivity: NOT_DISCLOSED,
      capacity: NOT_DISCLOSED,
      sourcingMethod: NOT_DISCLOSED,
      reportingFreq: NOT_DISCLOSED,
      handoverPolicy: NOT_DISCLOSED,
      onboardingSupport: NOT_DISCLOSED,
      confidentiality: NOT_DISCLOSED,
    },
  };
}

function guessCategoryOfflineMhlw(raw) {
  const hay = `${raw.handledOccupations || ''} ${raw.handledOther || ''}`;
  if (/情報処理|システム|ソフトウェア|IT/i.test(hay)) return 'IT・Web';
  if (/建設|土木|建築/.test(hay)) return '施工管理・建設';
  if (/営業|販売/.test(hay)) return '営業・マーケティング';
  if (/介護|保育|看護|医療|福祉/.test(hay)) return '管理部門・コンサル';
  return 'その他';
}

function buildOffline(raw, source) {
  const built = source === 'mhlw' ? buildOfflineMhlw(raw) : buildOfflineJesra(raw);
  return { ...built, categoryHint: null };
}

/**
 * 既存の agents.json から、category が「その他」のエントリに付与された categoryHint の
 * 頻出上位を集計する。AIプロンプトに「候補語彙」として渡し、表記揺れ（医療/医療系/医療・福祉等）を防ぐ。
 */
function topCategoryHints(existingAgents, limit = 10) {
  const counts = new Map();
  for (const a of existingAgents) {
    if (a.category === 'その他' && a.categoryHint) {
      counts.set(a.categoryHint, (counts.get(a.categoryHint) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([hint]) => hint);
}

async function buildWithAI(raw, anthropic, source, existingHints = []) {
  const tool = {
    name: 'structure_agent',
    description: '転職エージェント図鑑サイトのスキーマに沿って、与えられた事実情報のみから項目を構造化する。',
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: CATEGORIES,
          description:
            `次の${CATEGORIES.length}個の文字列のいずれか一つを一字一句そのまま使うこと（新しいカテゴリ名を作らない）: ` +
            CATEGORIES.join('、') +
            '。対応業界・職種から最も近いものを選び、どれにも当てはまらない場合は「その他」を使う。',
        },
        categoryHint: {
          type: 'string',
          description:
            'category が「その他」の場合のみ、日本語2〜6文字程度の簡潔なサブカテゴリー推定値' +
            '（例: "医療・介護", "製造業", "運輸・物流", "教育・保育", "飲食・サービス"）を指定する。' +
            'category が「その他」以外の場合は省略する（このフィールドを呼び出しに含めない）。' +
            '既に使われている表記があれば、新しい言い回しを作らず、可能な限りそのまま再利用すること' +
            '（例:「医療」「医療系」「医療・福祉」のような表記揺れを生まないこと）。',
        },
        targetAge: { type: 'string', description: '対象年代。根拠となる事実が無ければ「' + NOT_DISCLOSED + '」' },
        jobCount: { type: 'string', description: '求人数の目安。根拠が無ければ「' + NOT_DISCLOSED + '」' },
        feeRate: {
          type: 'string',
          description:
            '成功報酬フィー（料率）。手数料公表サイトの抜粋に「業界の実勢相場」として読める具体的な料率（例:35%等の一律料率）があればそれをそのまま使う。' +
            '一方、抜粋にあるのが職業安定法の届出制手数料表としての「上限額」（例: 就職後1年間の賃金の150%等）のみで、実際の請求料率が読み取れない場合は、' +
            '「理論年収の30〜35%程度（業界相場からの推定値。公式の届出上限は賃金の◯%）」のように、業界相場の推定値を主として提示しつつ、届出上限の数値も括弧内に併記する。' +
            'いずれの情報も無ければ「' + NOT_DISCLOSED + '」とする。',
        },
        talentRange: { type: 'string', description: '候補者の年齢・年収レンジ。根拠が無ければ「' + NOT_DISCLOSED + '」' },
        oneLiner: { type: 'string', description: '求職者向けの一言キャッチコピー（30字前後、誇張・断定は避ける）' },
        companyOneLiner: { type: 'string', description: '採用企業向けの一言キャッチコピー（30字前後）' },
        appeal: { type: 'string', description: '2〜3文程度の特徴説明。求職者（候補者）にとっての魅力という視点で書く。事実情報のみに基づき、事業者コメントの丸写しは禁止（要約・言い換えのみ可）' },
        companyAppeal: {
          type: 'string',
          description:
            '1〜2文程度の特徴説明。appealとは視点を変え、採用企業がこのエージェントを使う意味・強み' +
            '（対応業界・職種の専門性、対応エリア、実績など）という視点で書く。' +
            '事実情報のみに基づき、事業者コメントの丸写しは禁止（要約・言い換えのみ可）。根拠となる事実が無ければappealの内容を採用企業視点に言い換えてよい。',
        },
        features: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3, description: '箇条書き特徴3点' },
        feeExplanation: { type: 'string', description: '成功報酬に関する説明文。数値の根拠が無ければその旨を明記' },
        commitmentExplanation: { type: 'string', description: 'どこまで対応してくれるかの説明文' },
        companyDetail: {
          type: 'object',
          properties: {
            placementRate: { type: 'string' },
            avgDays: { type: 'string' },
            trackRecord: { type: 'string' },
            refundPolicy: {
              type: 'string',
              description:
                '返戻金制度（返金保証）について。手数料公表サイトの抜粋に「返戻金」「返金」「早期離職」等の記載があれば、' +
                '返金の条件（期間・料率など）を要約して記載する。記載が無ければ「' + NOT_DISCLOSED + '」とする。',
            },
            upfrontFee: { type: 'string' },
            minContract: { type: 'string' },
            exclusivity: { type: 'string' },
            capacity: { type: 'string' },
            sourcingMethod: { type: 'string' },
            reportingFreq: { type: 'string' },
            handoverPolicy: { type: 'string' },
            onboardingSupport: { type: 'string' },
            confidentiality: { type: 'string' },
          },
          required: [
            'placementRate', 'avgDays', 'trackRecord', 'refundPolicy', 'upfrontFee',
            'minContract', 'exclusivity', 'capacity', 'sourcingMethod', 'reportingFreq',
            'handoverPolicy', 'onboardingSupport', 'confidentiality',
          ],
          additionalProperties: false,
        },
      },
      required: [
        'category', 'targetAge', 'jobCount', 'feeRate', 'talentRange', 'oneLiner',
        'companyOneLiner', 'appeal', 'companyAppeal', 'features', 'feeExplanation', 'commitmentExplanation',
        'companyDetail',
      ],
      additionalProperties: false,
    },
  };

  const factsBlock =
    source === 'mhlw'
      ? [
          `企業名（事業主名称）: ${raw.businessOwnerName || '(不明)'}`,
          `事業所名称: ${raw.establishmentName || '(不明)'}`,
          `所在地: ${raw.address || '(不明)'}`,
          `対応都道府県: ${prefectureFullName(raw.prefecture)}`,
          `取扱職種: ${raw.handledOccupations || '(不明)'}`,
          `取扱地域: ${raw.handledRegion || '(不明)'}`,
          `その他の備考: ${raw.handledOther || '(不明)'}`,
          `許可番号: ${raw.permitNumber || '(不明)'}`,
          `年度別 就職者数・離職者数の推移: ${summarizeYearlyStats(raw.yearlyStats)}`,
          '手数料公表サイトの情報: 今回は取得していません（別途アップデートで対応予定）。',
        ].join('\n')
      : source === 'a8'
      ? [
          `企業名（サービス提供者）: ${raw.companyName || '(不明)'}`,
          `エージェントの特徴（原文、提携先の自己申告）: ${raw.feature || '(不明)'}`,
          `特化領域: ${raw.specialty || '(不明)'}`,
          `対応エリア: ${raw.region || '(不明)'}`,
          `対象年代: ${raw.targetAge || '(不明)'}`,
        ].join('\n')
      : [
          `企業名: ${raw.companyName || '(不明)'}`,
          `サービス名: ${raw.serviceName || '(不明)'}`,
          `サービスURL: ${raw.serviceUrl || '(不明)'}`,
          `対応エリア: ${raw.region || '(不明)'}`,
          `対応業界: ${raw.industries || '(不明)'}`,
          `対応職種: ${raw.jobTypes || '(不明)'}`,
          `許可番号: ${raw.permitNumber || '(不明)'}`,
          `手数料公表サイトURL: ${raw.feeDisclosureUrl || '(不明)'}`,
          `手数料変動事例（原文）: ${raw.feeVariationNote || '(不明)'}`,
          `事業者コメント（原文）: ${raw.operatorComment || '(不明)'}`,
          raw.feePageExcerpt ? `手数料公表サイトのテキスト抜粋:\n${raw.feePageExcerpt}` : '手数料公表サイトのテキスト抜粋: (取得できず)',
        ].join('\n');

  const introLine =
    source === 'mhlw'
      ? '以下は、厚生労働省「人材サービス総合サイト」に掲載された、ある職業紹介事業者の公開情報（事実）です。'
      : source === 'a8'
      ? '以下は、アフィリエイトサービス（A8.net）経由で提携している、ある転職エージェント／人材紹介サービスの提携先申告情報（事実）です。'
      : '以下は、厚生労働省委託「職業紹介優良事業者認定制度」に掲載された、ある人材紹介事業者の公開情報（事実）です。';

  const sourceSpecificRules =
    source === 'mhlw'
      ? '- このデータには手数料公表サイトの情報が一切含まれていません。feeRate と companyDetail.refundPolicy / companyDetail.upfrontFee は必ず「' +
        NOT_DISCLOSED +
        '」としてください（絶対に推測しないこと）。\n' +
        '- companyDetail.trackRecord には、「年度別 就職者数・離職者数の推移」の事実を簡潔に要約してよい（数値の創作は禁止、与えられた数値のみ使用）。\n'
      : source === 'a8'
      ? '- この提携情報には手数料・求人数・候補者レンジ・実績等の数値データが一切含まれていません。' +
        'feeRate、jobCount、talentRange、companyDetailの全項目は必ず「' + NOT_DISCLOSED + '」としてください（絶対に推測・創作しないこと。' +
        '呼び出し側でこれらの項目は別途固定値に置き換えるため、ここで無理に内容を埋めようとしないこと）。\n' +
        '- 「エージェントの特徴（原文）」「特化領域」の内容をそのまま丸写しせず、oneLiner/appeal は求職者視点、companyOneLiner/companyAppeal は採用企業視点で、' +
        'それぞれ異なる言い回しに要約・言い換えること。\n'
      : '- 「手数料公表サイトのテキスト抜粋」を読む際は、それが「職業安定法の届出制手数料表における上限額」なのか' +
        '「実際に請求している標準的な料率（相場）」なのかを文脈から慎重に判断すること。' +
        '「手数料の額（上限）」「届出上限」「就職後1年間の賃金の◯％」のような表現は、多くの場合、法定の届出上限であり実際の請求額とは異なる。' +
        '上限額の記載しかない場合でも、それをそのまま実際の料率として出力しないこと（feeRateの項目説明に従うこと）。\n' +
        '- 抜粋内に返戻金・返金保証に関する記載があれば、必ず companyDetail.refundPolicy に反映すること。\n';

  const hintVocabLine =
    existingHints.length > 0
      ? '既存のカテゴリーヒント候補（categoryHint を出力する際は、可能な限りこの中の表記をそのまま使うこと）: ' +
        existingHints.join('、') + '\n'
      : '';

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1500,
    tools: [tool],
    tool_choice: { type: 'tool', name: 'structure_agent' },
    messages: [
      {
        role: 'user',
        content:
          introLine +
          'これらの事実情報のみに基づいて structure_agent ツールを呼び出し、転職エージェント比較サイト用のデータを構造化してください。\n\n' +
          '厳守事項:\n' +
          '- 数値（料率・年収・日数・件数など）は、根拠となる記載が無い限り絶対に創作しないこと。無ければ「' + NOT_DISCLOSED + '」と出力する。\n' +
          '- 「事業者コメント（原文）」を長文のままコピーしないこと。要約・言い換えた事実のみ使用する。\n' +
          '- 口コミ・評判は一切創作しないこと（このツールの入力に口コミ関連の項目は無い）。\n' +
          '- 誇張的な断定表現（業界No.1、必ず等）は使わないこと。\n' +
          '- categoryは structure_agent ツール定義に列挙された' + CATEGORIES.length + '個の文字列以外を絶対に使わないこと' +
          '（新しいカテゴリ名を作らない。該当が無ければ「その他」を使う）。\n' +
          '- categoryが「その他」の場合は、必ず categoryHint も出力すること（省略しない）。' +
          'category がその他以外の場合は categoryHint を出力しないこと。\n' +
          hintVocabLine +
          sourceSpecificRules +
          '\n' +
          factsBlock,
      },
    ],
  });

  const toolUse = msg.content.find(b => b.type === 'tool_use');
  if (!toolUse) throw new Error('AI response did not include a tool_use block');

  const result = toolUse.input;
  // Anthropicのtool useはJSON Schemaのenumをサーバー側で厳密には強制しないため、
  // 万一未知のカテゴリ文字列が返ってきた場合はここで「その他」に丸める。
  if (!CATEGORIES.includes(result.category)) {
    console.warn(`Unexpected category "${result.category}" from AI, clamping to "その他".`);
    result.category = 'その他';
  }
  // categoryHint は category が「その他」の場合のみ意味を持つ。それ以外では常に null に強制する。
  result.categoryHint = result.category === 'その他' ? (result.categoryHint || null) : null;
  return result;
}

/**
 * existing は同一事業者の直近の agents.json エントリ（あれば）。affiliateUrl / featured は
 * AIやスクレイピングでは導出できない、手動でキュレーションするフィールドのため、
 * 再構造化のたびに消えてしまわないよう existing から引き継ぐ。
 */
function assembleEntry(raw, ai, rawHash, source, existing) {
  const name =
    source === 'mhlw'
      ? raw.businessOwnerName || raw.establishmentName || NOT_DISCLOSED
      : raw.companyName || raw.serviceName || NOT_DISCLOSED;

  return {
    id: computeId(raw, source),
    source,
    name,
    category: ai.category,
    categoryHint: ai.category === 'その他' ? (ai.categoryHint || null) : null,
    targetAge: ai.targetAge,
    region: computeRegion(raw, source),
    jobCount: ai.jobCount,
    feeRate: ai.feeRate,
    talentRange: ai.talentRange,
    oneLiner: ai.oneLiner,
    companyOneLiner: ai.companyOneLiner,
    appeal: ai.appeal,
    companyAppeal: ai.companyAppeal || null,
    features: ai.features,
    reviews: [],
    reviewNote: REVIEW_NOTE,
    companyReviews: [],
    companyReviewNote: COMPANY_REVIEW_NOTE,
    feeExplanation: ai.feeExplanation,
    commitmentExplanation: ai.commitmentExplanation,
    website: stripProtocol(raw.serviceUrl) || stripProtocol(raw.detailUrl),
    faviconUrl: buildFaviconUrl(raw.serviceUrl),
    affiliateUrl: (existing && existing.affiliateUrl) || null,
    featured: !!(existing && existing.featured),
    real: true,
    sourceNote: buildSourceNote(raw, source),
    companyDetail: {
      permitNumber: raw.permitNumber || NOT_DISCLOSED,
      ...ai.companyDetail,
    },
    _sourceUrl: raw.detailUrl,
    _rawHash: rawHash,
  };
}

/**
 * 既存 agents.json に未掲載の、新規追加候補エージェントのみが対象。website の生死を確認し、
 * 明確に「存在しない」と言えるケース（404 / DNS解決失敗）のみ false を返して掲載をスキップする
 * （raw dataの取得自体は既に完了しているが、構造化結果は agents.json に含めない）。
 *
 * それ以外（403=ボットブロックの可能性、TLS/タイムアウト等の一時的な接続エラー、
 * その他のHTTPエラー、URL不正）は、確定的な「存在しない」シグナルではないため掲載を許可する。
 * これらは verify-links.js の一括チェック（2段階確認つき）に委ねる。
 *
 * 既存エージェントの日次再構造化はこの関数を通らない（呼び出し側で prev の有無により分岐）ため、
 * 日次実行の処理時間には影響しない。
 */
const NEW_AGENT_SKIP_CATEGORIES = new Set(['http_404', 'dns_failure']);

// mhlw「人材サービス総合サイト」は事業者の外部公式サイトを持たないことが多く、その場合
// website はMHLW自身の詳細ページURLにフォールバックされる（assembleEntry参照）。
// MHLW自身のURLをチェックしても常に生存するだけで無意味なため、リクエストごと省略する
// （verify-links.js の no_company_website 分類と揃える）。
const MHLW_PORTAL_HOST = 'jinzai.hellowork.mhlw.go.jp';

async function isNewAgentLinkAlive(entry) {
  if (typeof entry.website === 'string' && entry.website.includes(MHLW_PORTAL_HOST)) {
    return true;
  }
  const result = await verifyLink(entry.website);
  if (NEW_AGENT_SKIP_CATEGORIES.has(result.category)) {
    console.warn(
      `[link-check] skipping new agent (${result.category}): ${entry.name} <${entry.website}> ` +
        (result.error ? `error=${result.error}` : `status=${result.status ?? 'none'}`)
    );
    return false;
  }
  return true;
}

async function main() {
  const rawData = fs.existsSync(RAW_PATH) ? JSON.parse(fs.readFileSync(RAW_PATH, 'utf8')) : null;
  const mhlwRaw = fs.existsSync(MHLW_RAW_PATH) ? JSON.parse(fs.readFileSync(MHLW_RAW_PATH, 'utf8')) : [];
  if (!rawData && mhlwRaw.length === 0) {
    console.error(`No raw data found. Run scrape.js (${RAW_PATH}) and/or scrape-mhlw.js (${MHLW_RAW_PATH}) first.`);
    process.exit(1);
  }

  const existing = fs.existsSync(OUT_PATH) ? JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')) : [];
  const prevByUrl = new Map(existing.filter(a => a._sourceUrl).map(a => [a._sourceUrl, a]));
  const existingHints = topCategoryHints(existing);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  let anthropic = null;
  if (apiKey) {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropic = new Anthropic({ apiKey });
  } else {
    console.warn('ANTHROPIC_API_KEY is not set — running in offline fallback mode (no AI structuring).');
  }

  const results = [];
  let reused = 0;
  let aiCalls = 0;
  let offlineBuilds = 0;
  let skippedUnreachable = 0;

  /**
   * prev（既存マッチ）がある場合は常に掲載する（既存分は日次のリンク生死チェック対象外）。
   * prev が無い、すなわち今回新規に追加されようとしているエージェントの場合のみ、
   * website の生死を確認してから掲載するかどうかを決める。
   */
  async function pushIfEligible(entry, prev) {
    if (prev) {
      results.push(entry);
      return;
    }
    const alive = await isNewAgentLinkAlive(entry);
    if (alive) {
      results.push(entry);
    } else {
      skippedUnreachable += 1;
    }
    await politeDelay();
  }

  const batches = [];
  if (rawData) batches.push({ source: 'jesra', items: rawData.agents });
  if (mhlwRaw.length) batches.push({ source: 'mhlw', items: mhlwRaw });

  for (const { source, items } of batches) {
    for (const raw of items) {
      const rawHash = computeRawHash(raw, source);
      const prev = prevByUrl.get(raw.detailUrl);

      if (prev && prev._rawHash && prev._rawHash === rawHash) {
        // faviconUrl / id / source は raw から機械的に導出できるため、AI再構造化を
        // 発生させずに毎回リフレッシュする（スキーマ追加時の後方互換のため）。
        results.push({
          ...prev,
          id: computeId(raw, source),
          source,
          faviconUrl: buildFaviconUrl(raw.serviceUrl),
        });
        reused += 1;
        continue;
      }

      if (anthropic) {
        try {
          console.log(`[ai:${source}] structuring ${raw.companyName || raw.businessOwnerName || raw.detailUrl}`);
          const ai = await buildWithAI(raw, anthropic, source, existingHints);
          await pushIfEligible(assembleEntry(raw, ai, rawHash, source, prev), prev);
          aiCalls += 1;
        } catch (err) {
          console.warn(`AI structuring failed for ${raw.detailUrl}: ${err.message}. Falling back to offline builder.`);
          await pushIfEligible(assembleEntry(raw, buildOffline(raw, source), null, source, prev), prev);
          offlineBuilds += 1;
        }
      } else {
        await pushIfEligible(assembleEntry(raw, buildOffline(raw, source), null, source, prev), prev);
        offlineBuilds += 1;
      }
    }
  }

  /**
   * jesra/mhlw のスクレイプ対象外（_sourceUrl が無い、または source が
   * UNSCRAPED_SOURCES に含まれる）既存エントリを補完する。
   * これらはその日の raw batches に一切登場しないため、上のループでは
   * results に一度も追加されない。放置すると日次スクレイプのたびに
   * 消えてしまうため、まだ results に同一 id が無いものだけ末尾に引き継ぐ。
   *
   * 一方、_sourceUrl を持つ既存エントリ（jesra/mhlw 由来）が今回の raw batches に
   * 登場しなかった場合は、廃業等の可能性があるため従来通り削除されたままにする
   * （ここでは一切補完しない）。
   */
  const resultIds = new Set(results.map(a => a.id));
  let carriedOver = 0;
  for (const entry of existing) {
    const isUnscraped = !entry._sourceUrl || UNSCRAPED_SOURCES.includes(entry.source);
    if (isUnscraped && !resultIds.has(entry.id)) {
      results.push(entry);
      resultIds.add(entry.id);
      carriedOver += 1;
    }
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(results, null, 2) + '\n', 'utf8');
  console.log(
    `Wrote ${results.length} agents to ${OUT_PATH} ` +
      `(reused=${reused}, ai=${aiCalls}, offline=${offlineBuilds}, skipped-unreachable=${skippedUnreachable}, carried-over=${carriedOver})`
  );
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  computeRawHash,
  buildOffline,
  buildWithAI,
  assembleEntry,
  formatRegion,
  stripProtocol,
  buildFaviconUrl,
  extractAgentId,
  extractAgentIdFromPermitNumber,
  prefectureFullName,
  computeId,
  computeRegion,
  summarizeYearlyStats,
  topCategoryHints,
};
