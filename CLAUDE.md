# CLAUDE.md

このリポジトリ（freelance-anken-zukan.net / フリーランス案件図鑑）で作業するときは、
**まず次の2つを読むこと。**

1. **[PROJECT_CONTEXT.md](PROJECT_CONTEXT.md)** — 図鑑シリーズ3サイト共通の背景、運営者（Tatsuroさん）について、
   確認すべきこと／不要なこと、データ品質の原則
2. **[DECISIONS.md](DECISIONS.md)** — Tatsuroさんがこれまでに決めたことと、現在の状況（AdSense など）。
   **ここにある判断を覆す提案をする前に、理由と「見直す条件」を必ず読むこと**

> README の「構成」節は転職エージェント図鑑から写したままの部分があり、jesra・厚労省データの取り込みが
> 書かれているが、**このサイトの日次処理では使っていない**（下の「毎日動いている処理」が実際の流れ）。

## 特に外してはいけない点

- **Tatsuroさんはエンジニアではない。** 報告・質問は平易な言葉で。「何のための変更か」を一言でまとめてから、
  判断に必要な範囲だけ説明する
- **確認を求めるのは PROJECT_CONTEXT.md の「確認すべき」項目に該当するときだけ。**
  既存ルールの適用、既知パターンの修正、テスト・ガードの追加、明らかなバグ修正は自律的に進める
- **公式サイトの本文に書かれていないことは、AIに絶対に作らせない。** プロンプトに書いたルールは、
  必ず機械的なチェックとしても実装する。本文が取れないときは `NOT_DISCLOSED_TEXT`（lib/schema.js）の定型文にする
- **確認できない情報は埋めない。** 「非公開（お問い合わせで確認）」のまま残す

## 毎日動いている処理

`.github/workflows/discover-agents.yml` が毎日 JST 5:00 に実行される。

1. `discover-agents.js` — AIのWeb検索でフリーランス向け案件サービスを探し、公式サイトにアクセスして実在を照合し、
   構造化して `agents.json` に追加する（`ANTHROPIC_API_KEY` を使用）。追加後にカテゴリーを9分類へまとめ直す
2. `prerender.js` → `generate-category-pages.js` → `generate-sitemap.js`

手動実行のワークフロー：
- `import-a8.yml` — A8 提携サービスの取り込み（Claude Code では `/import-a8`）
- `backfill-company-features.yml` — 企業向けの特徴の後から補完

`scrape.js`・`scrape-mhlw.js`・`enrich-mhlw-websites.js` は転職エージェント図鑑から分かれたときの名残で、
どのワークフローからも実行されていない。

## このリポジトリで決めている線引き（変えるときは理由ごと README と DECISIONS.md に残す）

- **掲載をやめるサービス**：終了したサービスや案件サービスではない企業は `agents.json` から外し、
  **`data/agent-discover-skip.json` に理由（`discontinued` / `out_of_scope`）と説明（`note`）つきで登録する**。
  登録しないと日次の発見で再び掲載される。`test/listing-scope.test.js` が再掲載を見張っている
- **検索対象（インデックス）**：[scraper/lib/indexing.js](scraper/lib/indexing.js) の1か所で決める。
  特徴が0件で、紹介文に「本文を確認できなかった」「サービスを終了した」旨があるページは noindex・サイトマップ除外
  （サイトには残す）。紹介文の言い回しだけでは外さない。`prerender.js`・`generate-category-pages.js`・
  `generate-sitemap.js` の3か所で同じ線引きを使う
- **カテゴリー**：[scraper/lib/schema.js](scraper/lib/schema.js) の9分類だけ。カテゴリーを自動で増やす仕組みは、
  同じ意味の分類が割れたため廃止した。まとめ方は [scraper/lib/category-merge.js](scraper/lib/category-merge.js)。
  掲載0件のカテゴリーはページも入口も出さない
- **解説記事（/guide/、フリーランスガイド）**：[scraper/generate-guide-pages.js](scraper/generate-guide-pages.js) から書き出す。
  法律・日付・期間は厚生労働省・公正取引委員会の公式ページで確認できたものだけを書き、出典を載せる。
  どの義務がどの発注事業者に適用されるかなど、公式ページで確認しきれない条件は断定しない。手数料の料率や相場は書かない
- **AdSense のタグ**は、固定ページ（index / faq / privacy / 404）と記事ページの `<head>` に静的に置く

## よく使うコマンド

```bash
cd scraper
npm test                          # ユニットテスト
node generate-guide-pages.js      # 解説記事を書き出す
node generate-category-pages.js   # カテゴリーページを作り直す
node generate-sitemap.js          # サイトマップを作り直す
node merge-categories.js          # カテゴリーを9分類にまとめ直す
node prerender.js                 # 静的ページ（約140件）。index.html を変えると全件作り直しになる
npm run verify-live               # 公開サイトがリポジトリどおりか確認（main への反映が終わったあと）
```

Windows で `prerender.js` のブラウザがアプリケーション制御にブロックされたときの対処は README の末尾にある。

## クラウド（Claude Code on the web）で作業するとき

パソコンを起動していなくても、スマホや claude.ai/code からクラウドのセッションで作業できる。
パソコンでの作業とは次の点が違う。

- **読めるのは、このリポジトリにコミットされているファイルだけ。** パソコン側の設定・メモは引き継がれない。
  方針と判断は `CLAUDE.md`・`PROJECT_CONTEXT.md`・`DECISIONS.md` に書いてあるものがすべて
- **`git push` はセッションの作業ブランチにしかできない。** 変更は PR にまとめ、Tatsuroさんがマージして初めて公開される。
  PR には「何のための変更か」を平易な言葉で一言書く
- **通信できるのは、クラウド環境の設定で許可したドメインだけ。** 各サービスの公式サイトは許可リストに無いことが多いので、
  掲載内容の照合は日次ワークフローに任せる。確認できなかったときは推測で埋めずにそう報告する
- **`ANTHROPIC_API_KEY` を使う処理は GitHub Actions で動かす。** 必要なら `gh workflow run discover-agents.yml` などで起動し、
  結果は `gh run view` で確認する

## 作業を終えるときの確認

- `npm test` が通っているか
- index.html・カテゴリー・線引きを変えたなら、静的ページ・カテゴリーページ・サイトマップを作り直したか
- サービスを一覧から外したなら、スキップリストに理由つきで登録したか
- 新しいフィールドや記事の数字を足したなら、本文・公式情報と照合するガードとテストも足したか
- main に反映したら、`npm run verify-live` で公開サイトを確認したか（反映直後に失敗したら数分おいて再実行）
- Tatsuroさんが新しく判断したことがあれば、`DECISIONS.md` に日付つきで追記したか
