/**
 * SessionStart の status_command 注入。
 *
 * ここで見たいのは 2 つだけ。どちらも「status_command が行儀よく書かれている」
 * ことに依存しない保証で、AIDE 本体が持つべき性質:
 *   1. 途中で死んでも、出た分は残る (タイムアウトで全部消えない)
 *   2. どれだけ喋られても、プレフィクスに入る量には上限がある
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOOK = '/home/jun/project/aide/hooks/session.mjs';
let bad = 0;

const t = (label, got, want) => {
  const ok = want instanceof RegExp ? want.test(got) : got === want;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'NG  '}${label}`);
  if (!ok) console.log(`      got ${JSON.stringify(String(got).slice(0, 300))}`);
};

/** status_command だけを設定した使い捨てリポジトリ。 */
function repo(yml) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aide-status-'));
  fs.mkdirSync(path.join(root, '.agent'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agent', 'config.yml'), yml);
  return root;
}

/** SessionStart を実行して additionalContext を返す。state.md は置かない。 */
function inject(root) {
  const o = JSON.parse(
    execFileSync('node', [HOOK, 'session-start'], {
      input: JSON.stringify({ session_id: 'status-test', cwd: root }),
    }).toString() || '{}',
  );
  return o.hookSpecificOutput?.additionalContext ?? '';
}

// ---- 1. 途中まで出た分を捨てない ----
// 3 行出してから、タイムアウトを確実に超えるまで眠るコマンド。
// 修正前はここで status ブロックが `(... が失敗した: ...)` 1 行に化けていた。
{
  const root = repo(
    'session:\n' +
      '  status_command: printf \'A\\nB\\nC\\n\'; sleep 5\n' +
      '  status_timeout_sec: 1\n',
  );
  const ctx = inject(root);
  t('タイムアウトしても出た分は残る', ctx, /A\nB\nC/);
  t('完走しなかったことは伝える', ctx, /完走しなかった/);
}

// ---- 2. 行数に上限がある ----
{
  const root = repo(
    'session:\n' +
      '  status_command: seq 1 500\n' +
      '  status_max_lines: 5\n',
  );
  const ctx = inject(root);
  const body = ctx.split('\n').filter((l) => /^\d+$/.test(l));
  t('status_max_lines で打ち切る', body.length, 5);
  t('省略したことを伝える', ctx, /\+495 行/);
}

// limits.max_lines にフォールバックする (status 専用の設定が無いとき)
{
  const root = repo('limits:\n  max_lines: 3\nsession:\n  status_command: seq 1 50\n');
  const ctx = inject(root);
  t('status_max_lines が無ければ limits.max_lines', ctx.split('\n').filter((l) => /^\d+$/.test(l)).length, 3);
}

// ---- 3. 未設定なら何も実行しない (既定で無害) ----
{
  const root = repo('limits:\n  max_lines: 40\n');
  t('status_command 未設定なら注入しない', inject(root), '');
}

console.log(bad ? `\n${bad} 件 NG` : '\n全件 ok');
process.exit(bad ? 1 : 0);
