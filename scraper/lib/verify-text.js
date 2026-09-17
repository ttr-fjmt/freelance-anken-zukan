'use strict';

/**
 * 本文照合。自動で書いた記事が「公式ページに書かれていること」だけを書いているかを確かめる土台。
 *
 * 【なぜ必要か】
 * AIに「公式ページに無いことは書かないで」と指示するだけでは守られない
 * （このリポジトリでも、フッターの著作権表記から会社名を作る誤りが実際に起きた）。
 * そこで、書いた文言が保存済みの公式ページ本文に**実在するか**を機械的に確かめる。
 *
 * 【照合のしかた】
 * 公式ページの本文は、改行・空白・全角半角の揺れが大きい。そのままの一致は厳しすぎるので、
 * 字体と空白の揺れだけを吸収してから比べる。意味を変える言い換え（「5年」→「最長5年」）は
 * 正規化しても一致しないので落ちる。それが狙い。
 */

const fs = require('fs');
const path = require('path');

const RAW_DIR = path.join(__dirname, '..', '..', 'data', 'raw');

/** 比較のための正規化。字体・空白の揺れだけを吸収し、語そのものは変えない。 */
function normalize(text) {
  return String(text == null ? '' : text)
    .normalize('NFKC')
    .replace(/[\s　]+/g, '')
    .replace(/[〜～~]/g, '~')
    .replace(/[｢「]/g, '「')
    .replace(/[｣」]/g, '」')
    .replace(/[･・]/g, '・')
    .replace(/[，,]/g, '、');
}

/** data/raw/<sourceId>.txt を読む。無ければ null（＝まだ取得していない）。 */
function loadRawText(sourceId, dir = RAW_DIR) {
  const file = path.join(dir, `${sourceId}.txt`);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

/** 文言が本文に実在するか。 */
function textAppearsIn(text, rawText) {
  if (!rawText) return false;
  const needle = normalize(text);
  if (!needle) return false;
  return normalize(rawText).includes(needle);
}

module.exports = { normalize, loadRawText, textAppearsIn, RAW_DIR };
