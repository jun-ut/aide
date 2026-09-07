import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// 絶対パスをリテラルで書かない。Windows では `/home/...` がカレントドライブ相対に
// 解決され (`C:\home\...`)、hook が丸ごと起動できずテストが「起動失敗」で落ちる。
const HOOK = fileURLToPath(new URL('../hooks/guard-bash.mjs', import.meta.url));
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
t('cat src/util.mjs', 'deny');
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
