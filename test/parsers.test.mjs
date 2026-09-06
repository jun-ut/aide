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
