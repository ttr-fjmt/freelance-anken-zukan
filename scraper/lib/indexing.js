'use strict';

/**
 * 検索エンジンに載せるページ（インデックス対象）を決める。
 *
 * 【なぜ必要になったか】
 * 姉妹サイトの転職エージェント図鑑が、AdSense の審査で「有用性の低いコンテンツ」と判定された。
 * 同じ構造のこのサイトでも、中身が確認できていないページを検索対象として送らないようにする。
 *
 * このサイトの掲載は厚労省データの転載ではなく、公式サイトを確認して集めたものなので、
 * 出所では線を引けない。代わりに「そのページに、確認できた中身があるか」で線を引く。
 * 2026-09 時点で、142件のうち次の14件が該当した。
 *
 *   - 公式サイトの本文を確認できず、紹介文が「詳細情報が確認できませんでした」等になっている（11件）
 *   - サービスの終了・サイト閉鎖が公式に告知されている（3件）
 *
 * 【判定の考え方】
 * 特徴（features）が1件でも確認できていれば、中身があるとみなして検索対象にする。
 * 特徴が0件のときだけ、紹介文に「確認できなかった」「終了した」旨が書かれていないかを見る。
 * 紹介文の言い回しだけで判定すると、中身のあるページ（例: 特徴の抽出だけ漏れたページ）まで
 * 外してしまうため、必ず「特徴0件」と組み合わせる。
 */

/** 公式サイトの本文を確認できなかったことを示す言い回し。 */
const UNVERIFIED_PATTERN = /詳細情報が確認できませんでした|取得できな|確認できません|把握することができません|詳細不明/;

/** サービスの終了・閉鎖が告知されていることを示す言い回し（「プロジェクト終了後」などは含めない）。 */
const DISCONTINUED_PATTERN = /をもって[^。]*(終了|閉鎖)/;

/** 検索対象から外すときに <head> に入れるタグ。リンクはたどってもらう（follow）。 */
const ROBOTS_NOINDEX = '<meta name="robots" content="noindex,follow">';

function introText(agent) {
  return [agent.oneLiner, agent.appeal].filter(Boolean).join(' ');
}

function isIndexableAgent(agent) {
  if (!agent) return false;
  if ((agent.features || []).length > 0) return true;
  const text = introText(agent);
  return !(UNVERIFIED_PATTERN.test(text) || DISCONTINUED_PATTERN.test(text));
}

/** カテゴリーページを検索対象にするか。中身のあるサービスが1件も無い一覧は外す。 */
function isIndexableCategory(agents, categoryName) {
  return (agents || []).some(a => a && a.category === categoryName && isIndexableAgent(a));
}

/**
 * HTML の <head> に noindex を1つだけ入れる（既にあれば何もしない）。
 * 文字コード指定は <head> の先頭にある必要があるので、その直後に置く。
 */
function withRobotsNoindex(html) {
  const source = String(html);
  if (/<meta\s+name=["']robots["']/i.test(source)) return source;
  if (/<meta\s+charset=["'][^"']*["']\s*\/?>/i.test(source)) {
    return source.replace(/(<meta\s+charset=["'][^"']*["']\s*\/?>)/i, `$1\n${ROBOTS_NOINDEX}`);
  }
  if (/<head[^>]*>/i.test(source)) {
    return source.replace(/(<head[^>]*>)/i, `$1\n${ROBOTS_NOINDEX}`);
  }
  throw new Error('<head> が見つからないため noindex を入れられません');
}

module.exports = {
  UNVERIFIED_PATTERN,
  DISCONTINUED_PATTERN,
  ROBOTS_NOINDEX,
  isIndexableAgent,
  isIndexableCategory,
  withRobotsNoindex,
};
