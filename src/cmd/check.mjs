import path from 'node:path';
import { detectCommand, emit, fmt, readJson, runCapture, runDir, spill, writeJson } from '../util.mjs';
import { failureId, parseOutput } from '../parsers.mjs';

/**
 * agent test|lint|build|typecheck
 *
 * 契約:
 *   1. 出力は常に max_lines 以内
 *   2. 全文は必ずディスクへ退避し、末尾に到達経路を出す
 *   3. 前回実行との差分を出す(不変なら 2 行で終わる)
 *   4. 終了コードは元コマンドをそのまま返す
 */
export default function check(target, argv, cfg) {
  const root = cfg.__root;
  const passthru = argv.includes('--') ? argv.slice(argv.indexOf('--') + 1).join(' ') : '';
  const cmd = [cfg.commands?.[target] || detectCommand(target, root), passthru].filter(Boolean).join(' ');

  if (!cmd) {
    console.log(`${target}: NO_COMMAND  .agent/config.yml の commands.${target} を設定してください`);
    return 2;
  }

  const r = runCapture(cmd, { cwd: root, timeoutSec: cfg.limits?.timeout_sec });
  const id = spill(root, target, `$ ${cmd}\n\n${r.out}`);
  const parsed = parseOutput(r.out);

  const prevPath = path.join(runDir(root), `last-${target}.json`);
  const prev = readJson(prevPath);
  const ids = parsed.failures.map(failureId);
  const prevIds = prev?.ids || [];
  const isNew = (f) => !prevIds.includes(failureId(f));
  const fixed = prevIds.filter((i) => !ids.includes(i)).length;
  const newly = ids.filter((i) => !prevIds.includes(i)).length;
  const same = prev && fixed === 0 && newly === 0 && prev.code === r.code;

  writeJson(prevPath, { ids, code: r.code, counts: parsed.counts, id, at: new Date().toISOString() });

  const status = r.timedOut ? 'TIMEOUT' : r.code === 0 ? 'PASS' : 'FAIL';
  const c = parsed.counts;
  const tally =
    c.passed || c.failed || c.skipped
      ? `${c.passed} passed / ${c.failed} failed${c.skipped ? ` / ${c.skipped} skipped` : ''}`
      : `exit ${r.code}`;

  const head = `${target} ${status}  ${tally}  ${fmt.dur(r.ms)}  [${parsed.framework}]`;

  // 前回と完全に同じなら、ここで終わり。反復ループで効く。
  if (same && r.code !== 0) {
    console.log(`${head}\n  前回と同一 (${prev.id})  ·  agent log ${id}`);
    return r.code;
  }
  if (r.code === 0) {
    console.log(fixed ? `${head}  (${fixed} fixed)` : head);
    return 0;
  }

  const max = cfg.limits?.max_failures ?? 5;
  const shown = [...parsed.failures].sort((a, b) => isNew(b) - isNew(a)).slice(0, max);
  const lines = [head + (prev ? `  (prev: ${prevIds.length} failed → ${fixed} fixed, ${newly} new)` : '')];
  for (const f of shown) {
    const loc = [f.file, f.line].filter(Boolean).join(':');
    lines.push(`  ${isNew(f) ? '✚' : '·'} ${[loc, f.name].filter(Boolean).join('  ') || f.msg}`);
    if (f.msg && (loc || f.name)) lines.push(`      ${f.msg}`);
    // **本文は先頭の 1 件だけに付ける。** 直すのは常に 1 件目で、2 件目以降は
    // 1 件目を直せば変わる。全件に付けると 40 行が本文で埋まって一覧が消える。
    if (f === shown[0]) for (const b of f.body || []) lines.push(`      ${b}`);
  }
  if (parsed.failures.length > max) lines.push(`  … +${parsed.failures.length - max} more failures`);

  // 到達経路は**必ず最後に残す** (契約 2)。溢れたときに削るのは本文の側。
  const footer = `log ${id}  ·  agent log ${id} --grep <re>`;
  console.log(`${emit(lines, (cfg.limits?.max_lines ?? 40) - 1)}\n${footer}`);
  return r.code;
}
