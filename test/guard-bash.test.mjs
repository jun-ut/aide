import { execFileSync } from 'node:child_process';
const HOOK = '/home/jun/project/aide/hooks/guard-bash.mjs';
let bad = 0;
const t = (cmd, want) => {
  const o = JSON.parse(
    execFileSync('node', [HOOK], {
      input: JSON.stringify({ tool_input: { command: cmd }, cwd: '/home/jun/project/aide' }),
    }).toString(),
  ).hookSpecificOutput.permissionDecision;
  if (o !== want) bad++;
  console.log(`${o === want ? 'ok  ' : 'NG  '}${o.toUpperCase().padEnd(5)} ${JSON.stringify(cmd).slice(0, 64)}`);
};

// 書き込み先を /tmp にしてある。リポジトリ内の .mjs へ書くのは
// WRITE 規則の担当になった (test/guard-write.test.mjs)。ここで見たいのは
// 「heredoc の本体をコマンドと誤読しないこと」だけ。
t("cat > /tmp/a.mjs <<'EOF'\nconst re=/(test|vitest|jest)/;\npnpm test\nEOF\nnode /tmp/a.mjs", 'allow'); // heredoc本体は無視
t("cat > /tmp/a.mjs <<'EOF'\nx\nEOF\npnpm test", 'deny'); // heredoc後の実コマンドは見る
t('pnpm test', 'deny');
t('cd w && pnpm test', 'deny');
t("echo 'pnpm test'", 'allow');
t('AGENT_RAW=1 pnpm test', 'allow');
t('npx vitest run src', 'deny');
t('python -m pytest -q', 'deny');
// 「出力量が予測できない」は**測れなかったとき**の話。実在するリテラルなパスで
// 合計が小さいなら測れているので止めない。止めても同じ量を Read で読み直すだけで、
// 往復 1 回 (約 34,759 加重トークン) が丸損になる (実際に 2 回そうなった)。
t('cat src/util.mjs', 'deny'); // 8.9KB。ここから先は範囲読みへ誘導する価値がある
t('cat src/session.mjs', 'allow'); // 2.4KB
t('cat src/session.mjs src/cmd/last.mjs', 'allow'); // 複数でも合計で見る
t('cat $f', 'deny'); // 変数は測れない
t('cat src/*.mjs', 'deny'); // グロブも測れない
t('cat does-not-exist.mjs', 'deny'); // 実在しないものも測れない
t('cat f | head -5', 'allow');
t('ls | cat -v', 'allow');
t('git log', 'deny');
t('git log --oneline -n 5', 'allow');
t('git diff', 'deny');
t('git diff --stat', 'allow');
t('grep -rn x src', 'allow');
t('find / -name x', 'deny');
t('find /home/jun -name x', 'deny'); // 絶対パスでも絞られていなければ止める
t('find /home/jun/project/sightline -maxdepth 3', 'allow');
t("find /home/jun/project/sightline -maxdepth 3 -not -path '*/.git/*' | sort", 'allow'); // 実際に誤爆した形
t('find /etc -type d -name x -prune -o -print', 'allow');
t('find . -name x', 'allow'); // 相対パスは対象外のまま
t('node -e "console.log(1)"', 'allow');
console.log(bad ? `\n${bad} 件 NG` : '\n全件 ok');
process.exit(bad ? 1 : 0);
