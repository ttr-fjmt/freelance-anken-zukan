'use strict';

/**
 * 解説記事（/guide/ 以下）を書き出す。
 *
 * 【なぜ作ったか】
 * 姉妹サイトの転職エージェント図鑑が AdSense の審査で「有用性の低いコンテンツ」と判定された。
 * このサイトにも独自に書いた解説が1本も無かったので、フリーランスが案件を受けるときに
 * 実際に迷う点を解説する記事を置き、Google に評価してもらう中心にする。
 *
 * 【書き方の約束】
 * 法律・日付・期間など事実に当たる記述は、厚生労働省・公正取引委員会の公式ページで
 * 確認できたものだけにし、記事末尾に出典を必ず載せる（このリポジトリの
 * 「確認できないことは書かない」原則を記事にも適用する）。
 * どの義務がどの発注事業者に適用されるかなど、公式ページの本文で確認しきれなかった条件は
 * 断定せず、公式のQ&Aを確認するよう案内する。手数料の料率や相場も書かない。
 *
 * 実行: cd scraper && node generate-guide-pages.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GUIDE_DIR = path.join(ROOT, 'guide');
const BASE_URL = 'https://freelance-anken-zukan.net';
const SITE_NAME = 'フリーランス案件図鑑';
const GUIDE_NAME = 'フリーランスガイド';
const PUBLISHED = '2026-09-12';
const GA_ID = 'G-YS6S43LSBK';
const ADSENSE = '<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-5761092657360295" crossorigin="anonymous"></script>';

/** 出典。記事ごとに参照するものを選ぶ。 */
const SOURCES = {
  mhlw: {
    label: '厚生労働省「フリーランスとして業務を行う方・フリーランスの方に業務を委託する事業者の方等へ」',
    url: 'https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/koyou_roudou/koyoukintou/zaitaku/index_00002.html',
  },
  jftcQa: {
    label: '公正取引委員会「フリーランス・事業者間取引適正化等法 Q&A」',
    url: 'https://www.jftc.go.jp/fllaw_limited/fllaw_qa.html',
  },
  jftc: {
    label: '公正取引委員会「フリーランス・事業者間取引適正化等法」',
    url: 'https://www.jftc.go.jp/fllaw_limited.html',
  },
  trouble110: {
    label: 'フリーランス・トラブル110番',
    url: 'https://freelance110.mhlw.go.jp/',
  },
};

const GUIDES = [
  {
    slug: 'freelance-act',
    title: 'フリーランス新法（フリーランス・事業者間取引適正化等法）で何が変わった？',
    description: '令和6年11月1日に施行された「フリーランス・事業者間取引適正化等法」について、対象になるフリーランス、発注事業者に求められる主なルール、困ったときの相談先を、厚生労働省・公正取引委員会の公開情報をもとに解説します。',
    sources: ['mhlw', 'jftc', 'jftcQa', 'trouble110'],
    body: `
<p class="lead">フリーランスとして仕事を受けるときの取引ルールを定めた法律が、<strong>令和6年11月1日</strong>に施行されました。一般に「フリーランス新法」と呼ばれることもあります。この記事では、フリーランスの立場から押さえておきたい点を整理します。</p>

<h2>正式な名前と施行日</h2>
<p>正式な名前は<strong>「特定受託事業者に係る取引の適正化等に関する法律」</strong>で、「フリーランス・事業者間取引適正化等法」とも呼ばれます。施行日は<strong>令和6年11月1日</strong>です。</p>

<h2>対象になる「フリーランス」</h2>
<p>この法律でいうフリーランス（特定受託事業者）は、<strong>個人で事業を行い、発注事業者から業務の委託を受ける人</strong>です。ただし、従業員を雇用している個人事業者などは対象から外れます。</p>
<p>職種による限定はないため、エンジニア、デザイナー、ライター、コンサルタントなど、業務委託で仕事を受けている多くの人が関係します。</p>

<h2>発注事業者に求められる主なルール</h2>
<p>厚生労働省の案内では、発注事業者に求められる主なルールとして、次のものが挙げられています。</p>
<ul>
  <li>書面などによる<strong>取引条件の明示</strong></li>
  <li><strong>報酬の支払期日の設定</strong>と、期日内の支払い</li>
  <li><strong>禁止行為</strong>（受領拒否、報酬の減額、返品、買いたたき など）の遵守</li>
  <li>募集するときの<strong>募集情報の的確な表示</strong></li>
  <li>育児・介護などと業務の<strong>両立への配慮</strong></li>
  <li><strong>ハラスメント対策</strong>のための体制整備</li>
  <li>契約の<strong>中途解除などの事前予告</strong>と理由の開示</li>
</ul>
<p>このうちどのルールが適用されるかは、<strong>発注事業者が従業員を使用しているか</strong>や、<strong>業務委託の期間</strong>によって異なります。自分の取引に当てはまるかどうかは、公正取引委員会のQ&Aなど公式の情報で確認してください。</p>
<p>契約前に具体的に何を確認すればよいかは、<a href="/guide/contract-checklist/">業務委託を受ける前に確認したい3つのこと</a>で解説しています。</p>

<h2>困ったときの相談先</h2>
<p>報酬が支払われない、一方的に条件を変えられたなど、発注事業者とのトラブルで困ったときは、<strong>「フリーランス・トラブル110番」</strong>に相談できます。弁護士に無料で相談できる窓口です。</p>
<p>ひとりで抱え込まず、早めに相談することをおすすめします。</p>

<h2>このサイトとの関係</h2>
<p>フリーランス案件図鑑では、フリーランス向けの案件紹介・マッチングサービスを比較できます。サービスを選ぶときは、紹介される案件の内容だけでなく、<strong>契約の相手が誰になるのか</strong>、<strong>取引条件がどのように示されるのか</strong>もあわせて確認しておくと安心です。サービスの種類による違いは、<a href="/guide/agent-vs-platform/">エージェント型とマッチング型の違い</a>で解説しています。</p>
`,
  },
  {
    slug: 'contract-checklist',
    title: '業務委託を受ける前に確認したい3つのこと',
    description: 'フリーランスが業務委託で仕事を受ける前に確認しておきたい、取引条件の明示、報酬の支払期日、契約の途中解除のルールを、公正取引委員会のQ&Aをもとに解説します。',
    sources: ['jftcQa', 'mhlw', 'trouble110'],
    body: `
<p class="lead">業務委託の仕事は、始まってから「聞いていた条件と違う」とならないように、<strong>受ける前の確認</strong>が大切です。フリーランス・事業者間取引適正化等法の考え方をもとに、確認しておきたい3つのポイントを紹介します。</p>

<h2>1. 取引条件が書面などで示されているか</h2>
<p>公正取引委員会のQ&Aでは、業務を委託する事業者が明示すべき事項として、次のものが挙げられています。</p>
<ol>
  <li>業務委託事業者と、フリーランスの名称</li>
  <li>業務委託をした日</li>
  <li>給付・役務の内容</li>
  <li>給付・役務提供の期日</li>
  <li>給付・役務提供の場所</li>
  <li>報酬の額と支払期日</li>
  <li>（検査をする場合）検査を完了する期日</li>
  <li>（現金以外の方法で支払う場合）支払方法に関すること</li>
</ol>
<p>口頭だけのやり取りで仕事を始めてしまうと、あとで条件を確かめるのが難しくなります。<strong>メールやチャット、契約書など、あとから見返せる形</strong>でこれらが示されているかを確認しましょう。</p>

<h2>2. 報酬の支払期日はいつか</h2>
<p>法律では、報酬の支払期日について、<strong>給付を受領した日から起算して60日以内のできる限り短い期間内</strong>で定めるというルールが設けられています。</p>
<p>「月末締め翌々月末払い」のような支払サイトは、案件によってまちまちです。<strong>いつ納品したら、いつ支払われるのか</strong>を、契約の前に具体的な日付で確認しておくと安心です。</p>
<p>なお、このルールがどの発注事業者との取引に適用されるかなどの詳しい条件は、公正取引委員会のQ&Aで確認してください。</p>

<h2>3. 契約期間と、途中で終わる場合のルール</h2>
<p>長く続く案件ほど、途中で契約が終わったときの影響は大きくなります。法律では、<strong>6か月以上の期間行う業務委託</strong>の契約を途中で解除したり、更新しなかったりする場合、原則として<strong>少なくとも30日前までに予告</strong>するルールが設けられています。</p>
<p>契約期間がどのくらいか、更新はどう決まるのか、途中で終了するときはどう連絡されるのかを、事前に確認しておきましょう。</p>

<h2>あわせて知っておきたい「禁止行為」</h2>
<p>一定の条件にあたる業務委託では、発注事業者が次のような行為をすることが禁止されています。</p>
<ul>
  <li>成果物の受け取りを拒むこと（受領拒否）</li>
  <li>あとから報酬を減らすこと（報酬の減額）</li>
  <li>受け取った成果物を返すこと（返品）</li>
  <li>相場に比べて著しく低い報酬を一方的に決めること（買いたたき）</li>
  <li>物の購入やサービスの利用を強制すること</li>
  <li>不当に金銭などの提供を求めること</li>
  <li>不当に業務の内容を変えたり、やり直させたりすること</li>
</ul>
<p>「こういう場合も当てはまるのか」と迷ったときは、公式のQ&Aを確認するか、<strong>フリーランス・トラブル110番</strong>に相談してください。</p>

<h2>まとめ</h2>
<ul>
  <li>取引条件は、あとから見返せる形で示してもらう</li>
  <li>報酬の支払期日は、具体的な日付で確認する</li>
  <li>契約期間と、途中で終わる場合の連絡方法を確認する</li>
</ul>
<p>法律の全体像は<a href="/guide/freelance-act/">フリーランス新法で何が変わった？</a>で解説しています。</p>
`,
  },
  {
    slug: 'agent-vs-platform',
    title: 'エージェント型とマッチング型、フリーランス案件サービスの違い',
    description: 'フリーランス向けの案件サービスには、担当者が案件を紹介する「エージェント型」と、自分で案件を探して応募する「マッチング型」があります。それぞれの向き不向きと、契約の相手を確認する大切さを解説します。',
    sources: ['jftcQa', 'mhlw'],
    body: `
<p class="lead">フリーランス向けの案件サービスは数多くありますが、仕組みで見ると大きく2つのタイプに分けられます。自分の働き方に合うタイプを選ぶと、案件探しの手間やミスマッチを減らしやすくなります。</p>

<h2>エージェント型</h2>
<p>担当者がスキルや希望条件を聞き取り、<strong>条件に合う案件を紹介してくれる</strong>タイプです。案件によっては、企業との条件のすり合わせを担当者が間に入って進めてくれます。</p>
<ul>
  <li><strong>向いている人</strong>：営業や条件交渉に時間をかけたくない人、中長期で安定した案件を探したい人</li>
  <li><strong>確認したい点</strong>：紹介される案件の分野・稼働日数、契約や報酬の支払いの流れ</li>
</ul>

<h2>マッチング型</h2>
<p>サービス上に掲載された案件を<strong>自分で探して応募する</strong>タイプです。クラウドソーシングと呼ばれるサービスもこちらに含まれます。</p>
<ul>
  <li><strong>向いている人</strong>：自分のペースで案件を選びたい人、単発や短期の案件から実績を積みたい人</li>
  <li><strong>確認したい点</strong>：発注者とのやり取りの方法、報酬の受け取り方、トラブル時のサポート</li>
</ul>

<h2>「契約の相手は誰か」を確認する</h2>
<p>どちらのタイプでも、<strong>実際に業務委託契約を結ぶ相手が誰になるのか</strong>は必ず確認しておきましょう。案件を発注する企業と直接契約する場合もあれば、サービスを運営する会社と契約する場合もあります。</p>
<p>公正取引委員会のQ&Aでは、マッチングサービスを提供する事業者の扱いについて、次のように説明されています。</p>
<blockquote>マッチングサービスを提供する事業者が、受注事業者との間で委託業務に係る業務委託契約を締結していない場合であって実質的に受注事業者に対して業務委託をしているといえる場合は、当該受注事業者との関係では発注事業者は『業務委託事業者』とはならず、マッチングサービスを提供する事業者が『業務委託事業者』となります</blockquote>
<p>つまり、形式上の契約だけでなく<strong>実態</strong>によって、法律上の発注者が誰になるかが判断されることがあります。取引条件の確認先や、困ったときの相談先を間違えないためにも、契約の相手と責任の範囲をはっきりさせておくことが大切です。</p>

<h2>組み合わせて使うのも一つの方法</h2>
<p>エージェント型で安定した案件を確保しつつ、マッチング型で新しい分野の案件に挑戦する、という使い分けもできます。登録するサービスが増えるほど、連絡や稼働の管理は大変になるので、無理なく管理できる範囲で選びましょう。</p>

<h2>このサイトでの探し方</h2>
<p>フリーランス案件図鑑では、案件サービスを得意な分野ごとに分けて掲載しています。公式サイトの本文から確認できなかった項目は、推測で埋めずに「非公開（お問い合わせで確認）」と表示しています。気になるサービスが見つかったら、公式サイトで最新の条件もあわせて確認してください。</p>
<p>業務委託を受ける前のチェックポイントは、<a href="/guide/contract-checklist/">業務委託を受ける前に確認したい3つのこと</a>で解説しています。</p>
`,
  },
];

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** faq.html から、アクセス解析（運営者の除外スイッチ＋gtag）のまとまりをそのまま借りる。 */
function readAnalyticsBlock() {
  const faq = fs.readFileSync(path.join(ROOT, 'faq.html'), 'utf8');
  const start = faq.indexOf('<!-- 運営者自身のアクセスを計測しないためのスイッチ。');
  const configAt = faq.indexOf(`gtag('config', '${GA_ID}');`);
  const end = configAt < 0 ? -1 : faq.indexOf('</script>', configAt);
  if (start < 0 || configAt < 0 || end < 0) {
    throw new Error('faq.html からアクセス解析のタグを取り出せませんでした');
  }
  return faq.slice(start, end + '</script>'.length);
}

const STYLE = `<style>
  :root{
    --ink:#17211D; --paper:#F8F5EE; --surface:#FFFFFF; --line:#E4DFD1;
    --accent:#1D5FA8; --accent-deep:#123A6B; --accent-soft:#DCE8F5;
    --gold:#B8863B; --ink-soft:#5B6660; --ink-faint:#8B9490;
  }
  *{box-sizing:border-box;}
  body{margin:0;background:var(--paper);color:var(--ink);
    font-family:'Zen Kaku Gothic New', sans-serif;-webkit-font-smoothing:antialiased;}
  .wrap{max-width:720px;margin:0 auto;padding:56px 16px 100px;}
  .back-btn{background:var(--surface);border:1px solid var(--line);border-radius:999px;
    color:var(--ink-soft);font-size:13px;font-weight:500;padding:9px 16px 9px 12px;margin-bottom:28px;
    display:inline-flex;align-items:center;gap:6px;text-decoration:none;transition:border-color .12s,color .12s;}
  .back-btn:hover{border-color:var(--accent);color:var(--ink);}
  .back-btn svg{width:16px;height:16px;flex-shrink:0;}
  .crumbs{font-size:12.5px;color:var(--ink-faint);margin:0 0 10px;}
  .crumbs a{color:var(--ink-faint);text-decoration:none;}
  .crumbs a:hover{color:var(--accent);text-decoration:underline;}
  h1{font-family:'Shippori Mincho', serif;font-weight:600;font-size:clamp(24px,3.6vw,31px);
    line-height:1.45;margin:0 0 10px;letter-spacing:.01em;}
  .meta{font-size:12.5px;color:var(--ink-faint);margin:0 0 32px;}
  h2{font-size:18px;font-weight:700;color:var(--ink);margin:40px 0 14px;
    padding-left:12px;border-left:3px solid var(--gold);line-height:1.5;}
  h3{font-size:15.5px;font-weight:700;color:var(--ink);margin:26px 0 8px;line-height:1.6;}
  p,li{font-size:15px;line-height:1.95;color:var(--ink-soft);}
  p{margin:0 0 14px;}
  p.lead{color:var(--ink);font-size:15.5px;}
  strong{color:var(--ink);}
  ul,ol{margin:0 0 16px;padding-left:1.4em;}
  li{margin:0 0 6px;}
  a{color:var(--accent);}
  blockquote{margin:0 0 16px;padding:14px 18px;background:var(--surface);border:1px solid var(--line);
    border-left:3px solid var(--accent);border-radius:8px;font-size:14.5px;line-height:1.9;color:var(--ink);}
  .sources{margin-top:48px;padding:18px 20px;background:var(--surface);border:1px solid var(--line);border-radius:12px;}
  .sources h2{margin:0 0 10px;font-size:15px;border-left:none;padding-left:0;}
  .sources li{font-size:13px;line-height:1.8;}
  .sources .note{font-size:12.5px;color:var(--ink-faint);margin:10px 0 0;}
  .guide-list{list-style:none;padding:0;margin:0;display:grid;gap:12px;}
  .guide-list a{display:block;padding:18px 20px;background:var(--surface);border:1px solid var(--line);
    border-radius:12px;text-decoration:none;transition:border-color .12s,box-shadow .12s;}
  .guide-list a:hover{border-color:var(--accent);box-shadow:0 4px 16px rgba(23,33,29,.06);}
  .guide-list .t{display:block;font-size:16px;font-weight:700;color:var(--ink);line-height:1.6;margin-bottom:4px;}
  .guide-list .d{display:block;font-size:13.5px;line-height:1.8;color:var(--ink-soft);}
  .related{margin-top:36px;}
  .related h2{font-size:15px;}
  .footer-links{margin-top:48px;padding-top:20px;border-top:1px solid var(--line);font-size:13px;}
  .footer-links a{color:var(--accent);text-decoration:none;font-weight:500;}
  .footer-links a:hover{text-decoration:underline;}
</style>`;

const BACK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';
const FOOTER = `<div class="footer-links"><a href="/">トップページ</a> / <a href="/guide/">${GUIDE_NAME}</a> / <a href="/faq.html">よくある質問</a> / <a href="/privacy.html">プライバシーポリシー</a></div>`;

function head({ title, description, url, jsonLd, analytics, type }) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${url}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="${type}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${BASE_URL}/ogp-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
${ADSENSE}
${analytics}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Shippori+Mincho:wght@600&family=Zen+Kaku+Gothic+New:wght@400;500;700&display=swap" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
${STYLE}
</head>`;
}

function formatDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${y}年${m}月${d}日`;
}

function cardList(guides) {
  return guides.map(g =>
    `    <li><a href="/guide/${g.slug}/"><span class="t">${escapeHtml(g.title)}</span><span class="d">${escapeHtml(g.description)}</span></a></li>`
  ).join('\n');
}

function buildArticle(guide, analytics) {
  const url = `${BASE_URL}/guide/${guide.slug}/`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'ホーム', item: `${BASE_URL}/` },
          { '@type': 'ListItem', position: 2, name: GUIDE_NAME, item: `${BASE_URL}/guide/` },
          { '@type': 'ListItem', position: 3, name: guide.title, item: url },
        ],
      },
      {
        '@type': 'Article',
        headline: guide.title,
        description: guide.description,
        inLanguage: 'ja',
        datePublished: PUBLISHED,
        dateModified: PUBLISHED,
        mainEntityOfPage: url,
        author: { '@type': 'Organization', name: SITE_NAME, url: `${BASE_URL}/` },
        publisher: { '@type': 'Organization', name: SITE_NAME, url: `${BASE_URL}/` },
      },
    ],
  };
  const sources = guide.sources.map(key => {
    const s = SOURCES[key];
    if (!s) throw new Error(`記事「${guide.slug}」の出典 ${key} が未定義です`);
    return `    <li><a href="${s.url}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.label)}</a></li>`;
  }).join('\n');

  return `${head({ title: `${guide.title}｜${SITE_NAME}`, description: guide.description, url, jsonLd, analytics, type: 'article' })}
<body>
<div class="wrap">
  <a class="back-btn" href="/guide/">${BACK_ICON}${GUIDE_NAME}一覧へ</a>
  <p class="crumbs"><a href="/">ホーム</a> ／ <a href="/guide/">${GUIDE_NAME}</a></p>
  <h1>${escapeHtml(guide.title)}</h1>
  <p class="meta">公開日：${formatDate(PUBLISHED)}　／　${SITE_NAME}編集部</p>
${guide.body.trim()}

  <div class="sources">
    <h2>出典・参考にした公式情報</h2>
    <ul>
${sources}
    </ul>
    <p class="note">制度の内容や解釈は変わることがあります。最新の情報や、ご自身の取引に当てはまるかどうかは、上記の公式ページでご確認ください。</p>
  </div>

  <div class="related">
    <h2>あわせて読みたい</h2>
    <ul class="guide-list">
${cardList(GUIDES.filter(g => g.slug !== guide.slug))}
    </ul>
  </div>

  ${FOOTER}
</div>
</body>
</html>
`;
}

function buildIndex(analytics) {
  const url = `${BASE_URL}/guide/`;
  const description = 'フリーランス新法のポイント、業務委託を受ける前の確認事項、案件サービスの種類の違いなど、フリーランスとして案件を受ける前に知っておきたいことを、厚生労働省・公正取引委員会の公式情報をもとに解説します。';
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'ホーム', item: `${BASE_URL}/` },
          { '@type': 'ListItem', position: 2, name: GUIDE_NAME, item: url },
        ],
      },
      {
        '@type': 'CollectionPage',
        name: GUIDE_NAME,
        url,
        inLanguage: 'ja',
        hasPart: GUIDES.map(g => ({ '@type': 'Article', headline: g.title, url: `${BASE_URL}/guide/${g.slug}/` })),
      },
    ],
  };
  return `${head({ title: `${GUIDE_NAME}｜${SITE_NAME}`, description, url, jsonLd, analytics, type: 'website' })}
<body>
<div class="wrap">
  <a class="back-btn" href="/">${BACK_ICON}トップに戻る</a>
  <p class="crumbs"><a href="/">ホーム</a></p>
  <h1>${GUIDE_NAME}</h1>
  <p class="meta">フリーランスとして案件を受ける前に知っておきたいこと</p>
  <p class="lead">フリーランス新法のポイントや、業務委託を受ける前に確認したいことを解説しています。法律に関する記述は、厚生労働省・公正取引委員会の公式情報をもとにしています。</p>
  <ul class="guide-list">
${cardList(GUIDES)}
  </ul>
  ${FOOTER}
</div>
</body>
</html>
`;
}

function main() {
  const analytics = readAnalyticsBlock();
  fs.mkdirSync(GUIDE_DIR, { recursive: true });
  const keep = new Set(GUIDES.map(g => g.slug));
  for (const name of fs.readdirSync(GUIDE_DIR)) {
    const target = path.join(GUIDE_DIR, name);
    if (keep.has(name) || !fs.statSync(target).isDirectory()) continue;
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`[guide] removed stale page: guide/${name}/`);
  }
  for (const guide of GUIDES) {
    const dir = path.join(GUIDE_DIR, guide.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), buildArticle(guide, analytics), 'utf8');
    console.log(`[guide] ${guide.slug}: 本文 ${guide.body.replace(/<[^>]+>/g, '').replace(/\s+/g, '').length}字`);
  }
  fs.writeFileSync(path.join(GUIDE_DIR, 'index.html'), buildIndex(analytics), 'utf8');
  console.log(`Generated ${GUIDES.length} guide page(s) + guide/index.html.`);
}

if (require.main === module) main();

module.exports = { GUIDES, SOURCES, buildArticle, buildIndex };
