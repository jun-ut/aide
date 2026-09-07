import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emit, fmt, projectDir } from '../util.mjs';

/**
 * agent stats — 自分のトランスクリプトを実測する。
 *
 * 「どこにトークンが消えているか」を想像ではなく実測で決めるための道具。
 * 加重は課金/レート制限の重み: cache_read 0.1x / cache_write 2x(1h) / input 1x / output 5x
 */
const W = { read: 0.1, write: 2, input: 1, output: 5 };

export { projectDir };

export function listTranscripts(dir, limit = 8) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(dir, f))
    .map((p) => ({ p, st: fs.statSync(p) }))
    .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
    .slice(0, limit)
    .map((x) => x.p);
}

export function scan(file) {
  const s = {
    file,
    msgs: 0,
    peak: 0,
    cr: 0,
    cw: 0,
    inp: 0,
    out: 0,
    tools: {},
    reads: new Map(),
    expiry: [],
    first: null,
    last: null,
  };
  const pending = new Map();
  let prevTs = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = d.timestamp ? new Date(d.timestamp) : null;
    const msg = d.message || {};
    const u = msg.usage;
    if (u) {
      s.msgs++;
      s.cr += u.cache_read_input_tokens || 0;
      s.cw += u.cache_creation_input_tokens || 0;
      s.inp += u.input_tokens || 0;
      s.out += u.output_tokens || 0;
      s.peak = Math.max(s.peak, (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0));
      if (ts) {
        s.first ??= ts;
        s.last = ts;
        const gapH = prevTs ? (ts - prevTs) / 3.6e6 : 0;
        const w = u.cache_creation_input_tokens || 0;
        if (gapH > 1 && w > 20000) s.expiry.push({ at: ts, gapH, w });
        prevTs = ts;
      }
    }
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use') pending.set(b.id, b);
      else if (b.type === 'tool_result') {
        const call = pending.get(b.tool_use_id);
        const name = call?.name || '?';
        const raw = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
        const t = s.tools[name] || (s.tools[name] = { ch: 0, n: 0 });
        t.ch += raw.length;
        t.n++;
        if (name === 'Read') {
          const fp = call?.input?.file_path || '?';
          const e = s.reads.get(fp) || { n: 0, ch: 0 };
          e.n++;
          e.ch += raw.length;
          s.reads.set(fp, e);
        }
      }
    }
  }
  s.weighted = s.cr * W.read + s.cw * W.write + s.inp * W.input + s.out * W.output;
  s.dupReads = [...s.reads.values()].reduce((a, e) => a + (e.n - 1), 0);
  s.dupCh = [...s.reads.values()].reduce((a, e) => a + (e.n > 1 ? (e.ch / e.n) * (e.n - 1) : 0), 0);
  return s;
}

export default function stats(argv, cfg) {
  const limit = Number(argv[argv.indexOf('--limit') + 1]) || 8;
  const all = argv.includes('--all');
  const dir = all ? path.join(os.homedir(), '.claude', 'projects') : projectDir(cfg.__root);
  const files = all
    ? fs
        .readdirSync(dir)
        .flatMap((d) => listTranscripts(path.join(dir, d), 99))
        .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)
        .slice(0, limit)
    : listTranscripts(dir, limit);

  if (!files.length) {
    console.log(`stats: トランスクリプトが見つかりません (${dir})`);
    return 1;
  }

  const rows = files.map(scan).filter((s) => s.msgs);
  const T = rows.reduce((a, s) => ({ cr: a.cr + s.cr, cw: a.cw + s.cw, out: a.out + s.out, w: a.w + s.weighted }), {
    cr: 0,
    cw: 0,
    out: 0,
    w: 0,
  });

  const L = [];
  L.push('session   msgs  peak_ctx     加重tok  read/write/out   再読込  失効');
  for (const s of rows.sort((a, b) => b.weighted - a.weighted)) {
    const id = path.basename(s.file).slice(0, 8);
    L.push(
      `${id}  ${String(s.msgs).padStart(4)}  ${fmt.n(s.peak).padStart(8)}  ${fmt.n(Math.round(s.weighted)).padStart(10)}` +
        `  ${pct(s.cr * W.read, s.weighted)}/${pct(s.cw * W.write, s.weighted)}/${pct(s.out * W.output, s.weighted)}` +
        `  ${String(s.dupReads).padStart(5)}  ${String(s.expiry.length).padStart(3)}`,
    );
  }
  L.push('');
  L.push(
    `合計加重 ${fmt.n(Math.round(T.w))}  ` +
      `(cacheRead ${pct(T.cr * W.read, T.w)} / cacheWrite ${pct(T.cw * W.write, T.w)} / output ${pct(T.out * W.output, T.w)})`,
  );

  // 上位の無駄
  const dup = rows.flatMap((s) => [...s.reads].filter(([, e]) => e.n > 2).map(([f, e]) => ({ f, ...e })));
  dup.sort((a, b) => (b.ch / b.n) * (b.n - 1) - (a.ch / a.n) * (a.n - 1));
  if (dup.length) {
    L.push('');
    L.push('再読み込みの無駄 (上位):');
    for (const d of dup.slice(0, 5)) {
      L.push(`  x${d.n}  ${fmt.n(Math.round((d.ch / d.n) * (d.n - 1))).padStart(9)} ch  ${d.f.slice(-58)}`);
    }
  }

  const exp = rows.flatMap((s) => s.expiry).sort((a, b) => b.w - a.w);
  if (exp.length) {
    const tot = exp.reduce((a, e) => a + e.w, 0);
    L.push('');
    L.push(`キャッシュ失効 ${exp.length}件 / 再キャッシュ ${fmt.n(tot)} tok (加重 ${fmt.n(tot * W.write)}):`);
    for (const e of exp.slice(0, 5)) {
      L.push(`  空白 ${e.gapH.toFixed(1).padStart(5)}h → ${fmt.n(e.w).padStart(9)} tok  ${e.at.toISOString().slice(5, 16)}`);
    }
  }

  const tools = {};
  for (const s of rows) for (const [k, v] of Object.entries(s.tools)) (tools[k] ??= { ch: 0, n: 0 }), (tools[k].ch += v.ch), (tools[k].n += v.n);
  const totCh = Object.values(tools).reduce((a, t) => a + t.ch, 0) || 1;
  L.push('');
  L.push('tool_result 内訳:');
  for (const [k, v] of Object.entries(tools).sort((a, b) => b[1].ch - a[1].ch).slice(0, 6)) {
    L.push(`  ${k.padEnd(14)} ${pct(v.ch, totCh).padStart(5)}  ${fmt.n(v.ch).padStart(11)} ch  calls=${v.n}  avg=${fmt.n(Math.round(v.ch / v.n))}`);
  }

  console.log(emit(L, argv.includes('--full') ? 999 : 60));
  return 0;
}

const pct = (a, b) => `${Math.round((a / (b || 1)) * 100)}%`;
