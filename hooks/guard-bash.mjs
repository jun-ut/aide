#!/usr/bin/env node
/**
 * PreToolUse(Bash|PowerShell) — 止めるものは 3 種類。
 *
 * 1. 生のテスト/lint/build   → agent ラッパへ誘導 (WRAPPED)
 * 2. 出力が青天井のコマンド   → 絞り方を指示 (UNBOUNDED)
 * 3. **シェル経由のソース書き換え** → Write/Edit へ誘導 (WRITE)
 *
 * AGENTS.md に書いても守られないことがある。hook は必ず守られる。
 * これが「強制できるものは hook へ」の実装。
 *
 * 3 は 2026-09-04 に追加した。それまで CLAUDE.md / AGENTS.md に
 * 「sed -i 禁止」と書いてあるだけで**何も強制されていなかった**。
 * 実際に sed -i / perl -pi / heredoc が素通りすることを確認して分かった。
 *
 * **PowerShell も見る (2026-09-07 に追加)。** Claude Code のドキュメントが明示している:
 * 「シェルコマンドを検査する hook は `Bash|PowerShell` を matcher にせよ。Bash だけでは
 * 不十分」。とくに **Windows で Git Bash が無いと PowerShell が唯一のシェルになる**ので、
 * ここが無いと Windows では 3 のルールが丸ごと無効になる。せっかく hook で強制した
 * ものが、プラットフォームを変えただけで「書いてあるだけ」に戻る。
 *
 * 逃げ道:
 * - 先頭に AGENT_RAW=1     … 全部素通し (agent 自身の内部実行もこれを使う)
 *   PowerShell では `$env:AGENT_RAW=1;` / `$env:AGENT_RAW='1';` も同じ扱い。
 * - 末尾に # ALLOW-SCRIPT-EDIT … 3 のみ素通し (3ファイル以上の一括置換・構造化データ変換用)
 */
import { statSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../src/util.mjs';

/**
 * 「出力量が予測できない」は**測れなかったとき**の話。引数がそのままファイル名で、
 * 実在して、合計が小さいなら出力量は分かっている —— deny の前提が成り立たない。
 *
 * 閾値の根拠: これより小さいファイルは**どうせ全部読む**ので、止めても同じ内容を
 * Read で読み直すだけになり、往復 1 回 (約 34,759 加重トークン) が丸損になる。
 * 実際に 2 回そうなった —— 9〜30 行のファイル 7 個と、202 行のファイル 1 個。
 * どちらも止められた後、同じ量を読んでいる。ここより大きいときだけ誘導に価値がある。
 *
 * 変数・グロブ・引用符が混じったら測れない。**そのときは今までどおり止める。**
 */
const MEASURABLE_BYTES = 8192;

function measuredSmall(seg, cwd) {
  const args = seg.replace(/^\w+\s+/, '').trim();
  if (!args || /[$`*?~[\]{}<>|"']/.test(args)) return false;
  let total = 0;
  for (const a of args.split(/\s+/)) {
    if (a.startsWith('-')) continue;
    try {
      const st = statSync(path.resolve(cwd, a));
      if (!st.isFile()) return false;
      total += st.size;
    } catch {
      return false;
    }
  }
  return total > 0 && total <= MEASURABLE_BYTES;
}

// すべて「コマンド位置」に錨を打つ。そうしないと echo '...pnpm test...' のような
// 引用符の中の文字列にまで反応してしまう(実際に踏んだ)。
const WRAPPED = [
  { re: /^(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test\b/, use: 'agent test' },
  { re: /^(?:npx\s+)?(?:vitest|jest)\b/, use: 'agent test' },
  { re: /^(?:python\d?\s+-m\s+)?pytest\b/, use: 'agent test' },
  { re: /^go\s+test\b/, use: 'agent test' },
  { re: /^cargo\s+test\b/, use: 'agent test' },
  { re: /^(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?lint|(?:npx\s+)?eslint|ruff\s+check)\b/, use: 'agent lint' },
  { re: /^(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?build|cargo\s+build|go\s+build)\b/, use: 'agent build' },
  { re: /^(?:npx\s+)?tsc\b(?!.*--help)/, use: 'agent typecheck' },
];

// 出力量が予測できないコマンド。head/tail/grep で絞られていれば許す。
// シェルに依らないもの (git / npm は同じ形で呼ばれる)。
const UNBOUNDED_ANY = [
  { re: /^git\s+log\b(?!.*(-n\s|--oneline|-\d))/, hint: 'git log は -n と --oneline を付けてください' },
  { re: /^git\s+diff\b(?!.*(--stat|--name-only|--\s))/, hint: 'git diff は --stat か --name-only で始めてください' },
  { re: /^npm\s+ls\b(?!.*--depth)/, hint: 'npm ls は --depth 0 を付けてください' },
];

const UNBOUNDED_SH = [
  // 対象は「ファイルを丸ごと吐く cat」だけ。
  // cat > f / cat << EOF は書き込み、引数なしの cat -v はパイプの受け手なので除外する。
  {
    re: /^cat\s+(?:-\S+\s+)*[^-<>\s][^<>]*$/,
    measurable: true,
    hint: "sed -n 'START,ENDp' か Read(offset/limit) を使ってください",
  },
  // 絶対パスからの find。-maxdepth / -prune / -quit で絞ってあれば許す。
  // 単に /^find\s+\// だと「ルートから」のつもりで絶対パス全部に当たる(実際に踏んだ)。
  { re: /^find\s+\/(?!.*\s-(?:maxdepth|prune|quit)\b)/, hint: 'find は -maxdepth か -prune で範囲を絞ってください' },
];

// PowerShell 版。**find の教訓に従い「危険な形」ではなく「絞られていない形」を書く。**
const UNBOUNDED_PS = [
  {
    re: /^(?:Get-Content|gc)\b(?!.*-(?:TotalCount|Tail|First)\b)(?!\s*$)/i,
    hint: 'Get-Content は -TotalCount / -Tail で絞るか Read(offset/limit) を使ってください',
  },
  {
    re: /^(?:Get-ChildItem|gci)\b(?=.*-Recurse)(?!.*-Depth\b)/i,
    hint: 'Get-ChildItem -Recurse は -Depth で絞ってください',
  },
];

const BOUNDED_SH = /\b(head|tail|wc|jq|cut|uniq)\b|\bgrep\b|\brg\b|\bsed\s+-n\b/;
// PowerShell の「絞った」形。-First/-Last は Select-Object 以外にも付くので単体で見る。
// `\b-First` は動かない。空白と `-` はどちらも非単語文字なので境界にならない。
// (書いた直後に気づいた類の罠なので、形を残しておく)
const BOUNDED_PS = /\bSelect-(?:Object|String)\b|\bMeasure-Object\b|(?:^|\s)-(?:First|Last|TotalCount|Tail)\b|\brg\b|\bgrep\b/i;

// ---- シェル経由のソース書き換え ----
//
// Write/Edit なら差分がユーザーに見え、PostToolUse の formatter/lint が走り、
// ファイル単位の権限ルールも効く。シェル経由だとそのどれも起きない。
//
// 誤爆すると hook ごと無効化されるので、**対象を絞る**:
// ソースらしい拡張子で、かつ生成物・一時ファイル・リポジトリ外でないものだけ。
// `> out.log` も `> /dev/null` も `> /tmp/...` も通る。
const SOURCE_EXT =
  /\.(?:rs|ts|tsx|js|jsx|mjs|cjs|py|go|rb|php|java|kt|swift|c|h|cc|cpp|hpp|cs|sh|bash|zsh|sql|css|scss|html|vue|svelte|sl|md|json|ya?ml|toml)$/i;

// 書いてよい先。判定前に `\` を `/` に正規化するので、ここは `/` だけ見ればよい。
// Windows 分: %TEMP% / $env:TEMP、AppData/Local/Temp、PowerShell の $null、
// および Git Bash のドライブ表記 (/c/Users/...)。POSIX の /tmp も MSYS 上で生きている。
const WRITE_OK = new RegExp(
  [
    '^(?:/tmp/|/dev/|/var/|/proc/)', // POSIX
    '^(?:[A-Za-z]:)?/(?:dev|tmp)/', // C:/tmp/ のような形
    '^\\$null$', // PowerShell の /dev/null
    '^(?:%TEMP%|%TMP%|\\$env:TEMP|\\$env:TMP)(?:/|$)',
    '/AppData/Local/Temp/',
    '(?:^|/)(?:target|node_modules|dist|build|coverage|\\.git|\\.agent)/',
  ].join('|'),
  'i',
);

/** Windows パスも同じ物差しで測れるようにする。引用符も落とす。 */
const normPath = (t) => String(t).replace(/^['"]|['"]$/g, '').replace(/\\/g, '/');

// その場書き換え。対象が何であれ Write/Edit で書ける。
const INPLACE = [
  { re: /^g?sed\s+(?:--?\S+\s+)*(?:-\S*i\S*|--in-place\S*)(?:\s|$)/, what: 'sed -i' },
  { re: /^perl\s+(?:-\S+\s+)*-\S*i\S*(?:\s|$)/, what: 'perl -i' },
  { re: /^ruby\s+(?:-\S+\s+)*-\S*i\S*(?:\s|$)/, what: 'ruby -i' },
];

/** `>` / `>>` の書き込み先。`2>&1` や `>&2` は捕まえない。両シェル共通の形。 */
function redirTargets(seg) {
  const out = [];
  for (const m of seg.matchAll(/(?:^|\s)>>?\s*(['"]?)([^\s'"|&;<>]+)\1/g)) out.push(m[2]);
  return out;
}

/** sh 側だけの書き込み口。 */
function shWriteTargets(seg) {
  const tee = seg.match(/^tee\s+(?:-\S+\s+)*(\S+)/);
  return tee ? [tee[1]] : [];
}

/**
 * PowerShell の書き込み cmdlet が書く先。
 * `"x" | Set-Content src/a.rs` は segments() が `|` で割るので断片の先頭に来る。
 *
 * **エイリアス (sc / ac) は入れない。** `sc` は Windows の実コマンド (sc query) で、
 * 誤爆すると hook ごと無効化される。find の教訓と同じで、広く取るより外さない方を選ぶ。
 */
function psWriteTargets(seg) {
  const out = [];
  const m = seg.match(/^(?:Out-File|Set-Content|Add-Content|Tee-Object|New-Item)\b(.*)$/i);
  if (m) {
    const named = m[1].match(/-(?:Path|FilePath|LiteralPath)\s+(['"]?)([^\s'"]+)\1/i);
    if (named) out.push(named[2]);
    else {
      // 位置指定引数。`-` で始まるものはフラグなので拾わない。
      const pos = m[1].match(/^\s+(['"]?)([^\s'"-][^\s'"]*)\1/);
      if (pos) out.push(pos[2]);
    }
  }
  // [IO.File]::WriteAllText('src/a.rs', ...) — .NET 直呼びの抜け道
  for (const w of seg.matchAll(/\[(?:System\.)?IO\.File\]::Write\w+\(\s*(['"])([^'"]+)\1/gi)) out.push(w[2]);
  return out;
}

/** `python -c "... open(f, 'w') ..."` のようなインライン書き込み。 */
function inlineWrite(seg) {
  if (!/^(?:python\d?|node)\s+(?:-\S+\s+)*-(?:c|e|p)\b/.test(seg)) return false;
  return /\bopen\s*\([^)]*['"][wa]\+?['"]/.test(seg) || /\bwriteFileSync\s*\(/.test(seg);
}

function scriptEdit(seg, ps) {
  // sed -i / perl -pi は PowerShell からも呼べる (Git for Windows が PATH に置く)。
  // シェルが変わっても禁止する理由は変わらないので、両方で見る。
  for (const p of INPLACE) {
    if (p.re.test(seg)) return `${p.what} での書き換え`;
  }
  if (inlineWrite(seg)) return 'スクリプトからの直接書き込み';
  const targets = [...redirTargets(seg), ...(ps ? psWriteTargets(seg) : shWriteTargets(seg))];
  for (const t of targets) {
    const p = normPath(t);
    if (SOURCE_EXT.test(p) && !WRITE_OK.test(p)) return `\`${t}\` への書き込み`;
  }
  return null;
}

/**
 * heredoc の本体を落とす。中身はデータであってコマンドではない。
 * これを忘れると、スクリプト内の正規表現 /(test|vitest)/ の `|` をパイプと誤読する。
 */
function stripHeredocs(cmd) {
  const lines = cmd.split('\n');
  const out = [];
  let term = null;
  for (const l of lines) {
    if (term) {
      if (l.trim() === term) term = null;
      continue;
    }
    const m = l.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    out.push(l);
    if (m) term = m[2];
  }
  return out.join('\n');
}

/**
 * シェル文字列をコマンド位置の断片に割る。
 * 引用符の中は区切らないので、echo "a && b" は 1 断片のまま。
 */
function segments(cmd) {
  const out = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === q && cmd[i - 1] !== '\\') q = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      cur += c;
      continue;
    }
    if (c === ';' || c === '\n' || ((c === '&' || c === '|') && cmd[i + 1] === c) || c === '|') {
      out.push(cur);
      cur = '';
      if (cmd[i + 1] === c) i++;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  // 先頭の環境変数代入と括弧を落とす
  return out.map((s) => s.trim().replace(/^[({\s]+/, '').replace(/^(?:\w+=\S*\s+)+/, '').trim()).filter(Boolean);
}

let s = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (s += d));
process.stdin.on('end', () => {
  let j = {};
  try {
    j = JSON.parse(s);
  } catch {
    return allow();
  }
  const cmd = String(j.tool_input?.command || '');
  // PowerShell では `$env:AGENT_RAW=1;` や `$env:AGENT_RAW='1';` と書く。
  if (!cmd || /AGENT_RAW\s*=\s*['"]?1/.test(cmd)) return allow();

  // どちらのツールから来たか。tool_input.command はどちらも同じ形で入る。
  const ps = j.tool_name === 'PowerShell';
  const cwd = j.cwd || process.cwd();
  const root = repoRoot(cwd);
  // heredoc は sh のもの。PowerShell の here-string (@" "@) には `|` を
  // コマンド位置と誤読させる形が無いので、そのまま流す。
  const body = ps ? cmd : stripHeredocs(cmd);
  const segs = segments(body);
  const bounded = (ps ? BOUNDED_PS : BOUNDED_SH).test(body);
  const unbounded = [...UNBOUNDED_ANY, ...(ps ? UNBOUNDED_PS : UNBOUNDED_SH)];
  const allowScriptEdit = /#\s*ALLOW-SCRIPT-EDIT\b/.test(cmd);
  // 逃げ道の書き方はシェルで違う。間違った例を出すと素直に詰まるので分ける。
  const raw = ps ? "$env:AGENT_RAW='1';" : 'AGENT_RAW=1';

  for (const seg of segs) {
    if (!allowScriptEdit) {
      const how = scriptEdit(seg, ps);
      if (how) {
        return deny(
          `${how} は禁止です。Read → Edit / Write を使ってください。\n` +
            `理由: シェル経由だと差分がユーザーに見えず、PostToolUse の formatter / lint が走らず、\n` +
            `ファイル単位の権限ルールも迂回します。\n` +
            `例外 (3 ファイル以上の機械的な一括置換、構造化データの変換、生成物・使い捨ての一時ファイル) は、\n` +
            `理由を 1 行述べたうえで末尾に \`# ALLOW-SCRIPT-EDIT\` を付けてください。`,
        );
      }
    }
    for (const w of WRAPPED) {
      if (w.re.test(seg)) {
        return deny(
          `\`${seg.slice(0, 50)}\` の代わりに \`${w.use}\` を使ってください。\n` +
            `理由: 出力が固定形式・行数上限つきになり、全文は .agent/runs/ に退避され、前回との差分だけが出ます。\n` +
            `生で実行する必要があるときだけ、先頭に ${raw} を付けてください。\n` +
            `(実行場所: ${root})`,
        );
      }
    }
    if (bounded) continue;
    for (const u of unbounded) {
      if (!u.re.test(seg)) continue;
      // 測れて小さいなら「予測できない」が嘘になる。止める理由が無い。
      if (u.measurable && measuredSmall(seg, cwd)) continue;
      return deny(`\`${seg.slice(0, 50)}\` は出力量が予測できません。${u.hint}\n必要なら ${raw} を先頭に付けてください。`);
    }
  }
  allow();
});

function allow() {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }));
  process.exit(0);
}
function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    }),
  );
  process.exit(0);
}
