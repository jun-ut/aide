import { execFileSync } from 'node:child_process';

const HOOK = '/home/jun/project/aide/hooks/guard-bash.mjs';
let bad = 0;

const t = (cmd, want, note = '') => {
  const o = JSON.parse(
    execFileSync('node', [HOOK], {
      input: JSON.stringify({ tool_input: { command: cmd }, cwd: '/home/jun/project/aide' }),
    }).toString(),
  ).hookSpecificOutput.permissionDecision;
  if (o !== want) bad++;
  const label = JSON.stringify(cmd).slice(0, 72);
  console.log(`${o === want ? 'ok  ' : 'NG  '}${o.toUpperCase().padEnd(5)} ${label}${note ? '  // ' + note : ''}`);
};

// ---- 止めるもの ----
// 2026-09-04 まで、これらは全部素通りしていた。CLAUDE.md に禁止と書いてあっただけ。
t("sed -i 's/a/b/' src/x.rs", 'deny');
t("sed -i.bak 's/a/b/' src/x.rs", 'deny');
t("sed -E -i 's/a/b/' src/x.rs", 'deny', 'オプションを挟んでも');
t("sed --in-place 's/a/b/' src/x.rs", 'deny');
t("perl -pi -e 's/a/b/' src/x.rs", 'deny');
t("perl -i -pe 's/a/b/' src/x.rs", 'deny');
t("perl -pi.bak -e 's/a/b/' src/x.rs", 'deny');
t("cat > src/x.rs <<'EOF'\nfn main() {}\nEOF", 'deny', 'heredoc でのファイル生成');
t('echo x > src/x.rs', 'deny');
t('echo x >> AGENTS.md', 'deny', 'ドキュメントも同じ理由で駄目');
t('cargo expand > crates/a/src/gen.rs', 'deny');
t('echo x | tee src/x.rs', 'deny');
t('python3 -c "open(\'src/x.rs\',\'w\').write(1)"', 'deny');
t('node -e "require(\'fs\').writeFileSync(\'a.mjs\', x)"', 'deny');
t("ls && sed -i 's/a/b/' src/x.rs", 'deny', '後続の断片でも見る');

// ---- 通すもの (誤爆すると hook ごと無効化されるので、ここが本番) ----
t('cat src/util.mjs > /dev/null', 'allow', '/dev/null');
t('agent test > /tmp/out.log', 'allow', 'ログ');
t('node build.mjs 2>&1 | tail -5', 'allow', '2>&1 をリダイレクトと誤読しない');
t('node build.mjs >&2', 'allow', '>&2 も同じ');
t('echo x > /tmp/claude-1000/scratch/a.rs', 'allow', 'スクラッチパッド');
t('cp a.rs target/debug/a.rs', 'allow');
t('echo x > target/gen/a.rs', 'allow', '生成物');
t('echo x > node_modules/.cache/a.json', 'allow');
t("sed -n '1,20p' src/x.rs", 'allow', 'sed -n は読み出し');
t("sed 's/a/b/' src/x.rs | head -5", 'allow', 'その場書き換えでなければ通す');
t("perl -ne 'print' src/x.rs", 'allow', '-ne に i は無い');
t("perl -e 'print 1'", 'allow');
t('python3 -c "print(open(\'src/x.rs\').read())"', 'allow', '読み出しだけ');
t('node --test test/*.test.mjs', 'allow');
t('git diff --stat', 'allow');
t("sed -i 's/a/b/' src/x.rs # ALLOW-SCRIPT-EDIT", 'allow', '例外マーカー');
t("AGENT_RAW=1 sed -i 's/a/b/' src/x.rs", 'allow', 'AGENT_RAW も従来どおり素通し');
t("echo 'sed -i is banned'", 'allow', '引用符の中の文字列に反応しない');

console.log(bad ? `\n${bad} 件 NG` : '\n全件 ok');
process.exit(bad ? 1 : 0);
