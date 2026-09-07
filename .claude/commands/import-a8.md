---
description: A8アフィリエイト案件のExcel(data/a8-import/アフィリエイト案件_フリーランス案件図鑑.xlsx)の更新をコミット・pushし、import-a8ワークフローの実行を案内する
---

data/a8-import/アフィリエイト案件_フリーランス案件図鑑.xlsx の
更新を、以下の手順で処理してください。

1. git fetch origin && git status で、リモートに新規コミットが
   無いか確認する(あればgit pull --ff-onlyで最新化)
2. 対象のExcelファイルに変更があるか git status で確認する
3. 変更があれば、以下でステージング・コミットする

   git add "data/a8-import/アフィリエイト案件_フリーランス案件図鑑.xlsx"

   コミットメッセージ: "chore: A8アフィリエイト案件のExcelを更新"

4. git push -u origin main でリモートにpushする
5. push完了後、以下をユーザーに案内する:
   「GitHubの Actions タブから『Import A8 affiliate agents』
   ワークフローを手動実行してください
   (https://github.com/ttr-fjmt/freelance-anken-zukan/actions/workflows/import-a8.yml
   → Run workflow → 何も入力せず実行)」
6. もし gh CLI が利用可能であれば、
   `gh workflow run import-a8.yml` で直接実行し、
   `gh run watch` で完了を待って結果を報告してもよい
   (利用可能か事前に確認すること)
7. 実行完了後(ユーザーから結果を共有された場合、またはgh経由で
   自己完結できた場合)、何件のadd/updateが行われたかを要約して
   報告する

Excelに変更が無い場合は、その旨を伝えて終了してください
(無理にコミットしない)。
