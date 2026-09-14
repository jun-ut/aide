import path from 'node:path';
import { detectCommand, emit, fmt, readJson, runCapture, runDir, spill, writeJson } from '../util.mjs';
import { failureId, parseOutput } from '../parsers.mjs';

/** シェルの連結・パイプ。ここを跨いで末尾連結すると最後の 1 本にしか効かない */
const CHAIN = /&&|\|\||[;|]/;

/**
 * 追加フラグを埋める位置を決める。
 *
 * - フラグ無し → そのまま
 * - `{}` があればそこへ入れる(**複数可**。`cargo test {} && cd x && cargo test {}`)
 * - 連結でない単一コマンド → 末尾へ足す(従来どおり)
 * - 連結コマンドで `{}` が無い → **null(呼び手が止める)**
 *
 * 最後の枝が要るのは、末尾連結が黙って間違うため。実例: `test: cargo test && cd
 * apps/melqi/src-tauri && cargo test` に `agent test --workspace` を渡すと
 * `--workspace` が **GUI 側の cargo test にだけ**付き、要約は両方 434 passed で
 * 一致するので差に気づけなかった。
 */
export function withArgs(template, passthru) {
  // **`{}` はフラグが無くても必ず消す。** 残すと `cargo test {}` が「{} という名前の
  // テストだけ実行」になり、**0 件実行して PASS** で返る(実際に踏んだ)。
  // 直前の空白ごと落とすのは `cargo test {} --locked` を壊さないため。
  if (template.includes('{}')) {
    return passthru ? template.split('{}').join(passthru) : template.replace(/\s*\{\}/g, '');
  }
  if (!passthru) return template;
  if (CHAIN.test(template)) return null;
  return `${template} ${passthru}`;
}

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
  // `agent build -- --release` も `agent build --release` も同じに扱う。
  // **黙って落とさない。** 以前は `--` の後ろしか渡らず、`agent build --release` が
  // debug ビルドになっていた —— 呼んだ側からは成功にしか見えないので気づけない。
  const passthru = argv.filter((a) => a !== '--').join(' ');
  const template = cfg.commands?.[target] || detectCommand(target, root);

  if (!template) {
    console.log(`${target}: NO_COMMAND  .agent/config.yml の commands.${target} を設定してください`);
    return 2;
  }

  const cmd = withArgs(template, passthru);
  // 連結コマンドに末尾連結すると**最後の 1 本にしか効かない**。上の `--release` と
  // 同じ壊れ方(呼んだ側からは成功に見える)なので、推測せず止める
  if (cmd === null) {
    console.log(
      [
        `${target}: ARGS_UNPLACED  commands.${target} が複数のコマンドを繋いでいるため、`,
        `  \`${passthru}\` をどこに付けるか決められません(末尾に足すと最後の 1 本にしか効きません)。`,
        `  .agent/config.yml の commands.${target} に {} を書いて位置を指定してください`,
        `  (例: \`cargo test {} && cd apps/gui && cargo test {}\`)。いまの設定:`,
        `    ${target}: ${template}`,
      ].join('\n'),
    );
    return 2;
  }

  const r = runCapture(cmd, { cwd: root, timeoutSec: cfg.limits?.timeout_sec });
  const id = spill(root, target, `$ ${cmd}\n\n${r.out}`);
  const parsed = parseOutput(r.out, { ok: r.code === 0 });

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
  const head = `${target} ${status}  ${fmt.tally(target, parsed.counts, r.code)}  ${fmt.dur(r.ms)}  [${parsed.framework}]`;
  const loc = (f) => [f.file, f.line].filter(Boolean).join(':');
  const title = (f) => [loc(f), f.name].filter(Boolean).join('  ') || f.msg;
  // 到達経路は**必ず最後に残す** (契約 2)。溢れたときに削るのは本文の側。
  // rustc / clippy の診断は複数行なので、`--grep` だけだと一致行しか出ない。-C を添える。
  const footer = `log ${id}  ·  agent log ${id} --grep <re> [-C N]`;

  // 前回と完全に同じなら、ここで終わり。反復ループで効く。
  // **ただし 1 件目だけは必ず出す。** 何が同じなのかが分からないと、結局
  // 生で叩き直すことになり、往復を節約するどころか 1 回増える。
  if (same && r.code !== 0) {
    const first = parsed.failures[0];
    console.log([head, `  前回と同一 (${prev.id})${first ? `  ·  ${title(first)}` : ''}`, footer].join('\n'));
    return r.code;
  }
  if (r.code === 0) {
    // 成功でも到達経路は出す(契約 2)。ここを省いていたせいで、「434 passed の
    // 内訳はどのクレートか」を確かめるのに `ls .agent/runs/` から時刻で当てる、
    // という**削減のために増えた往復**が起きていた。
    // `fixed` は「前回失敗していて今回消えたもの」。`(N fixed)` とだけ書くと
    // **ツールがコードを直した**と読めるので、前回との関係が分かる形で出す。
    console.log([fixed ? `${head}  (prev ${fixed} failed → 0)` : head, footer].join('\n'));
    return 0;
  }

  const max = cfg.limits?.max_failures ?? 5;
  const shown = [...parsed.failures].sort((a, b) => isNew(b) - isNew(a)).slice(0, max);
  const lines = [head + (prev ? `  (prev: ${prevIds.length} failed → ${fixed} fixed, ${newly} new)` : '')];
  for (const f of shown) {
    lines.push(`  ${isNew(f) ? '✚' : '·'} ${title(f)}`);
    if (f.msg && (loc(f) || f.name)) lines.push(`      ${f.msg}`);
    // **本文は先頭の 1 件だけに付ける。** 直すのは常に 1 件目で、2 件目以降は
    // 1 件目を直せば変わる。全件に付けると 40 行が本文で埋まって一覧が消える。
    if (f === shown[0]) for (const b of f.body || []) lines.push(`      ${b}`);
  }
  if (parsed.failures.length > max) lines.push(`  … +${parsed.failures.length - max} more failures`);

  console.log(`${emit(lines, (cfg.limits?.max_lines ?? 40) - 1)}\n${footer}`);
  return r.code;
}
