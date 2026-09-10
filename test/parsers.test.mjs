import { parseOutput } from '../src/parsers.mjs';

let bad = 0;
const t = (label, out, want) => {
  const r = parseOutput(out);
  const got = { framework: r.framework, passed: r.counts.passed, failed: r.counts.failed };
  const ok = got.framework === want.framework && got.passed === want.passed && got.failed === want.failed;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'NG  '}${label}\n      got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
};

// --- cargo ---
// workspace は対象ごとに集計行を出す。lib と doc-tests が 0 件で、本体は2本目。
// 最初の1本だけ読むと 0 passed になり、さらに全部 0 なので generic に落ちて
// 集計行の "failed" という語を数え始め「0 passed / 3 failed」という嘘になる(実際に踏んだ)。
const cargoOk = `
   Compiling sl-syntax v0.0.0 (/home/jun/project/sightline/crates/sl-syntax)
    Finished \`test\` profile [unoptimized + debuginfo] target(s) in 0.62s
     Running unittests src/lib.rs (target/debug/deps/sl_syntax-1.exe)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/lexer.rs (target/debug/deps/lexer-2.exe)

running 15 tests
test char_literals ... ok
test examples_lex_without_errors ... ok

test result: ok. 15 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s

   Doc-tests sl-syntax

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
`;
t('cargo: 複数の集計行を合算する', cargoOk, { framework: 'cargo', passed: 15, failed: 0 });

const cargoAllEmpty = `
running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
`;
t('cargo: 全部 0 でも generic に落ちない', cargoAllEmpty, { framework: 'cargo', passed: 0, failed: 0 });

const cargoFail = `
running 3 tests
test why_is_reserved ... FAILED

failures:

---- why_is_reserved stdout ----
thread 'why_is_reserved' panicked at crates/sl-syntax/tests/lexer.rs:88:5:
assertion \`left == right\` failed

test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
`;
t('cargo: 失敗を数える', cargoFail, { framework: 'cargo', passed: 2, failed: 1 });

const cargoBuildError = `
error[E0762]: unterminated character literal
   --> crates/sl-syntax/src/lexer.rs:306:51
error: could not compile \`sl-syntax\` (lib test) due to 2 previous errors
`;
t('cargo: 集計行が無いビルド失敗', cargoBuildError, { framework: 'cargo', passed: 0, failed: 2 });

const cargoIgnored = `
test result: ok. 4 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 0.01s
`;
{
  const r = parseOutput(cargoIgnored);
  const ok = r.counts.skipped === 2;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'NG  '}cargo: ignored を skipped として拾う\n      got ${r.counts.skipped} want 2`);
}

// panic の本文が空行で始まる形。`assert!` の文言を `\n` で始めると必ずこうなる。
// **空行で打ち切ると本文が丸ごと落ちて、要約が位置だけになる** (実際に落ちた)。
// 差分テストのように「本文がそのまま次の作業指示」のときは、要約が無価値になる。
const cargoPanicBody = `
running 1 test
test sightline_checker_matches_rust ... FAILED

failures:

---- sightline_checker_matches_rust stdout ----
171 モジュール / 式 8048 (未解決 0) / 関数 250 件で一致
thread 'sightline_checker_matches_rust' panicked at crates/sl-codegen/tests/diff_types.rs:92:5:

Sightline 版と Rust 版で型が違う。**最初の 1 件がそのまま次の作業指示。**

fns (関数のシグネチャ) で食い違う
    Rust      Typed { fns: [FnSig { sym: 27, params: [Con(Str, [])],…
    Sightline Typed { fns: [], mods: [] }

note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace

failures:
    sightline_checker_matches_rust

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 3.90s

error: test failed, to rerun pass \`-p sl-codegen --test diff_types\`
`;
{
  const r = parseOutput(cargoPanicBody);
  const f = r.failures[0];
  const all = [f?.msg, ...(f?.body || [])].join('\n');
  const checks = [
    ['位置を見出しに出す', f?.file === 'crates/sl-codegen/tests/diff_types.rs' && f.line === 92],
    ['本文を落とさない', /最初の 1 件がそのまま次の作業指示/.test(all)],
    ['食い違いの中身まで出す', /Sightline Typed \{ fns: \[\], mods: \[\] \}/.test(all)],
    ['`panicked at` の行は見出しと重複するので出さない', !/panicked at/.test(all)],
    ['再実行の案内を失敗として数えない', r.failures.length === 1],
  ];
  for (const [label, ok] of checks) {
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'NG  '}cargo: ${label}`);
  }
  if (checks.some(([, ok]) => !ok)) console.log(`      got ${JSON.stringify(f)}`);
}

// --- node:test ---
// 同じ罠。集計行が「ℹ fail 0」なので generic に落ちると嘘になる。
const nodeOk = `
✔ heredoc本体は無視 (1.2ms)
ℹ tests 3
ℹ pass 3
ℹ fail 0
`;
t('node:test: 全部通っても framework を保つ', nodeOk, { framework: 'node:test', passed: 3, failed: 0 });

console.log(bad ? `\n${bad} 件 NG` : '\n全件 ok');
process.exit(bad ? 1 : 0);
