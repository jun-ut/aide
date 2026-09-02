#!/usr/bin/env node
/**
 * セッションのライフサイクル hook。argv[2] でイベントを切り替える。
 *
 *   session-start : 読み込み履歴をクリアし、開始時刻を記録し、.agent/state.md を1回だけ注入
 *   stop          : state.md がこのセッションで更新されていなければ引き継ぎ更新を強制
 *   pre-compact   : 圧縮前に引き継ぎを書かせ、読み込み履歴をクリア
 *   state-size    : .agent/state.md が上限行数を超えたら圧縮を強制 (PostToolUse)
 *
 * SessionStart の注入はプロンプト先頭で1回きりなのでキャッシュを壊さない。
 * UserPromptSubmit での注入は毎ターン加算されるので使わない。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, repoRoot } from '../src/util.mjs';

const event = process.argv[2] || 'session-start';

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (buf += d));
process.stdin.on('end', () => {
  let j = {};
  try {
    j = JSON.parse(buf);
  } catch {}
  const root = repoRoot(j.cwd || process.cwd());
  const cfg = loadConfig(root);
  const sid = j.session_id || 'default';
  const runDir = path.join(root, '.agent', 'run');
  const statePath = path.join(root, '.agent', 'state.md');
  fs.mkdirSync(runDir, { recursive: true });
  const meta = path.join(runDir, `${sid}.json`);

  switch (event) {
    case 'session-start': {
      rm(path.join(runDir, `${sid}.reads.json`));
      fs.writeFileSync(meta, JSON.stringify({ startedAt: Date.now() }));
      const state = readOr(statePath);
      if (!state) return ok();
      return ok({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext:
            `# 引き継ぎ (.agent/state.md)\n${state}\n\n` +
            `作業を終える前に必ず .agent/state.md を「全文上書き」で更新すること(追記しない)。`,
        },
      });
    }

    case 'pre-compact': {
      rm(path.join(runDir, `${sid}.reads.json`));
      return ok({
        hookSpecificOutput: {
          hookEventName: 'PreCompact',
          additionalContext:
            '圧縮の前に .agent/state.md を最新化してください。圧縮後はこのファイルが唯一の連続性です。',
        },
      });
    }

    case 'stop': {
      if (j.stop_hook_active) return ok(); // 無限ループ防止
      const m = readJson(meta) || {};
      const started = m.startedAt || 0;
      const mtime = fs.existsSync(statePath) ? fs.statSync(statePath).mtimeMs : 0;
      // 何も書き換えていないセッション(調べただけ)では催促しない
      if (!m.edited || mtime >= started || m.nagged) return ok();
      fs.writeFileSync(meta, JSON.stringify({ ...m, nagged: true }));
      return block(
        '.agent/state.md がこのセッションで更新されていません。終了する前に、' +
          '全文を上書きする形で「今の目標 / 直近やったこと(5行以内) / 次のTODO / 未解決 / 触っているファイル」を更新してください。' +
          '追記ではなく書き直しです。詳細な経緯は .agent/journal/ に回してください。',
      );
    }

    case 'state-size': {
      // Write/Edit のたびに走るので、ここで「このセッションは書き換えを行った」を記録する
      const m = readJson(meta) || {};
      if (!m.edited) fs.writeFileSync(meta, JSON.stringify({ ...m, edited: true }));
      const p = j.tool_input?.file_path || '';
      if (!p.endsWith(path.join('.agent', 'state.md'))) return ok();
      const max = cfg.state?.max_lines ?? 150;
      const n = readOr(statePath).split('\n').length;
      if (n <= max) return ok();
      return block(
        `.agent/state.md が ${n} 行で上限 ${max} 行を超えました。` +
          `古い経緯を .agent/journal/ に移し、定着した知識は docs/ に昇格させて、${max} 行以内に圧縮してください。`,
      );
    }
  }
  ok();
});

const rm = (p) => {
  try {
    fs.unlinkSync(p);
  } catch {}
};
const readOr = (p, d = '') => {
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    return d;
  }
};
const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
function ok(obj) {
  if (obj) process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}
function block(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}
