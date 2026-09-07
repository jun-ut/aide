/**
 * agent init [--write] — このプロジェクト用の `.claude/settings.json` を生成する。
 *
 * 存在理由: hook の登録は**絶対パス**でしか書けない。AIDE 本体はプロジェクトの外に
 * 置く設計 (コピーしない) なので、settings.json は導入のたびに手で書き直す羽目になり、
 * 「移動したら壊れるのは settings.json と symlink の 2 つ」という状態が残っていた。
 * ここが生成できれば、残る手作業は PATH だけになる。
 *
 * matcher が `Bash|PowerShell` なのは Claude Code のドキュメントの指示どおり。
 * **Bash だけでは Windows で素通りする** (Git Bash が無ければ PowerShell が唯一のシェル)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellFor } from '../util.mjs';

const AIDE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * `node "<絶対パス>"`。空白を含むパスのために引用符で囲むだけにする。
 *
 * **JSON.stringify で囲まないこと。** Windows では `\` が `\\` に化けたものが
 * そのままシェルへ渡る (`node "C:\\Hub\\...\\session.mjs"`)。動きはするが読めないし、
 * settings.json へ書き出すときの escape は writeFileSync 側の JSON.stringify が別途やる。
 */
const q = (p) => `"${p.replace(/"/g, '\\"')}"`;

const hook = (file, arg) => ({
  type: 'command',
  command: `node ${q(path.join(AIDE, 'hooks', file))}${arg ? ` ${arg}` : ''}`,
});

export function settings() {
  return {
    statusLine: { type: 'command', command: `node ${q(path.join(AIDE, 'hooks', 'statusline.mjs'))}` },
    hooks: {
      SessionStart: [{ hooks: [hook('session.mjs', 'session-start')] }],
      PreCompact: [{ hooks: [hook('session.mjs', 'pre-compact')] }],
      Stop: [{ hooks: [hook('session.mjs', 'stop')] }],
      PreToolUse: [
        { matcher: 'Read', hooks: [hook('read-dedup.mjs')] },
        // **`Bash` だけにしない。** PowerShell ツールは Bash と併存し、Windows では
        // 既定で on になる。ここを狭めると WRITE ルールに穴が開く。
        { matcher: 'Bash|PowerShell', hooks: [hook('guard-bash.mjs')] },
      ],
      PostToolUse: [{ matcher: 'Write|Edit', hooks: [hook('session.mjs', 'state-size')] }],
    },
  };
}

export default function init(argv, cfg) {
  const json = `${JSON.stringify(settings(), null, 2)}\n`;
  const dest = path.join(cfg.__root, '.claude', 'settings.json');
  const notes = [];

  if (process.platform === 'win32' && shellFor() === true) {
    notes.push(
      '⚠ Git Bash が見つかりません。cmd.exe になるためグロブ (test/*.mjs) が展開されません。',
      '  Git for Windows を入れるか、settings.json の env.CLAUDE_CODE_GIT_BASH_PATH を設定してください。',
    );
  }
  notes.push(
    process.platform === 'win32'
      ? `PATH に ${path.join(AIDE, 'bin')} を足すと agent.cmd が使えます。`
      : `ln -s ${path.join(AIDE, 'bin', 'agent')} ~/.local/bin/agent`,
  );

  if (!argv.includes('--write')) {
    console.log(json.trimEnd());
    console.log(`\n# 書き込むなら: agent init --write  (宛先: ${dest})`);
    for (const n of notes) console.log(`# ${n}`);
    return 0;
  }

  if (fs.existsSync(dest) && !argv.includes('--force')) {
    console.log(`init: ${dest} は既にあります。上書きするなら --force を付けてください。`);
    return 2;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, json);
  console.log(`init: ${dest} を書きました。`);
  for (const n of notes) console.log(n);
  return 0;
}
