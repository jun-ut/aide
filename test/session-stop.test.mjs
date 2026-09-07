import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../hooks/session.mjs', import.meta.url));
let bad = 0;

/** 使い捨てのリポジトリを作る。実際の .agent/run/<sid>.json を経由して検証する。 */
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aide-stop-'));
  fs.mkdirSync(path.join(root, '.agent', 'run'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agent', 'state.md'), '# 引き継ぎ\n');
  return root;
}

const run = (event, root, sid, input = {}) =>
  JSON.parse(
    execFileSync('node', [HOOK, event], {
      input: JSON.stringify({ session_id: sid, cwd: root, ...input }),
    }).toString() || '{}',
  );

const edit = (root, sid, file) =>
  run('state-size', root, sid, { tool_input: { file_path: path.join(root, file) } });

const touchState = (root) => {
  // mtime を確実に進める
  const p = path.join(root, '.agent', 'state.md');
  fs.writeFileSync(p, `# 引き継ぎ\n${Date.now()}\n`);
};

const t = (label, got, want) => {
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'NG  '}${label}  (got ${got}, want ${want})`);
};

const blocked = (r) => r.decision === 'block';

// ---- 調べただけのセッションは催促しない ----
{
  const root = repo();
  const sid = 'a';
  run('session-start', root, sid);
  t('編集していなければ催促しない', blocked(run('stop', root, sid)), false);
}

// ---- 編集したのに state.md を書いていなければ催促する ----
{
  const root = repo();
  const sid = 'b';
  run('session-start', root, sid);
  edit(root, sid, 'src/x.rs');
  t('編集後に state.md 未更新なら催促する', blocked(run('stop', root, sid)), true);
}

// ---- 更新すれば止まる ----
{
  const root = repo();
  const sid = 'c';
  run('session-start', root, sid);
  edit(root, sid, 'src/x.rs');
  touchState(root);
  t('state.md を書けば通る', blocked(run('stop', root, sid)), false);
}

// ---- 本題: 序盤に書いてその後も作業した場合 ----
// 旧実装は「セッション開始時刻より後に触られたか」しか見ていなかったので、
// ここを素通ししていた。実際にこれで引き継ぎが 1 コミット遅れた。
{
  const root = repo();
  const sid = 'd';
  run('session-start', root, sid);
  edit(root, sid, 'src/x.rs');
  touchState(root);
  edit(root, sid, 'src/y.rs'); // 記録のあとに作業を続けた
  t('記録より後の作業を検出する', blocked(run('stop', root, sid)), true);
}

// ---- 無限ループしないこと ----
{
  const root = repo();
  const sid = 'e';
  run('session-start', root, sid);
  edit(root, sid, 'src/x.rs');
  t('1 回目は催促', blocked(run('stop', root, sid)), true);
  t('新しい編集が無ければ 2 回目は黙る', blocked(run('stop', root, sid)), false);
}

// ---- 催促を無視してさらに作業したら、また催促する ----
{
  const root = repo();
  const sid = 'f';
  run('session-start', root, sid);
  edit(root, sid, 'src/x.rs');
  run('stop', root, sid);
  edit(root, sid, 'src/z.rs');
  t('催促後に作業が進めば再度催促', blocked(run('stop', root, sid)), true);
}

// ---- stop_hook_active は従来どおり素通し ----
{
  const root = repo();
  const sid = 'g';
  run('session-start', root, sid);
  edit(root, sid, 'src/x.rs');
  t('stop_hook_active は素通し', blocked(run('stop', root, sid, { stop_hook_active: true })), false);
}

// ---- state.md 自身の編集は「作業」に数えない ----
{
  const root = repo();
  const sid = 'h';
  run('session-start', root, sid);
  edit(root, sid, '.agent/state.md');
  t('state.md だけ触ったセッションは催促しない', blocked(run('stop', root, sid)), false);
}

// ---- 引き継ぎのあとに経緯を書き足しても催促しない ----
// **実際に踏んだ。** AGENTS.md が「state.md は全文上書き / 経緯は journal へ」と
// 書いている以上、閉じ方は自然と state.md → journal → commit になる。
// `.agent/` の中を「作業」に数えていると、これだけで誤検知した。
{
  const root = repo();
  const sid = 'i';
  fs.mkdirSync(path.join(root, '.agent', 'journal'), { recursive: true });
  run('session-start', root, sid);
  edit(root, sid, 'src/x.rs');
  touchState(root);
  edit(root, sid, '.agent/journal/2026-09.md');
  t('引き継ぎのあとの journal 追記は作業に数えない', blocked(run('stop', root, sid)), false);
}

// ---- ただし .agent の外は記録でも作業として数える ----
{
  const root = repo();
  const sid = 'j';
  run('session-start', root, sid);
  edit(root, sid, 'src/x.rs');
  touchState(root);
  edit(root, sid, 'docs/decisions/0011-x.md');
  t('docs の更新は作業として数える', blocked(run('stop', root, sid)), true);
}

console.log(bad ? `\n${bad} 件 NG` : '\n全件 ok');
process.exit(bad ? 1 : 0);
