/**
 * agent init — settings.json の生成。
 *
 * ここで一番大事なのは **matcher が `Bash|PowerShell` であること**。
 * `Bash` だけに戻ると Windows で WRITE ルールが素通りする。回帰したら気づけるようにする。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import init, { settings } from '../src/cmd/init.mjs';

let bad = 0;
const t = (label, cond) => {
  if (!cond) bad++;
  console.log(`${cond ? 'ok  ' : 'NG  '}${label}`);
};

const s = settings();
const pre = s.hooks.PreToolUse;
const shellHook = pre.find((h) => /Bash/.test(h.matcher));

t('シェル系 matcher は Bash|PowerShell', shellHook.matcher === 'Bash|PowerShell');
t('Read は read-dedup', /read-dedup\.mjs/.test(JSON.stringify(pre.find((h) => h.matcher === 'Read'))));
t('guard-bash が登録される', /guard-bash\.mjs/.test(JSON.stringify(shellHook)));
t('SessionStart / PreCompact / Stop が揃う', ['SessionStart', 'PreCompact', 'Stop'].every((k) => s.hooks[k]));
t('PostToolUse は Write|Edit', s.hooks.PostToolUse[0].matcher === 'Write|Edit');
t('statusLine がある', /statusline\.mjs/.test(s.statusLine.command));

// パスは絶対で、引用符で囲まれている (空白を含むパスでも壊れない)。
// **`/` 始まりで書かない。** Windows では `C:\...` になる。ここで見たいのは
// 「引用符の中身が hooks/session.mjs の絶対パスであること」だけ。
const startCmd = s.hooks.SessionStart[0].hooks[0].command;
const quoted = startCmd.match(/^node "(.+)" session-start$/)?.[1];
t(
  'hook は絶対パスを引用符で囲む',
  Boolean(quoted) && path.isAbsolute(quoted) && /[/\\]hooks[/\\]session\.mjs$/.test(quoted),
);
// Windows で `\\` に化けていないこと (JSON.stringify で囲むと起きた)
t('引用符の中に二重の区切りが無い', !/\\\\|\/\//.test(quoted ?? ''));

// ---- --write ----
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aide-init-'));
const dest = path.join(root, '.claude', 'settings.json');
const cfg = { __root: root };

t('引数なしでは書かない', init([], cfg) === 0 && !fs.existsSync(dest));
t('--write で書く', init(['--write'], cfg) === 0 && fs.existsSync(dest));
t('書いたものは JSON として読める', JSON.parse(fs.readFileSync(dest, 'utf8')).hooks.PreToolUse.length === 2);

// **既存を黙って潰さない。** 手で足した設定を消すのが一番痛い事故。
fs.writeFileSync(dest, '{"mine":1}');
t('既存があれば --force なしで拒む', init(['--write'], cfg) === 2);
t('拒んだときは中身を変えない', JSON.parse(fs.readFileSync(dest, 'utf8')).mine === 1);
t('--force なら上書きする', init(['--write', '--force'], cfg) === 0 && !JSON.parse(fs.readFileSync(dest, 'utf8')).mine);

console.log(bad ? `\n${bad} 件 NG` : '\n全件 ok');
process.exit(bad ? 1 : 0);
