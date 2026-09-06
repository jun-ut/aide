/**
 * agent last [target...] — 記録された最後の検証結果を、**走らせずに**読む。
 *
 * 存在理由: SessionStart の「現在地」に検証結果を載せたいが、そこで agent test を
 * 走らせるのは three ways で間違っている。
 *   1. セッション開始が丸ごとブロックされる (cargo test --workspace は冷えていれば分単位)
 *   2. status_timeout_sec を超えると status ブロックごと消える。
 *      **地図が最も要る「新規 clone 直後」に地図が確実に消える**という最悪の形。
 *   3. そもそもセッション開始時の結果は最初の編集で嘘になる。
 *
 * セッション開始時に価値があるのは「作業中に変わらない事実」(HEAD・ADR・地図・TODO) だけ。
 * 検証結果はその真逆なので、走らせず、**いつの記録かを付けて**読む。
 * 新鮮そうに見える古い数字より、古さが見えている数字のほうが判断に使える。
 */
import path from 'node:path';
import { readJson, runDir } from '../util.mjs';

const TARGETS = ['test', 'lint', 'build', 'typecheck'];

/** 「3時間前」。要点は鮮度が読み手に見えることなので、粗くてよい。 */
export function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}秒前`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}分前`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}時間前`;
  return `${Math.round(h / 24)}日前`;
}

export function lastLine(target, root, now = Date.now()) {
  const rec = readJson(path.join(runDir(root), `last-${target}.json`));
  if (!rec) return `${target}  記録なし (agent ${target} で作る)`;
  const c = rec.counts || {};
  const tally =
    c.passed || c.failed || c.skipped
      ? `${c.passed} passed / ${c.failed} failed${c.skipped ? ` / ${c.skipped} skipped` : ''}`
      : `exit ${rec.code}`;
  const at = Date.parse(rec.at);
  const when = Number.isNaN(at) ? rec.id : `${ago(now - at)} · ${rec.id}`;
  return `${target}  ${rec.code === 0 ? 'PASS' : 'FAIL'}  ${tally}  (${when} の記録)`;
}

export function hasRecord(target, root) {
  return readJson(path.join(runDir(root), `last-${target}.json`)) !== null;
}

export default function last(argv, cfg) {
  const asked = argv.filter((a) => TARGETS.includes(a));
  // 引数なしなら「記録があるものだけ」。走らせたことのない target を
  // 「記録なし」で 4 行並べても、現在地の役に立たない。
  const targets = asked.length ? asked : TARGETS.filter((t) => hasRecord(t, cfg.__root));
  if (!targets.length) {
    console.log('記録なし (agent test / agent lint を一度走らせる)');
    return 0;
  }
  console.log(targets.map((t) => lastLine(t, cfg.__root)).join('\n'));
  return 0;
}
