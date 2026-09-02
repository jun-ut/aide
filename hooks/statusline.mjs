#!/usr/bin/env node
/**
 * statusline — キャッシュ残り時間とコンテキストサイズを常時表示する。
 *
 * これが本命の「1時間経過を知る手段」。ステータスラインはモデルのコンテキストに
 * 一切載らない(0 トークン)ので、監視はすべてここでやるのが正しい。
 *
 * stdin に Claude Code から JSON が来る:
 *   { session_id, transcript_path, model:{display_name}, workspace:{current_dir}, cost:{total_cost_usd} }
 */
import path from 'node:path';
import { sessionInfo } from '../src/session.mjs';
import { loadConfig, repoRoot } from '../src/util.mjs';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  let j = {};
  try {
    j = JSON.parse(input);
  } catch {}
  const cwd = j.workspace?.current_dir || process.cwd();
  const cfg = loadConfig(repoRoot(cwd));
  const ttl = cfg.context?.cache_ttl_min ?? 60;
  const warn = cfg.context?.warn_tokens ?? 150000;
  const clear = cfg.context?.clear_tokens ?? 250000;

  const parts = [C.bold(path.basename(cwd))];
  if (j.model?.display_name) parts.push(C.dim(j.model.display_name));

  if (j.transcript_path) {
    const s = sessionInfo(j.transcript_path, ttl);

    // コンテキストサイズ: 1ターンあたりの固定費はこれに比例する
    if (s.ctx) {
      const k = `${Math.round(s.ctx / 1000)}k`;
      const perTurn = `${Math.round(s.ctx / 10000)}k/turn`;
      const col = s.ctx >= clear ? C.red : s.ctx >= warn ? C.yellow : C.green;
      parts.push(col(`ctx ${k}`) + C.dim(` ${perTurn}`) + (s.ctx >= clear ? C.red(' ⇒/clear') : ''));
    }

    // キャッシュ残り: 切れた状態で再開すると ctx 全体を 2x で書き直すことになる
    if (s.remainMin != null) {
      if (s.expired) {
        parts.push(C.red(`✗cache ${fmtAge(s.ageMin)}前`) + C.dim(` +${Math.round(s.ctx / 1000)}k書直`));
      } else if (s.remainMin < 10) {
        parts.push(C.yellow(`cache ${Math.round(s.remainMin)}m`));
      } else {
        parts.push(C.dim(`cache ${Math.round(s.remainMin)}m`));
      }
    }
  }

  if (typeof j.cost?.total_cost_usd === 'number') parts.push(C.dim(`$${j.cost.total_cost_usd.toFixed(2)}`));
  process.stdout.write(parts.join(C.dim(' · ')));
});

function fmtAge(min) {
  if (min < 90) return `${Math.round(min)}m`;
  if (min < 60 * 36) return `${(min / 60).toFixed(1)}h`;
  return `${Math.round(min / 1440)}d`;
}
