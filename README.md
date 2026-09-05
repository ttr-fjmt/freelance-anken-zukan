# フリーランス案件図鑑

転職エージェント比較サイト。以下2つの公的データソースに掲載された人材紹介・職業紹介事業者の
公開情報を定期的にクロールし、比較用データ（`agents.json`）として提供します。

- 厚生労働省委託「職業紹介優良事業者認定制度」（jesra.or.jp） — 認定事業者57社（全件を毎日再取得）
- 厚生労働省「人材サービス総合サイト」（jinzai.hellowork.mhlw.go.jp） — 全国の職業紹介事業者
  約38,000件超を、1日あたりの上限件数を決めて段階的に取り込み（詳しくは後述）

## 構成

```
index.html                   フロントエンド（agents.json を fetch して描画）
agents.json                 構造化済みの掲載データ（自動生成・コミットされる）
data/raw-agents.json        jesra.or.jp スクレイパーの生データ（自動生成・コミットされる、毎回全件を上書き）
data/mhlw-agents.json       MHLW取り込みの生データ（自動生成・コミットされる、日々追記で累積）
data/mhlw-cursor.json       MHLW取り込みの進捗カーソル（自動生成・コミットされる、次回再開位置を保持）
scraper/
  scrape.js                 jesra.or.jp のクロール（一覧のページネーション追跡→詳細ページ抽出）
  scrape-mhlw.js             MHLW「人材サービス総合サイト」の段階的取り込み（都道府県を順に巡回）
  structure.js               生データ（jesra・MHLW両方）を agents.json のスキーマに構造化（Claude Haiku 4.5 使用）
  import-a8.js                A8.netアフィリエイト提携エージェントのExcelを featured エージェントとして取り込む
  lib/robots.js              robots.txt の取得・判定
  lib/http.js                 UA・リクエスト間隔（ポライトネス）
  lib/mhlw.js                 MHLW用のCookieセッションクライアント・検索/ページング/詳細抽出
  lib/schema.js               カテゴリ一覧・共通定数
data/a8-import/               A8アフィリエイト提携情報のExcel（手動配置、ファイル名に取り込み日を含める）
.github/workflows/
  scrape-agents.yml           毎日深夜(JST)に自動実行するワークフロー
  import-a8.yml                A8アフィリエイトExcelの取り込み（workflow_dispatch専用）
```

## データパイプライン

1. **`scraper/scrape.js`** — jesra.or.jp の認定事業者一覧（`/yuryoshokai/certification/`）を
   ページネーションを辿って全件発見し、各詳細ページから企業名・サービス名・サービスURL・
   対応エリア・対応業界・対応職種・許可番号・手数料公表サイトURLなどの事実情報を抽出します。
   手数料公表サイトが判明した場合は、そのページを追加で取得します（HTMLはテキスト抽出、
   PDFは `pdf-parse` でテキスト抽出）。
   - リクエスト間隔は既定で3〜5秒（`SCRAPER_MIN_DELAY_MS` / `SCRAPER_JITTER_MS` で調整可）
   - `robots.txt` を毎回確認し、Disallow に該当するパスはスキップ／クロール中断します
   - 手数料公表サイトの取得に失敗した場合（404・タイムアウト・robots.txt禁止等）はスキップし、
     後段の構造化ステップで `非公開（お問い合わせで確認）` が維持されます
   - 出力: `data/raw-agents.json`

2. **`scraper/scrape-mhlw.js`**（[scraper/lib/mhlw.js](scraper/lib/mhlw.js)）— MHLW「人材サービス総合サイト」から
   全国の職業紹介事業者を段階的に取り込みます。このサイトの検索・ページングは隠しフィールドを多数持つ
   単一フォームをセッションCookie付きでPOSTし続ける実装のため、`lib/mhlw.js` が最小限のCookie保持
   （tough-cookie等は使わず、Set-Cookieをそのまま次リクエストに付け直すだけの自前実装）と、現在の
   フォームDOM状態をそのまま再送する汎用シリアライザで対応しています。個別の詳細ページ自体はGETのみ・
   セッション非依存で取得できることを確認済みです。
   - 47都道府県を順番に検索し、1回の実行で新規取得する詳細ページ数は
     `lib/mhlw.js` の `DAILY_DETAIL_LIMIT` 定数（既定500件、環境変数 `MHLW_DAILY_DETAIL_LIMIT` でも上書き可）まで
   - どの都道府県の何ページ目まで処理したかを `data/mhlw-cursor.json` に保存し、次回実行時はそこから再開します
     （ページ番号を直接指定してジャンプできることを確認済みのため、再開時に前のページを辿り直しません）
   - 取得した生データは `data/mhlw-agents.json` に日々追記で累積します（jesra側と異なり、まるごと上書きしません）
   - 既存 `agents.json` および `data/mhlw-agents.json` の許可番号（`companyDetail.permitNumber`）と突合し、
     すでに掲載済みの事業者（jesra由来57社を含む）はスキップします。同一許可番号で複数の事業所（支店）が
     出てくる場合は最初の1件のみ採用し、以降はスキップしてログに件数を出力します
   - 取得する項目: 企業名（事業主名称）・許可番号・所在地（都道府県）・取扱職種・年度別の就職者数/離職者数など。
     手数料・返戻金制度は今回のスコープ外のため取得せず、`agents.json` 化の際は常に `非公開（お問い合わせで確認）` になります
   - 日曜22:00〜月曜08:00 (JST) のMHLW定期メンテナンス時間帯は処理をスキップします（jesra側には影響しません）
   - 実測値（鳥取県114件・全件取得): 一覧ページ取得 約27秒、詳細ページ取得114件で約10分22秒（1件平均約5.5秒）。
     500件/日ペースだと詳細取得だけで約28〜30分。全国約38,000件の完全消化には500件/日で概ね2〜3ヶ月かかる見込みです

4. **`scraper/structure.js`** — jesra・MHLW双方の生データと既存の `agents.json` を比較し、内容に差分がある
   事業者のみ Claude Haiku 4.5（`ANTHROPIC_API_KEY`）に投げて `agents.json` のスキーマに
   構造化します（差分のない事業者は前回の結果を再利用し、APIコストを抑えます。差分判定には
   jesra側は手数料公表サイトのテキスト、MHLW側は年度別統計等を含みます）。
   事業者コメント等の本文はそのまま転載せず、事実の要約にとどめるよう指示しています。
   - jesra由来: 手数料公表サイトのテキストが「職業安定法の届出制手数料表の上限額」なのか「実際の相場」
     なのかをAIが文脈から判断し、上限額しか読み取れない場合は業界相場の推定値を主に、届出上限を
     括弧内に併記します（例:「理論年収の30〜35%程度（業界相場からの推定値。公式の届出上限は
     賃金の150%）」）。返戻金制度（返金保証）の記載があれば `companyDetail.refundPolicy` に反映します
   - MHLW由来: 手数料公表サイトの情報を今回取得していないため、`feeRate` / `companyDetail.refundPolicy` /
     `companyDetail.upfrontFee` は常に `非公開（お問い合わせで確認）` になるようAIに明示指示しています
   - カテゴリ分類は両ソース共通で、`lib/schema.js` の9種類（8業種＋「その他」）のいずれか一字一句を厳守するよう
     プロンプトとツールスキーマの両方で指示。Anthropicのtool useはenum制約をサーバー側で厳密には強制しない
     ため、コード側でも未知のカテゴリ文字列が返った場合は「その他」に丸めるフォールバックを入れています
   - 取得できなかった項目は `非公開（お問い合わせで確認）` として埋められます
   - `ANTHROPIC_API_KEY` が未設定の場合はオフラインフォールバックで動作し、生データから
     直接組み立てます（次回キーがある実行時に自動で再構造化されます）
   - 出力: `agents.json`

5. **`.github/workflows/scrape-agents.yml`** — 毎日 18:30 UTC（JST 3:30、深夜帯）に上記の
   `scrape.js` → `scrape-mhlw.js` → `structure.js` を順に実行し、差分があれば
   `agents.json` / `data/raw-agents.json` / `data/mhlw-agents.json` / `data/mhlw-cursor.json` を
   コミット・pushします。`workflow_dispatch` にも対応しているので、GitHub の Actions タブから
   手動実行もできます。

6. **`scraper/import-a8.js`** — A8.netのアフィリエイト提携エージェント一覧（Excel、ヘッダー行:
   広告主名／リンク／このエージェントの特徴／対応エリア／対象年代／なにに特化しているか）を
   `agents.json` に `featured: true` のエージェントとして取り込みます。日次スクレイプには含まれず、
   `.github/workflows/import-a8.yml`（`workflow_dispatch` 専用、入力でExcelファイルのパスを指定）
   から手動実行します。
   - `リンク`列のHTML文字列から `<a href="...">` のURLのみを抽出（1x1トラッキング画像タグは無視）し
     `affiliateUrl` に設定します
   - 完全一致ではなく**広告主名（会社名）のみ**をキーに重複除去します（1社1行に強制的に絞り込み、
     2件目以降はスキップしてログ出力）
   - 既存 `agents.json` と会社名で突き合わせ:
     - マッチした場合 → 既存エントリを**マージ更新**します。`category`/`region`/`targetAge`/
       紹介文まわり（`oneLiner`/`appeal`等）・`featured`・`affiliateUrl` のみExcel側（AI構造化結果）
       で上書きし、`website`/`feeRate`/`companyDetail`等、Excelに元々情報が無い項目は**既存の値を
       温存**します（`id`・`source`は変更しません）
     - マッチしない場合 → 新規エントリとして追加します（`id`: `a8-001`のような連番、`source: "a8"`、
       `website`: `null`、`companyDetail`等の未取得項目は`非公開（お問い合わせで確認）`固定）
   - カテゴリ分類・紹介文の生成には `structure.js` の `buildWithAI`（`source: "a8"` 分岐）を再利用し、
     `ANTHROPIC_API_KEY` 未設定時はオフラインフォールバックで動作します
   - 取り込み後、`prerender.js` / `generate-sitemap.js` も実行し、新規・更新分の静的詳細ページと
     サイトマップを反映します

## セットアップ

1. リポジトリの Settings → Secrets and variables → Actions で `ANTHROPIC_API_KEY` を登録する
2. Settings → Pages で Source を「Deploy from a branch」→ `main` / `/ (root)` に設定する
   （`index.html` がルートにあるため、追加設定なしでトップページとして公開されます）
3. Actions タブから `Scrape agents and update agents.json` を手動実行し、初回データを生成する

## ローカルでの動作確認

```bash
cd scraper
npm install
node scrape.js                                    # data/raw-agents.json を生成（jesra全件）
node scrape-mhlw.js                                # data/mhlw-agents.json に新規分を追記（1回の上限は DAILY_DETAIL_LIMIT 件）
ANTHROPIC_API_KEY=sk-ant-... node structure.js     # agents.json を生成（キー無しならオフラインモード）
```

`scrape-mhlw.js` の1回あたり取り込み件数を一時的に変えたい場合は環境変数で上書きできます:

```bash
MHLW_DAILY_DETAIL_LIMIT=5 node scrape-mhlw.js
```

A8アフィリエイト提携エージェントのExcelを取り込む場合（`data/a8-import/` にファイルを配置してから）:

```bash
cd scraper
ANTHROPIC_API_KEY=sk-ant-... node import-a8.js ../data/a8-import/a8-agents-YYYYMMDD.xlsx
node import-a8.js ../data/a8-import/a8-agents-YYYYMMDD.xlsx --dry-run   # 書き込まず確認のみ
```
