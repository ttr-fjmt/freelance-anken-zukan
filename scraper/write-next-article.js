'use strict';

/**
 * 題材リストの次の1本を書く（毎日 GitHub Actions から動く）。
 *
 * 【流れ】
 *   1. data/article-queue.json から、まだ書いていない題材を1つ選ぶ
 *      （出典が登録されていて、data/raw に本文が保存されているものだけ）
 *   2. 保存してある公式ページの本文を渡して、記事の下書きを書いてもらう
 *   3. lib/article-guards.js の検査にかける
 *   4. 落ちたら、落ちた理由をそのまま渡して書き直してもらう（3回まで）
 *   5. 通ったものだけ data/articles/<id>.json に保存し、題材リストに「公開済み」を書き込む
 *
 * 【絶対に守ること】
 * 検査に通らなかった記事は保存しない。1本落ちても、次の日にまた試せばよい。
 * 「公式に書いていないことを書かない」は、頼み方ではなく検査で守る。
 *
 * 実行例:
 *   node write-next-article.js              # 次の1本を書く
 *   node write-next-article.js --dry-run    # 何を書くかだけ見る（APIは呼ばない）
 *   node write-next-article.js --topic trouble-soudan
 */

const fs = require('node:fs');
const path = require('node:path');

const { ask, extractJson, jstDate, DEFAULT_MODEL } = require('./lib/ai');
const { checkArticle, CLOSING_HEADING, FORBIDDEN, MIN_CHARS } = require('./lib/article-guards');
const { loadRawText } = require('./lib/verify-text');

const ROOT = path.join(__dirname, '..');
const QUEUE_PATH = path.join(ROOT, 'data', 'article-queue.json');
const ARTICLES_DIR = path.join(ROOT, 'data', 'articles');
const SOURCES_PATH = path.join(ROOT, 'data', 'sources.json');

const MAX_ATTEMPTS = 3;

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

/** 公開済みの記事の数。 */
function publishedCount(dir = ARTICLES_DIR) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).length;
}

/**
 * 次に書く題材。出典が登録済みで、本文が保存されているものだけを選ぶ。
 * blocked ＝ 3回書き直しても検査に通らなかった題材。出典を足し直すまで飛ばす
 * （飛ばさないと、翌日も同じ題材で止まり、後ろの題材が永久に出ない）。
 */
function pickTopic(queue, { topicId = null, loadRaw = loadRawText } = {}) {
  const published = new Set(
    fs.existsSync(ARTICLES_DIR)
      ? fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''))
      : []
  );
  const candidates = queue.filter(
    t => t.status !== 'published' && t.status !== 'blocked' && !published.has(t.id)
  );

  if (topicId) {
    const found = candidates.find(t => t.id === topicId);
    if (!found) throw new Error(`題材 "${topicId}" が見つからないか、すでに公開済みです`);
    return { topic: found, waiting: 0 };
  }
  const ready = candidates.filter(
    t => t.sources.length > 0 && t.sources.every(id => loadRaw(id) != null)
  );
  const waiting = candidates.length - ready.length;
  if (ready.length === 0) return { topic: null, waiting };
  ready.sort((a, b) => a.n - b.n);
  return { topic: ready[0], waiting };
}

/** 記事の書き方の指示。ここに書いたルールは、すべて lib/article-guards.js の検査と対になっている。 */
function systemPrompt() {
  return `あなたは、フリーランスとして働く人と、フリーランスに仕事を発注する企業に向けた解説記事を書く編集者です。
読者は制度にくわしくない人で、案件を受ける前・出す前に「そもそもどういう決まりなのか」を知りたい人です。

【いちばん大事な決まり】
渡された「公式ページの本文」に書かれていないことは、絶対に書かないでください。
知っている知識で補わないでください。本文に無いことは、書かずに飛ばしてください。

【引用】
- 各節には、その節の内容の根拠になる公式の文を quotes として入れます
- 引用は、渡された本文から**一字一句そのまま**写してください（言い換え・要約・省略は不可）
- 文の途中で切らず、句点までの1文をそのまま入れてください

【数字】
本文（body）に数字を書けるのは、**同じ節の引用にその数字がある場合だけ**です。
引用に無い数字は書かないでください。さらに、**書き方も公式の表記のまま**にしてください。
- 公式が「令和６年１１月１日」と書いているなら、「2024年11月1日」と直さない
- 公式が「第１２条第１項」と書いているなら、その表記のまま使う
- 仲介手数料の料率（％）と金額（円）は、公式ページで確認できていないので**書かない**でください
- どの義務がどの発注事業者に当てはまるかなど、公式ページで確認しきれない条件は断定しないでください

【書いてはいけない表現】
${FORBIDDEN.map(w => `「${w}」`).join('、')}
特定のサービスをすすめたり、けなしたりしません。「制度はこうなっている（出典）」という書き方に徹してください。

【記事の形】（この大きさを守ってください。長すぎると途中で切れて公開できません）
- 節は4〜5個。読んだ人が順に理解できる並びにする
- 1つの節の段落は1〜2個、引用は1〜2文まで。長い条文は、必要な1文だけを引く
- 本文は合計${MIN_CHARS}〜2000字
- **最後の節の見出しは必ず** "${CLOSING_HEADING}" とし、公式の窓口・公式ページで確かめるよう案内して締めます
  （この節には引用を入れなくてかまいません）

出力は JSON だけ。前置きの文も、\`\`\` の囲みも、あとがきも付けないでください。`;
}

function userPrompt(topic, sources, previousProblems = [], { loadRaw = loadRawText } = {}) {
  const materials = topic.sources
    .map(id => {
      const source = sources.find(s => s.id === id);
      return `----- 出典ID: ${id}（${source ? source.label : id}）-----
${loadRaw(id)}`;
    })
    .join('\n\n');

  const retry =
    previousProblems.length > 0
      ? `\n【前回の下書きは、次の点で公開できませんでした。直してください】\n${previousProblems
          .map(p => `- ${p}`)
          .join('\n')}\n`
      : '';

  return `次の題材で記事を1本書いてください。

題材: ${topic.title}
記事のID: ${topic.id}
書くこと: ${topic.basis}
${retry}
【出力する JSON の形】
{
  "id": "${topic.id}",
  "title": "${topic.title}",
  "description": "日本語で100〜140字。検索結果に出る説明文",
  "published_at": "${jstDate()}",
  "sources": ${JSON.stringify(topic.sources)},
  "sections": [
    {
      "heading": "見出し",
      "body": ["段落1", "段落2"],
      "quotes": [{ "source_id": "出典ID", "text": "公式の本文からそのまま写した1文" }]
    }
  ]
}

【公式ページの本文（ここに書かれていることだけを使う）】

${materials}`;
}

async function writeArticle(topic, sources, { model = DEFAULT_MODEL } = {}) {
  let problems = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    console.log(`  下書き ${attempt}回目…`);
    const { text, stopReason } = await ask({
      system: systemPrompt(),
      prompt: userPrompt(topic, sources, problems),
      model,
      maxTokens: 16000,
      script: 'write-next-article',
    });
    const article = extractJson(text);
    if (!article) {
      problems =
        stopReason === 'max_tokens'
          ? ['長すぎて途中で切れました。節を4つまでに減らし、1つの節の段落は2つまで、引用は1〜2文にして、もっと短く書いてください']
          : ['JSON として読めませんでした。前置きも ``` の囲みも付けず、JSON だけを出力してください'];
      console.log(`    （返事は${text.length}文字、終わり方: ${stopReason}）`);
      continue;
    }
    article.id = topic.id; // IDは題材リストのものに固定する
    article.published_at = jstDate();

    problems = checkArticle(article, { sources });
    if (problems.length === 0) return { article, attempts: attempt };
    console.log(`  検査に通りませんでした（${problems.length}件）:`);
    problems.forEach(p => console.log(`    - ${p}`));
  }
  return { article: null, attempts: MAX_ATTEMPTS, problems };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const topicArg = process.argv.indexOf('--topic');
  const topicId = topicArg === -1 ? null : process.argv[topicArg + 1];

  const queue = readJson(QUEUE_PATH);
  const sources = readJson(SOURCES_PATH);
  const { topic, waiting } = pickTopic(queue, { topicId });

  if (!topic) {
    // 題材が尽きた／出典待ちのときは、薄い記事を作らずに止める。
    console.log(`書ける題材がありません（出典の登録・取得を待っている題材が${waiting}件）`);
    console.log('題材を足すには data/article-queue.json に、出典を足すには data/sources.json に追記して fetch-official.yml を実行してください');
    return;
  }

  console.log(`題材: #${topic.n} ${topic.title}（${topic.id}）`);
  console.log(`出典: ${topic.sources.join(', ')}`);
  if (dryRun) {
    console.log('[DRY RUN] ここで下書きを頼みます（APIは呼びません）');
    return;
  }

  const { article, problems } = await writeArticle(topic, sources);
  if (!article) {
    // 何度書き直しても通らないのは、たいてい出典のページにその話が書かれていないため。
    // 印をつけて次の題材へ進む。人が出典を足し直したら、印を消してまた書ける。
    console.error(`${MAX_ATTEMPTS}回書き直しても検査に通りませんでした。今日は公開しません`);
    problems.forEach(p => console.error(`  - ${p}`));
    const blocked = queue.map(t =>
      t.id === topic.id
        ? { ...t, status: 'blocked', blocked_reason: problems[0], blocked_at: jstDate() }
        : t
    );
    fs.writeFileSync(QUEUE_PATH, JSON.stringify(blocked, null, 2) + '\n');
    console.error(`「${topic.title}」に印をつけました。出典を足し直すまで飛ばします`);
    return;
  }

  fs.mkdirSync(ARTICLES_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARTICLES_DIR, `${topic.id}.json`), JSON.stringify(article, null, 2) + '\n');

  const updated = queue.map(t =>
    t.id === topic.id ? { ...t, status: 'published', published_at: article.published_at } : t
  );
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(updated, null, 2) + '\n');

  console.log(`書きました: data/articles/${topic.id}.json`);
  console.log(`自動で書いた記事: ${publishedCount()}本`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { pickTopic, publishedCount, systemPrompt, userPrompt, writeArticle };
