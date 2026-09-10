#!/usr/bin/env node
/**
 * PreToolUse(Read) — 同一ファイルの再読み込みを止める。
 *
 * 実測: Read が tool_result の 79%、うち 25〜30 件/セッションが同一ファイルの再読み込み
 * (同じファイルを 9 回読んでいる例あり)。コンテキストに残った内容を再度積むのは
 * 純粋な二重課金で、しかも以後の全ターンで cache_read として課金され続ける。
 *
 * 誤検知を防ぐ鍵は mtime。Claude 自身が Edit すれば mtime が変わるので、
 * 正当な読み直しは自動的に通る。
 *
 * 逃げ道:
 *   - offset/limit つきの部分読みは常に許可
 *   - AGENT_NO_DEDUP=1 で無効化
 *   - SessionStart / PreCompact で履歴をクリア(圧縮で消えた分は読み直して良い)
 *
 * 誤検知率の測り方: deny と、逃げ道 (AGENT_NO_DEDUP=1) を実際に使われた回数を
 * `.agent/run/<sid>.denies.json` に残す。**逃げ道を使われた = 止めたのが誤りだった**
 * なので bypass/deny が誤検知率の下限になる。`agent stats` の「拒否」列がこれ。
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJson, repoRoot, writeJson } from '../src/util.mjs';

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|pdf)$/i;
const IMAGE_WARN_BYTES = 150 * 1024;

read(process.stdin, (j) => {
  const fp = j.tool_input?.file_path;
  if (!fp) return allow();

  // 部分読みは常に許可(範囲を絞る行為はむしろ推奨したい)。
  // 逃げ道の判定より先に置く。範囲読みは元々止めないので bypass に数えてはいけない。
  if (j.tool_input?.offset != null || j.tool_input?.limit != null) return allow();

  const root = repoRoot(j.cwd || process.cwd());
  const sid = j.session_id || 'default';
  const store = path.join(root, '.agent', 'run', `${sid}.reads.json`);
  const seen = readJson(store, {}) || {};

  let st;
  try {
    st = fs.statSync(fp);
  } catch {
    return allow();
  }

  const prev = seen[fp];
  const dup = !!prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size;

  if (process.env.AGENT_NO_DEDUP === '1') {
    // 止めるはずだったものを逃げ道で通した = 誤検知が 1 件確定した、ということ
    if (dup) logEvent(root, sid, { type: 'bypass', file: fp, at: Date.now() });
    return allow();
  }

  if (dup) {
    const mins = Math.round((Date.now() - prev.at) / 60000);
    logEvent(root, sid, { type: 'deny', file: fp, at: Date.now(), agoMin: mins });
    return deny(
      `${path.basename(fp)} は ${mins} 分前に全文を読み込み済みで、以降 mtime も変わっていません。` +
        `内容はまだこのコンテキストにあります。\n` +
        `・特定の範囲を見たい場合のみ Read(offset/limit) を使ってください\n` +
        `・見つからない場合は Grep で位置を特定してから範囲読みしてください\n` +
        `・圧縮などで本当に失われている場合は AGENT_NO_DEDUP=1 を付けて再実行できます`,
    );
  }

  if (IMAGE.test(fp) && st.size > IMAGE_WARN_BYTES) {
    seen[fp] = { mtimeMs: st.mtimeMs, size: st.size, at: Date.now() };
    writeJson(store, seen);
    return allow(
      `注意: ${path.basename(fp)} は ${Math.round(st.size / 1024)}KB あります。` +
        `画像はトークン換算が非常に大きいので、以後は縮小版を読むか一度で済ませてください。`,
    );
  }

  seen[fp] = { mtimeMs: st.mtimeMs, size: st.size, at: Date.now() };
  writeJson(store, seen);
  allow();
});

function logEvent(root, sid, ev) {
  const p = path.join(root, '.agent', 'run', `${sid}.denies.json`);
  const log = readJson(p, []);
  writeJson(p, [...(Array.isArray(log) ? log : []), ev]);
}
function allow(msg) {
  out({ permissionDecision: 'allow', ...(msg ? { permissionDecisionReason: msg } : {}) });
}
function deny(reason) {
  out({ permissionDecision: 'deny', permissionDecisionReason: reason });
}
function out(o) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...o } }));
  process.exit(0);
}
function read(stream, cb) {
  let s = '';
  stream.setEncoding('utf8');
  stream.on('data', (d) => (s += d));
  stream.on('end', () => {
    try {
      cb(JSON.parse(s));
    } catch {
      allow();
    }
  });
}
