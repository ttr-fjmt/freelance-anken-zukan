---
description: A8アフィリエイト案件のExcel(data/a8-import/アフィリエイト案件_フリーランス案件図鑑.xlsx)の更新をコミット・push・ワークフロー実行・結果確認まで自動化する
---

data/a8-import/アフィリエイト案件_フリーランス案件図鑑.xlsx の
更新を、以下の手順で完全自動処理してください。

1. git fetch origin && git status で、リモートに新規コミットが
   無いか確認する(あればgit pull --ff-onlyで最新化)
2. 対象のExcelファイルに変更があるか git status で確認する。
   変更が無ければ、その旨を伝えて終了する(以降の手順は不要)
3. 変更があれば、以下でステージング・コミットする

   git add "data/a8-import/アフィリエイト案件_フリーランス案件図鑑.xlsx"

   コミットメッセージ: "chore: A8アフィリエイト案件のExcelを更新"

4. git push -u origin main でリモートにpushする
5. gh workflow run import-a8.yml でワークフローを起動する
6. 起動直後はrun IDがすぐに取得できない場合があるため、数秒待って
   から gh run list --workflow=import-a8.yml --limit=1 で最新の
   run IDを取得する
7. gh run watch <run-id> --exit-status で完了を待つ
8. 完了後、gh run view <run-id> --log で実行ログを取得し、
   ログ内の "Done. updated=X added=Y ai=Z offline=W" のような
   サマリー行を抽出する。あわせて [add]/[update] で始まる行から
   処理された会社名の一覧も抽出する
9. 以下の形式でユーザーに結果を報告する:
   - 新規追加: X件(会社名一覧)
   - 既存更新: Y件(会社名一覧)
   - ワークフローの成功/失敗ステータス
   - もしワークフローが失敗した場合は、ログから読み取れる
     エラー内容も報告する

gh CLIが何らかの理由で使えない場合のみ、フォールバックとして
以下をユーザーに案内する:
「GitHubの Actions タブから『Import A8 affiliate agents』
ワークフローを手動実行してください
(https://github.com/ttr-fjmt/freelance-anken-zukan/actions/workflows/import-a8.yml
→ Run workflow → 何も入力せず実行)」
