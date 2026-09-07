/**
 * guard-bash を PowerShell ツール経由で叩く。
 *
 * 存在理由: Claude Code のドキュメントが明示している —
 * 「シェルコマンドを検査する hook は `Bash|PowerShell` を matcher にせよ。
 *   Bash だけでは不十分」。
 * **Windows で Git Bash が無ければ PowerShell が唯一のシェル**になるので、ここが
 * 無いと WRITE ルールが Windows でだけ丸ごと無効になる。hook で強制したはずのものが、
 * プラットフォームを変えただけで「ドキュメントに書いてあるだけ」に戻る。
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../hooks/guard-bash.mjs', import.meta.url));
let bad = 0;

const t = (cmd, want, note = '') => {
  const o = JSON.parse(
    execFileSync('node', [HOOK], {
      input: JSON.stringify({
        tool_name: 'PowerShell',
        tool_input: { command: cmd },
        cwd: '/home/jun/project/aide',
      }),
    }).toString(),
  ).hookSpecificOutput.permissionDecision;
  if (o !== want) bad++;
  console.log(`${o === want ? 'ok  ' : 'NG  '}${o.toUpperCase().padEnd(5)} ${JSON.stringify(cmd).slice(0, 62)}${note ? '  // ' + note : ''}`);
};

// ---- WRITE: 止めるもの ----
t("Set-Content -Path src/x.rs -Value 'a'", 'deny');
t("Set-Content src/x.rs -Value 'a'", 'deny', '位置指定引数');
t("'x' | Out-File -FilePath src/x.rs", 'deny', 'パイプの受け手');
t("'x' | Set-Content src\\x.rs", 'deny', 'Windows の \\ 区切り');
t("Add-Content AGENTS.md 'x'", 'deny', 'ドキュメントも同じ');
t('echo x > src/x.rs', 'deny', 'リダイレクトは両シェル共通');
t("[IO.File]::WriteAllText('src/x.rs', $s)", 'deny', '.NET 直呼びの抜け道');
t("[System.IO.File]::WriteAllLines('src/x.rs', $s)", 'deny');
t("sed -i 's/a/b/' src/x.rs", 'deny', 'Git for Windows の sed も PATH に居る');

// ---- WRITE: 通すもの (誤爆すると hook ごと無効化される) ----
t("'x' > $null", 'allow', 'PowerShell の /dev/null');
t('Out-File -FilePath $env:TEMP/a.rs', 'allow', '$env:TEMP');
t('echo x > C:\\Users\\jun\\AppData\\Local\\Temp\\a.rs', 'allow', 'Windows の temp');
t("Set-Content target/gen/a.rs 'x'", 'allow', '生成物');
t('New-Item -ItemType Directory -Path src/foo', 'allow', 'ディレクトリ作成');
t('Write-Host "wrote src/x.rs"', 'allow', '文字列の中の .rs に反応しない');
t("Set-Content src/x.rs 'a' # ALLOW-SCRIPT-EDIT", 'allow', '例外マーカー');
t("$env:AGENT_RAW='1'; Set-Content src/x.rs 'a'", 'allow', 'PowerShell 版の逃げ道');
t('$env:AGENT_RAW=1; Set-Content src/x.rs', 'allow', '引用符なしでも');

// ---- WRAPPED: シェルに依らない ----
t('cargo test', 'deny');
t('agent test', 'allow');

// ---- UNBOUNDED ----
t('Get-Content src/util.mjs', 'deny', 'ファイル丸ごと');
t('Get-Content src/util.mjs -TotalCount 20', 'allow', '絞ってある');
t('Get-Content src/util.mjs | Select-Object -First 20', 'allow');
t('Get-ChildItem -Recurse', 'deny');
t('Get-ChildItem -Recurse -Depth 2', 'allow');
t('Get-ChildItem', 'allow', '-Recurse が無ければ対象外');
t('git diff', 'deny', 'git は両シェル共通');
t('git diff --stat', 'allow');
t('Select-String -Pattern x -Path src', 'allow');

console.log(bad ? `\n${bad} 件 NG` : '\n全件 ok');
process.exit(bad ? 1 : 0);
