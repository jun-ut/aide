/**
 * 各フレームワークの出力から「失敗だけ」を抽出する。
 *
 * 原則: head を使わない。テストランナーの先頭 N 行は「通ったテスト」であり
 * 一番要らない部分だから。必ず失敗ブロックを探して、その中を切り詰める。
 *
 * 返り値: { framework, counts:{passed,failed,skipped}, failures:[{file,line,name,msg}] }
 */

const NOISE = /node_modules|site-packages|\/dist\/|internal\/process|at Module\._|__pycache__/;

const clean = (s) => s.replace(/\s+$/, '').replace(/^\s{0,6}/, '');

function block(lines, i, max = 12) {
  const out = [];
  for (let j = i; j < lines.length && out.length < max; j++) {
    const l = lines[j];
    if (j > i && /^(\s*)(FAIL|PASS|✓|✗|●|---|===|\s*$)/.test(l) && out.length > 1) break;
    if (NOISE.test(l)) continue;
    if (l.trim()) out.push(clean(l));
  }
  return out;
}

/**
 * cargo のテスト失敗ブロックから、panic の**本文**と位置を取り出す。
 *
 * `---- NAME stdout ----` の後はこうなっている。
 *
 *   <テストが println! したもの>
 *   thread 'NAME' panicked at FILE:LINE:COL:
 *   <本文>
 *   note: run with `RUST_BACKTRACE=1` ...
 *
 * **`block()` を使ってはいけない。** あちらは空行で打ち切るが、panic の本文は
 * 空行で始まることが多く (`assert!` の文言を `\n` で始めると必ずそうなる)、
 * 本文が丸ごと落ちる。実際に落ちて、要約が位置だけになった。
 *
 * `panicked at` の行自体は捨てる —— 位置は呼ぶ側が見出しに出すので重複する。
 */
function cargoPanic(lines, i, max = 12) {
  const out = [];
  let at = null;
  for (let j = i; j < lines.length && out.length < max; j++) {
    const l = lines[j];
    if (j > i && /^----\s/.test(l)) break;
    if (/^(note: run with|failures:|test result:)/.test(l.trim())) break;
    const m = l.match(/panicked at (\S+?):(\d+):\d+/);
    if (m) {
      at = { file: m[1], line: Number(m[2]) };
      continue;
    }
    if (NOISE.test(l)) continue;
    if (l.trim()) out.push(clean(l).slice(0, 200));
  }
  if (!at) {
    const loc = out.join('\n').match(/(\S+\.rs):(\d+)/);
    if (loc) at = { file: loc[1], line: Number(loc[2]) };
  }
  return { at, body: out };
}

/** 失敗ブロックから「本当に読みたい1〜2行」を選ぶ */
function gist(lines) {
  const useful = lines.filter((l) => !/^(FAIL|PASS|ok|error|failures?:)\s*$/i.test(l.trim()));
  const pri =
    useful.find((l) => /(AssertionError|expected|received|[Ee]rror:|panic:|[Tt]imeout|assert |thread .* panicked)/.test(l)) ||
    useful.find((l) => /\S+:\d+:/.test(l));
  return (pri || useful[1] || useful[0] || '').slice(0, 160);
}

const parsers = [
  {
    name: 'vitest/jest',
    test: (o) => /(FAIL|PASS)\s+\S+|Tests\s+\d+\s+(failed|passed)|Test Suites:/.test(o),
    parse(o) {
      const lines = o.split('\n');
      const failures = [];
      for (let i = 0; i < lines.length; i++) {
        const m =
          lines[i].match(/^\s*(?:FAIL|●)\s+(.+?)(?:\s+>\s+(.+))?$/) ||
          lines[i].match(/^\s*(?:✗|×|✘)\s+(.+?)\s+(.+)$/);
        if (!m) continue;
        const blk = block(lines, i + 1);
        const loc = (blk.find((l) => /^(at\s+)?\S+\.[a-z]+:\d+/.test(l)) || '').match(/(\S+?):(\d+)/);
        failures.push({
          file: loc ? loc[1] : m[1].trim(),
          line: loc ? Number(loc[2]) : null,
          name: (m[2] || '').trim(),
          msg: gist(blk),
        });
      }
      return { counts: countsFrom(o), failures: dedupe(failures) };
    },
  },
  {
    name: 'pytest',
    test: (o) => /=+ (FAILURES|short test summary|test session starts)/.test(o),
    parse(o) {
      const failures = [];
      for (const m of o.matchAll(/^(?:FAILED|ERROR)\s+([^\s:]+)::(\S+)\s*-?\s*(.*)$/gm)) {
        failures.push({ file: m[1], line: null, name: m[2], msg: m[3].slice(0, 160) });
      }
      if (!failures.length) {
        const lines = o.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const m = lines[i].match(/^_+\s+(\S+)\s+_+$/);
          if (m) failures.push({ file: '', line: null, name: m[1], msg: gist(block(lines, i + 1)) });
        }
      }
      const c = o.match(/(\d+) failed,?\s*(?:(\d+) passed)?/);
      return {
        counts: { failed: Number(c?.[1] || failures.length), passed: Number(c?.[2] || 0), skipped: 0 },
        failures: dedupe(failures),
      };
    },
  },
  {
    name: 'go test',
    test: (o) => /^(ok|FAIL|---\s+FAIL)/m.test(o) && /_test\.go|go: /.test(o),
    parse(o) {
      const lines = o.split('\n');
      const failures = [];
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^\s*---\s+FAIL:\s+(\S+)/);
        if (!m) continue;
        const blk = block(lines, i + 1, 8);
        const loc = (blk[0] || '').match(/(\S+\.go):(\d+)/);
        failures.push({ file: loc?.[1] || '', line: Number(loc?.[2]) || null, name: m[1], msg: gist(blk) });
      }
      return { counts: { failed: failures.length, passed: (o.match(/^ok\s/gm) || []).length, skipped: 0 }, failures };
    },
  },
  {
    name: 'cargo',
    test: (o) => /^(test result:|error\[E\d+\]|---- .* stdout ----)/m.test(o),
    parse(o) {
      const lines = o.split('\n');
      const failures = [];
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^----\s+(\S+)\s+stdout\s+----/);
        if (m) {
          const { at, body } = cargoPanic(lines, i + 1);
          failures.push({
            file: at?.file || '',
            line: at?.line ?? null,
            name: m[1],
            msg: body[0] || '',
            body: body.slice(1),
          });
        }
        // `error: test failed, to rerun pass ...` は失敗ではなく再実行の案内。
        // 失敗として数えると、1 本落ちただけで見出しが 2 件に増える (実際に増えた)。
        const e = /^error:\s*test failed, to rerun/.test(lines[i])
          ? null
          : lines[i].match(/^error(\[E\d+\])?:\s*(.+)$/);
        if (e) {
          const loc = (lines[i + 1] || '').match(/-->\s+(\S+):(\d+)/);
          failures.push({ file: loc?.[1] || '', line: Number(loc?.[2]) || null, name: e[1] || 'error', msg: e[2] });
        }
      }
      // cargo はテスト対象ごとに集計行を出す (lib / 各 integration / doc-tests)。
      // **最初の1本だけ見ると嘘になる。** workspace だと lib が 0 passed で、
      // 本体の 15 passed が2本目以降に来る。全部足す。
      const sums = [...o.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed(?:; (\d+) ignored)?/gm)];
      const sum = (i) => sums.reduce((a, m) => a + Number(m[i] || 0), 0);
      return {
        counts: {
          passed: sum(1),
          failed: sums.length ? sum(2) : failures.length,
          skipped: sum(3),
        },
        failures: dedupe(failures),
        // 集計行が出ている＝cargo が全部走り切った。全部 0 でも generic に落とさない。
        exact: sums.length > 0,
      };
    },
  },
  {
    name: 'tsc',
    test: (o) => /error TS\d+:/.test(o),
    parse(o) {
      const failures = [];
      for (const m of o.matchAll(/^(\S+?)[(:](\d+)[,:](\d+)\)?:?\s*-?\s*error (TS\d+):\s*(.+)$/gm)) {
        failures.push({ file: m[1], line: Number(m[2]), name: m[4], msg: m[5].slice(0, 160) });
      }
      return { counts: { failed: failures.length, passed: 0, skipped: 0 }, failures };
    },
  },
  {
    name: 'eslint',
    test: (o) => /^\s+\d+:\d+\s+(error|warning)\s/m.test(o),
    parse(o) {
      const lines = o.split('\n');
      const failures = [];
      let file = '';
      for (const l of lines) {
        if (/^\//.test(l.trim()) || /^[\w.\-/]+\.(ts|tsx|js|jsx|mjs|cjs)$/.test(l.trim())) file = l.trim();
        const m = l.match(/^\s+(\d+):(\d+)\s+error\s+(.+?)\s\s+(\S+)$/);
        if (m) failures.push({ file, line: Number(m[1]), name: m[4], msg: m[3] });
      }
      const c = o.match(/(\d+)\s+problems?\s+\((\d+)\s+errors?/);
      return { counts: { failed: Number(c?.[2] || failures.length), passed: 0, skipped: 0 }, failures };
    },
  },
  {
    // node --test (spec reporter)。集計行が「ℹ fail 0」なので、generic に落ちると
    // /\bFAIL\b/i がこの行に当たって「0 passed / 1 failed」という嘘を出す(実際に踏んだ)。
    name: 'node:test',
    test: (o) => /^ℹ\s+(?:tests|pass|fail)\s+\d+/m.test(o),
    parse(o) {
      const lines = o.split('\n');
      const n = (re) => Number(o.match(re)?.[1] ?? 0);
      const failures = [];
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^\s*✖\s+(.+?)\s*(?:\([\d.]+m?s\))?\s*$/);
        if (!m) continue;
        const blk = block(lines, i + 1, 8);
        // 位置はスタックトレース側にあるので gist ではなくブロック全体から拾う
        const loc = blk.join('\n').match(/([\w./-]+\.(?:mjs|cjs|js|ts)):(\d+)/);
        failures.push({ file: loc?.[1] || '', line: Number(loc?.[2]) || null, name: m[1], msg: gist(blk) });
      }
      return {
        counts: { passed: n(/^ℹ\s+pass\s+(\d+)/m), failed: n(/^ℹ\s+fail\s+(\d+)/m), skipped: n(/^ℹ\s+skipped\s+(\d+)/m) },
        failures,
        exact: /^ℹ\s+tests\s+\d+/m.test(o),
      };
    },
  },
];

function countsFrom(o) {
  const g = (re) => Number(o.match(re)?.[1] || 0);
  return {
    passed: g(/(\d+)\s+passed/i),
    failed: g(/(\d+)\s+failed/i),
    skipped: g(/(\d+)\s+(?:skipped|todo)/i),
  };
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((f) => {
    const k = `${f.file}:${f.line}|${f.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 未知のツール向けフォールバック。エラーらしき行だけを拾う */
function generic(o) {
  const lines = o.split('\n').filter((l) => l.trim() && !NOISE.test(l));
  const hits = lines.filter((l) => /\b(error|failed|FAIL|✗|✘|panic|Exception|Traceback)\b/i.test(l));
  const picked = (hits.length ? hits : lines.slice(-10)).slice(0, 20);
  return {
    counts: { passed: 0, failed: hits.length, skipped: 0 },
    failures: picked.map((l) => ({ file: '', line: null, name: '', msg: clean(l).slice(0, 160) })),
  };
}

export function parseOutput(out) {
  for (const p of parsers) {
    if (!p.test(out)) continue;
    try {
      const r = p.parse(out);
      // `exact` は「そのツールの集計行を読めた」の意味。**全部 0 でも採用する。**
      // これが無いと「0 passed / 0 failed」が「何も取れなかった」と区別できず、
      // generic に落ちて集計行の "failed" という語を失敗として数え始める。
      if (r.exact || r.failures.length || r.counts.passed || r.counts.failed) {
        return { framework: p.name, ...r };
      }
    } catch {}
  }
  return { framework: 'generic', ...generic(out) };
}

export const failureId = (f) => `${f.file}:${f.line ?? ''}|${f.name}`;
