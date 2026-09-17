'use strict';

/**
 * 自動で書いた解説記事が「公式に書かれていることだけ」を書いているかを確かめる。
 *
 * 【なぜテストの中ではなく、ここに置くのか】
 * 記事は毎日1本、GitHub Actions が自動で書く。書いたその場で同じ検査にかけて、
 * 落ちたものは**そもそも保存しない**ようにするため、検査そのものを部品にしてある。
 * `npm test` からも同じ関数を呼ぶので、保存済みの記事にも同じ線引きが効き続ける。
 *
 * 【見ているところ】
 *   1. 引用（公式の文言）が、保存した公式ページの本文に実在するか
 *   2. 本文に書いた数字（60日・令和6年11月1日など）が、同じ節の引用に実在するか
 *   3. 断定・誇大な表現（「必ず転職できます」など）が無いか
 *   4. 手数料の料率（％）や金額を書いていないか（公式で確認できないため、書かない約束）
 *   5. 記事の形（節が4つ以上・各節に引用・最後は公式窓口の案内）になっているか
 *
 * 2つ目が肝。「710円」と書きたければ、710円と書かれた公式の文を引用するしかない。
 */

const { textAppearsIn, loadRawText } = require('./verify-text');

/**
 * 本文に出てくる「数字＋単位」。ここに挙げた単位だけを見張り、単位ごと引用に実在することを求める
 * （「5年」を「最長5年」と書き換えるのを止めるため）。
 */
const NUMBER_PATTERN =
  /[０-９0-9]+\s*(日間|日|年間|年|か月|ヶ月|箇月|月|週間|時間|歳|万円|円|割|件|回|人|種類|倍|号|条|項)|令和[０-９0-9]+年[０-９0-9]+月[０-９0-9]+日|令和[０-９0-9]+年[０-９0-9]+月/g;

/** 断定・誇大な表現。比較サイトとして中立でいるための線引き。 */
const FORBIDDEN = [
  '必ず案件が取れます',
  '絶対に',
  '保証します',
  '最も優れた',
  '業界No.1',
  '間違いありません',
  'おすすめできません',
  'あなたの場合',
];

/** 最後の節は、公式窓口への案内で締める（判断を代わりにしない、という姿勢を形にしたもの）。 */
const CLOSING_HEADING = '正確なところを確かめたいとき';

/** 本文の分量の下限。これを下回るものは、公開できる記事になっていない。 */
const MIN_CHARS = 1200;

const textOf = article =>
  article.sections
    .flatMap(s => [s.heading, ...s.body, ...(s.quotes || []).map(q => q.text)])
    .concat([article.title, article.description])
    .join('\n');

/** 記事の形（必要な項目が入っているか）。 */
function checkShape(article) {
  const problems = [];
  for (const key of ['id', 'title', 'description', 'published_at', 'sources', 'sections']) {
    if (!article[key] || (Array.isArray(article[key]) && article[key].length === 0)) {
      problems.push(`${key} がありません`);
    }
  }
  if (problems.length) return problems;

  if (!/^[a-z0-9-]+$/.test(article.id)) problems.push(`id は英小文字・数字・ハイフンだけにしてください: ${article.id}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(article.published_at)) {
    problems.push(`published_at の日付の形が違います: ${article.published_at}`);
  }
  if (article.sections.length < 4) {
    problems.push(`節が${article.sections.length}個しかありません（4個以上）`);
  }

  article.sections.forEach((section, i) => {
    const where = `節${i + 1}`;
    if (!section.heading) problems.push(`${where}: 見出しがありません`);
    if (!Array.isArray(section.body) || section.body.length === 0) {
      problems.push(`${where}: 本文がありません`);
      return;
    }
    if (section.body.some(p => !String(p).trim())) problems.push(`${where}: 空の段落があります`);
    const isLast = i === article.sections.length - 1;
    if (!isLast && (section.quotes || []).length === 0) {
      problems.push(`${where}（${section.heading}）: 引用がありません。公式の文言を引いてください`);
    }
  });

  const last = article.sections[article.sections.length - 1];
  if (last && last.heading !== CLOSING_HEADING) {
    problems.push(`最後の節の見出しは「${CLOSING_HEADING}」にしてください（今は「${last.heading}」）`);
  }
  return problems;
}

/** 分量。短すぎる記事は、読んだ人が行動できない。 */
function checkLength(article) {
  const chars = article.sections.flatMap(s => s.body).join('').length;
  return chars < MIN_CHARS ? [`本文が短すぎます（${chars}字。${MIN_CHARS}字以上）`] : [];
}

/** 引用が、保存した公式ページの本文に実在するか。 */
function checkQuotes(article, { loadRaw = loadRawText } = {}) {
  const problems = [];
  for (const section of article.sections) {
    for (const quote of section.quotes || []) {
      const raw = loadRaw(quote.source_id);
      if (raw == null) {
        problems.push(`${quote.source_id} をまだ取得していません（data/raw に本文がありません）`);
        continue;
      }
      if (!textAppearsIn(quote.text, raw)) {
        problems.push(
          `引用「${quote.text.slice(0, 40)}…」が ${quote.source_id} の本文に見当たりません（言い換えず、原文のまま写してください）`
        );
      }
    }
  }
  return problems;
}

/** その節の引用に出てくる数字の表記（書き直しを頼むときに、使える表記を示すため）。 */
function numbersInQuotes(quoted) {
  return [...new Set(String(quoted).match(NUMBER_PATTERN) || [])].map(n => n.replace(/\s/g, ''));
}

/** 本文に書いた数字が、同じ節の引用に実在するか。 */
function checkNumbers(article) {
  const problems = [];
  for (const section of article.sections) {
    const quoted = (section.quotes || []).map(q => q.text).join(' ');
    const available = numbersInQuotes(quoted);
    const hint = available.length
      ? `この節の引用にある表記は「${available.join('」「')}」です。そのまま使ってください`
      : 'この節の引用には数字がありません。数字を書かないか、数字のある公式の文を引いてください';
    for (const paragraph of section.body) {
      for (const found of String(paragraph).match(NUMBER_PATTERN) || []) {
        const number = found.replace(/\s/g, '');
        if (!textAppearsIn(number, quoted)) {
          problems.push(`${section.heading}: 「${number}」を裏づける引用がありません。${hint}`);
        }
      }
    }
  }
  return problems;
}

/** 断定・誇大な表現を使っていないか。 */
function checkForbidden(article) {
  const text = textOf(article);
  return FORBIDDEN.filter(word => text.includes(word)).map(
    word => `「${word}」は使えません（比較サイトとして中立に書いてください）`
  );
}

/**
 * 手数料の料率（％）と金額を書いていないか。
 * 仲介手数料の料率も案件の相場も公式ページで確認できていないため、このサイトでは書かない
 * （手で書いた記事にも同じ線引きが効いている。README「解説記事」の節）。
 */
function checkNoPercent(article) {
  const text = textOf(article);
  const problems = [];
  if (/\d+(\.\d+)?\s*[%％]/.test(text)) {
    problems.push('割合（％）は書けません。料率を公式ページで確認できていないためです');
  }
  if (/\d[\d,]*\s*(円|万円)/.test(text)) {
    problems.push('金額は書けません。相場を公式ページで確認できていないためです');
  }
  return problems;
}

/** 出典の付け方。引用元が記事の出典一覧に入っているか、出典が登録済みか。 */
function checkSources(article, { sources = [] } = {}) {
  const problems = [];
  const known = new Set(sources.map(s => s.id));
  for (const id of article.sources || []) {
    if (!known.has(id)) problems.push(`出典 "${id}" が data/sources.json にありません`);
  }
  for (const section of article.sections) {
    for (const quote of section.quotes || []) {
      if (!(article.sources || []).includes(quote.source_id)) {
        problems.push(`引用元 "${quote.source_id}" が記事の出典一覧に入っていません`);
      }
    }
  }
  return problems;
}

/**
 * 記事をすべての観点で確かめる。問題の一覧を返す（空なら合格）。
 * 自動で書いたときは、この一覧をそのままAIに返して書き直させる。
 */
function checkArticle(article, { sources = [], loadRaw = loadRawText } = {}) {
  const shape = checkShape(article);
  if (shape.length) return shape; // 形が壊れているときは、中身の検査に進めない
  return [
    ...checkLength(article),
    ...checkQuotes(article, { loadRaw }),
    ...checkNumbers(article),
    ...checkForbidden(article),
    ...checkNoPercent(article),
    ...checkSources(article, { sources }),
  ];
}

module.exports = {
  checkArticle,
  checkShape,
  checkLength,
  checkQuotes,
  checkNumbers,
  checkForbidden,
  checkNoPercent,
  checkSources,
  numbersInQuotes,
  CLOSING_HEADING,
  FORBIDDEN,
  NUMBER_PATTERN,
  MIN_CHARS,
};
