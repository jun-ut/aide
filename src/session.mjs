import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from './util.mjs';

/** 巨大な jsonl の末尾だけを読む(10MB を毎回全部読まないため) */
export function tailLines(file, bytes = 512 * 1024) {
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - bytes);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(st.size - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  const text = buf.toString('utf8');
  return (start > 0 ? text.slice(text.indexOf('\n') + 1) : text).split('\n').filter(Boolean);
}

/**
 * トランスクリプトから現在の「コンテキストサイズ」と「キャッシュ経過時間」を得る。
 *
 * ctxTokens は最後の API リクエストのプロンプト全体 (cache_read + cache_creation + input)。
 * cacheAgeMin は最後のリクエストからの経過分。1h TTL はリクエストのたびに更新されるので、
 * 残り = ttl - age で正しい。
 */
export function sessionInfo(transcriptPath, ttlMin = 60) {
  const out = { ctx: 0, ageMin: null, remainMin: null, expired: false, model: null, lastTs: null };
  try {
    const lines = tailLines(transcriptPath);
    for (let i = lines.length - 1; i >= 0; i--) {
      let d;
      try {
        d = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      const u = d.message?.usage;
      if (!u) continue;
      out.ctx = (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.input_tokens || 0);
      out.model = d.message?.model || null;
      if (d.timestamp) {
        out.lastTs = new Date(d.timestamp);
        out.ageMin = (Date.now() - out.lastTs.getTime()) / 60000;
        out.remainMin = ttlMin - out.ageMin;
        out.expired = out.remainMin <= 0;
      }
      break;
    }
  } catch {}
  return out;
}

/** 現在のセッションの transcript を推測する(agent age を素で叩いたとき用) */
export function guessTranscript(cwd = process.cwd()) {
  const dir = projectDir(cwd);
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files[0]?.f || null;
}
