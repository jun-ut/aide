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

t("cat > a.mjs <<'EOF'\nconst re=/(test|vitest|jest)/;\npnpm test\nEOF\nnode a.mjs", 'allow'); // heredoc本体は無視
t("cat > a.mjs <<'EOF'\nx\nEOF\npnpm test", 'deny'); // heredoc後の実コマンドは見る
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
t('node -e "console.log(1)"', 'allow');
console.log(bad ? `\n${bad} 件 NG` : '\n全件 ok');
process.exit(bad ? 1 : 0);
