import { failureId, parseOutput } from '../src/parsers.mjs';

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
// **`could not compile … due to N previous errors` は集計行であって失敗ではない。**
// 以前はこれを 1 件として数えていたので、エラー 1 件の出力が「2 failed」になり、
// max_failures の枠も 1 つ食っていた (診断が 3 件あると 1 件目が押し出される)。
t('cargo: 集計行が無いビルド失敗', cargoBuildError, { framework: 'cargo', passed: 0, failed: 1 });

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

// `cargo build` / `cargo clippy` の診断にはエラーコードが無い。**コード付きだけ見ていると
// generic に落ち、位置も help も落ちる。** そうなると要約だけでは直せず、結局
// AGENT_RAW=1 で叩き直すことになる (実際に 2 回そうなった)。
const cargoBuildNoCode = `
   Compiling mdcore v0.1.0 (C:\\Hub\\Project\\md2doc\\crates\\mdcore)
error: unknown start of token: \`
   --> crates\\mdcore\\src\\metrics.rs:212:1
    |
212 | \` での明示改行も展開する)。
    | ^
    |
help: Unicode character '\`' (Grave Accent) looks like ''' (Single Quote), but it is not
    |
212 - \` での明示改行も展開する)。
212 + ' での明示改行も展開する)。
    |

error: unexpected closing delimiter: \`)\`
   --> crates\\mdcore\\src\\metrics.rs:212:14
    |
171 | ) {
    |   - this opening brace...

error: could not compile \`mdcore\` (lib) due to 2 previous errors
warning: build failed, waiting for other jobs to finish...
error: could not compile \`mdcore\` (lib test) due to 2 previous errors
`;
{
  const r = parseOutput(cargoBuildNoCode);
  const f = r.failures[0];
  const checks = [
    ['コード無しの error でも cargo として読む', r.framework === 'cargo'],
    ['位置を見出しに出す', f?.file === 'crates\\mdcore\\src\\metrics.rs' && f.line === 212],
    ['直し方 (help) を本文に残す', (f?.body || []).some((l) => /Grave Accent/.test(l))],
    ['`could not compile` を失敗として数えない', r.counts.failed === 2],
  ];
  for (const [label, ok] of checks) {
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'NG  '}cargo build: ${label}`);
  }
  if (checks.some(([, ok]) => !ok)) console.log(`      got ${JSON.stringify(r.failures)}`);
}

const clippy = `
error: this function has too many arguments (8/7)
  --> crates/mdcore/src/metrics.rs:162:1
   |
162 | / fn flush_word(
   | |_^
   |
   = help: for further information visit https://rust-lang.github.io/rust-clippy/
   = note: \`-D clippy::too-many-arguments\` implied by \`-D warnings\`

error: the following explicit lifetimes could be elided: 'a
  --> crates/mdcore/src/metrics.rs:214:19
   |
   = note: \`-D clippy::needless-lifetimes\` implied by \`-D warnings\`

error: could not compile \`mdcore\` (lib) due to 2 previous errors
`;
{
  const r = parseOutput(clippy);
  const ids = r.failures.map(failureId);
  const checks = [
    ['clippy も cargo として読む', r.framework === 'cargo'],
    ['lint ごとに位置が付く', r.failures[0]?.line === 162 && r.failures[1]?.line === 214],
    ['2 件を別物として数える', new Set(ids).size === 2 && r.counts.failed === 2],
  ];
  for (const [label, ok] of checks) {
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'NG  '}clippy: ${label}`);
  }
  if (checks.some(([, ok]) => !ok)) console.log(`      got ${JSON.stringify(r.failures)}`);
}

// generic は位置も名前も持たない。id がメッセージを見ないと**全部同じ id** になり、
// 中身が入れ替わっても「前回と同一」と言い切って詳細を伏せてしまう (実際に伏せた)。
{
  const a = parseOutput('something went wrong: alpha failed\n');
  const b = parseOutput('something went wrong: beta failed\n');
  const ok = a.framework === 'generic' && failureId(a.failures[0]) !== failureId(b.failures[0]);
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'NG  '}generic: 別の失敗は別の id になる`);
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
