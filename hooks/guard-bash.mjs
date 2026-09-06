#!/usr/bin/env node
/**
 * PreToolUse(Bash) — 止めるものは 3 種類。
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
 * 逃げ道:
 * - 先頭に AGENT_RAW=1     … 全部素通し (agent 自身の内部実行もこれを使う)
 * - 末尾に # ALLOW-SCRIPT-EDIT … 3 のみ素通し (3ファイル以上の一括置換・構造化データ変換用)
 */
import { repoRoot } from '../src/util.mjs';

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
const UNBOUNDED = [
  // 対象は「ファイルを丸ごと吐く cat」だけ。
  // cat > f / cat << EOF は書き込み、引数なしの cat -v はパイプの受け手なので除外する。
  { re: /^cat\s+(?:-\S+\s+)*[^-<>\s][^<>]*$/, hint: "sed -n 'START,ENDp' か Read(offset/limit) を使ってください" },
  // 絶対パスからの find。-maxdepth / -prune / -quit で絞ってあれば許す。
  // 単に /^find\s+\// だと「ルートから」のつもりで絶対パス全部に当たる(実際に踏んだ)。
  { re: /^find\s+\/(?!.*\s-(?:maxdepth|prune|quit)\b)/, hint: 'find は -maxdepth か -prune で範囲を絞ってください' },
  { re: /^git\s+log\b(?!.*(-n\s|--oneline|-\d))/, hint: 'git log は -n と --oneline を付けてください' },
  { re: /^git\s+diff\b(?!.*(--stat|--name-only|--\s))/, hint: 'git diff は --stat か --name-only で始めてください' },
  { re: /^npm\s+ls\b(?!.*--depth)/, hint: 'npm ls は --depth 0 を付けてください' },
];

const BOUNDED = /\b(head|tail|wc|jq|cut|uniq)\b|\bgrep\b|\brg\b|\bsed\s+-n\b/;

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

const WRITE_OK = /^(?:\/tmp\/|\/dev\/|\/var\/|\/proc\/)|(?:^|\/)(?:target|node_modules|dist|build|coverage|\.git|\.agent)\//;

// その場書き換え。対象が何であれ Write/Edit で書ける。
const INPLACE = [
  { re: /^g?sed\s+(?:--?\S+\s+)*(?:-\S*i\S*|--in-place\S*)(?:\s|$)/, what: 'sed -i' },
  { re: /^perl\s+(?:-\S+\s+)*-\S*i\S*(?:\s|$)/, what: 'perl -i' },
  { re: /^ruby\s+(?:-\S+\s+)*-\S*i\S*(?:\s|$)/, what: 'ruby -i' },
];

/** 断片が書き込む先を集める。`2>&1` や `>&2` は捕まえない。 */
function writeTargets(seg) {
  const out = [];
  for (const m of seg.matchAll(/(?:^|\s)>>?\s*(['"]?)([^\s'"|&;<>]+)\1/g)) out.push(m[2]);
  const tee = seg.match(/^tee\s+(?:-\S+\s+)*(\S+)/);
  if (tee) out.push(tee[1].replace(/^['"]|['"]$/g, ''));
  return out;
}

/** `python -c "... open(f, 'w') ..."` のようなインライン書き込み。 */
function inlineWrite(seg) {
  if (!/^(?:python\d?|node)\s+(?:-\S+\s+)*-(?:c|e|p)\b/.test(seg)) return false;
  return /\bopen\s*\([^)]*['"][wa]\+?['"]/.test(seg) || /\bwriteFileSync\s*\(/.test(seg);
}

function scriptEdit(seg) {
  for (const p of INPLACE) {
    if (p.re.test(seg)) return `${p.what} での書き換え`;
  }
  if (inlineWrite(seg)) return 'スクリプトからの直接書き込み';
  for (const t of writeTargets(seg)) {
    if (SOURCE_EXT.test(t) && !WRITE_OK.test(t)) return `\`${t}\` へのリダイレクト`;
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
  if (!cmd || /AGENT_RAW=1/.test(cmd)) return allow();

  const root = repoRoot(j.cwd || process.cwd());
  const body = stripHeredocs(cmd);
  const segs = segments(body);
  const bounded = BOUNDED.test(body);
  const allowScriptEdit = /#\s*ALLOW-SCRIPT-EDIT\b/.test(cmd);

  for (const seg of segs) {
    if (!allowScriptEdit) {
      const how = scriptEdit(seg);
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
            `生で実行する必要があるときだけ、先頭に AGENT_RAW=1 を付けてください。\n` +
            `(実行場所: ${root})`,
        );
      }
    }
    if (bounded) continue;
    for (const u of UNBOUNDED) {
      if (u.re.test(seg)) {
        return deny(`\`${seg.slice(0, 50)}\` は出力量が予測できません。${u.hint}\n必要なら AGENT_RAW=1 を先頭に付けてください。`);
      }
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
