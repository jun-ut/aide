/**
 * shellFor — Windows でどのシェルを使うか。
 *
 * `.agent/config.yml` の commands は POSIX sh の形で書かれている。Windows で
 * `shell: true` のままにすると cmd.exe になり、**グロブを展開しない**ので
 * AIDE 自身の `node --test test/*.test.mjs` すら動かない。
 * 実機が WSL なので、platform と existsSync を注入して両方の枝を踏む。
 */
import { shellFor } from '../src/util.mjs';

let bad = 0;
const t = (label, got, want) => {
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'NG  '}${label}`);
  if (!ok) console.log(`      got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
};

const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const has = (...paths) => (p) => paths.includes(p);
const none = () => false;

// POSIX は既定シェルのまま。ここを触ると WSL/macOS/Linux が壊れる。
t('linux は true のまま', shellFor({}, 'linux', none), true);
t('darwin は true のまま', shellFor({}, 'darwin', none), true);
t('linux では Git Bash があっても無視', shellFor({ CLAUDE_CODE_GIT_BASH_PATH: GIT_BASH }, 'linux', has(GIT_BASH)), true);

// Windows: Claude Code が既に知っている場所を再利用するのが一番ずれない。
t(
  'win32 は CLAUDE_CODE_GIT_BASH_PATH を使う',
  shellFor({ CLAUDE_CODE_GIT_BASH_PATH: GIT_BASH }, 'win32', has(GIT_BASH)),
  GIT_BASH,
);
t(
  'AGENT_SHELL が最優先',
  shellFor({ AGENT_SHELL: 'D:\\sh.exe', CLAUDE_CODE_GIT_BASH_PATH: GIT_BASH }, 'win32', has('D:\\sh.exe', GIT_BASH)),
  'D:\\sh.exe',
);
t(
  'ProgramFiles から組み立てる',
  shellFor({ ProgramFiles: 'C:\\Program Files' }, 'win32', has(GIT_BASH)),
  GIT_BASH,
);
t(
  '存在しないパスは飛ばして次の候補へ',
  shellFor({ CLAUDE_CODE_GIT_BASH_PATH: 'D:\\nope.exe', ProgramFiles: 'C:\\Program Files' }, 'win32', has(GIT_BASH)),
  GIT_BASH,
);
t('既定のインストール先も見る', shellFor({}, 'win32', has(GIT_BASH)), GIT_BASH);

// 見つからなければ cmd.exe に落ちる。**グロブを使わないコマンドは動く**ので、
// ここで止めるより動かした方がよい。落ちたことは agent init が知らせる。
t('見つからなければ true (cmd.exe)', shellFor({}, 'win32', none), true);

// existsSync が投げても落ちない (権限のないパスを候補に含めうる)
t(
  'exists が投げても次へ進む',
  shellFor({ CLAUDE_CODE_GIT_BASH_PATH: 'X:\\x' }, 'win32', (p) => {
    if (p === 'X:\\x') throw new Error('EPERM');
    return p === GIT_BASH;
  }),
  GIT_BASH,
);

console.log(bad ? `\n${bad} 件 NG` : '\n全件 ok');
process.exit(bad ? 1 : 0);
