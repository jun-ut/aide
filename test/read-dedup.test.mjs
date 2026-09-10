import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 絶対パスをリテラルで書かない (guard-bash.test.mjs と同じ理由)。
const HOOK = fileURLToPath(new URL('../hooks/read-dedup.mjs', import.meta.url));

// repoRoot() は .agent があるディレクトリを根とみなすので、temp に生やす。
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aide-dedup-')));
fs.mkdirSync(path.join(root, '.agent'), { recursive: true });
const target = path.join(root, 'a.mjs');
fs.writeFileSync(target, 'x');

const SID = 'sess1';
const BASE = { ...process.env };
delete BASE.AGENT_NO_DEDUP;

let bad = 0;
const t = (label, got, want) => {
  const okc = got === want;
  if (!okc) bad++;
  console.log(`${okc ? 'ok  ' : 'NG  '}${label}  (got ${got}, want ${want})`);
};

const run = (input, env = {}) =>
  JSON.parse(
    execFileSync('node', [HOOK], {
      input: JSON.stringify({ session_id: SID, cwd: root, ...input }),
      env: { ...BASE, ...env },
    }).toString(),
  ).hookSpecificOutput.permissionDecision;

const read = (fp = target, extra = {}, env = {}) => run({ tool_input: { file_path: fp, ...extra } }, env);

const log = () => {
  const p = path.join(root, '.agent', 'run', `${SID}.denies.json`);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
};
const count = (type) => log().filter((e) => e.type === type).length;

t('初回は通す', read(), 'allow');
t('mtime が同じなら 2 回目は止める', read(), 'deny');
t('止めたことを記録する', count('deny'), 1);

t('offset つきの範囲読みは止めない', read(target, { offset: 1, limit: 5 }), 'allow');
t('範囲読みは拒否に数えない', count('deny'), 1);

// 範囲読みは元々止めないので、逃げ道と併用されても誤検知には数えない。
t('範囲読み + 逃げ道は bypass に数えない', read(target, { limit: 5 }, { AGENT_NO_DEDUP: '1' }), 'allow');
t('bypass はまだ 0', count('bypass'), 0);

// **逃げ道を使われた = 止めたのが誤りだった**。誤検知率の分子はこれ。
t('逃げ道は通す', read(target, {}, { AGENT_NO_DEDUP: '1' }), 'allow');
t('逃げ道を使われたことを記録する', count('bypass'), 1);

// 正当な読み直し: 中身が変われば mtime/size が変わるので自動で通る。
fs.writeFileSync(target, 'xy');
t('内容が変われば通す', read(), 'allow');
t('正当な読み直しは拒否に数えない', count('deny'), 1);
t('更新後にもう一度読めば止める', read(), 'deny');
t('2 件目の拒否も記録する', count('deny'), 2);

t('file_path が無ければ通す', run({ tool_input: {} }), 'allow');
t('存在しないファイルは通す', read(path.join(root, 'none.mjs')), 'allow');

// 記録が壊れていても hook 自体は落ちない (落ちると Read が丸ごと止まる)。
fs.writeFileSync(path.join(root, '.agent', 'run', `${SID}.denies.json`), 'not json');
t('記録が壊れていても止め続ける', read(), 'deny');
t('壊れた記録は捨てて数え直す', count('deny'), 1);

fs.rmSync(root, { recursive: true, force: true });
console.log(bad ? `\n${bad} 件 NG` : '\n全件 ok');
process.exit(bad ? 1 : 0);
