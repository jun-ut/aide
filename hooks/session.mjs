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
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, repoRoot, shellPath, stripAnsi } from '../src/util.mjs';

/**
 * `.agent/config.yml` の `session.status_command` を実行して現在地を注入する。
 *
 * state.md は人が書くので必ず古くなる。**実測値は毎回計算して渡す**のが唯一の解。
 * 既定では何も実行しない (プロジェクトごとに何が「現在地」かは違うため)。
 * 失敗しても起動を壊さない — 現在地が無いことより起動しないことの方が困る。
 */
function runStatus(root, cfg) {
  const cmd = cfg.session?.status_command;
  if (!cmd) return '';
  // **ここはプレフィクスに入る = トークン単価が最も高い置き場所**なので、
  // 他のどの出力経路より厳しく絞る。上限が無いと、status_command が行儀よく
  // 書かれているかどうかに全セッションのコストが依存してしまう。
  const max = cfg.session.status_max_lines ?? cfg.limits?.max_lines ?? 40;
  const clip = (s) => {
    const t = String(s ?? '').trim();
    if (!t) return '';
    const arr = t.split('\n');
    if (arr.length <= max) return t;
    return [...arr.slice(0, max), `… +${arr.length - max} 行 (${cmd} を直接叩く)`].join('\n');
  };
  let out;
  try {
    out = execSync(cmd, {
      cwd: root,
      // status_command も POSIX sh の形で書かれる (sightline の bin/status は bash)。
      // Windows で既定の cmd.exe に落とすと動かないので runCapture と同じ解決を使う。
      shell: shellPath(),
      encoding: 'utf8',
      timeout: (cfg.session.status_timeout_sec ?? 30) * 1000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AGENT_RAW: '1', NO_COLOR: '1' },
    })
      .replace(/\[[0-9;]*m/g, '')
      .trim();
  } catch (e) {
    // **途中まで出た分を捨てない。** execSync はタイムアウトでも非ゼロ終了でも
    // e.stdout に出力を持っている。ここで e.message だけ返すと、status_command の
    // 最後の 1 手が遅いだけで git も TODO も地図も全部消える。しかもそれが起きるのは
    // ビルドが冷えているとき ＝ **新規 clone 直後**、地図が最も要る場面。
    const why = String(e.message).split('\n')[0];
    const partial = clip(stripAnsi(e.stdout));
    return partial ? `${partial}\n(注: ${cmd} は完走しなかった: ${why})` : `(${cmd} が失敗した: ${why})`;
  }
  return clip(out);
}

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
  // 「最後の編集」と「最後の催促」は**ファイルの mtime で**持つ。
  // Date.now() と mtime は別の時計で、この環境では数 ms ずれる(実際に踏んだ)。
  // 両辺を FS の時計に揃えないと比較が壊れる。
  const editMark = path.join(runDir, `${sid}.edit`);
  const nagMark = path.join(runDir, `${sid}.nag`);

  switch (event) {
    case 'session-start': {
      rm(path.join(runDir, `${sid}.reads.json`));
      rm(editMark);
      rm(nagMark);
      fs.writeFileSync(meta, JSON.stringify({ startedAt: Date.now() }));
      const state = readOr(statePath);
      const status = runStatus(root, cfg);
      if (!state && !status) return ok();
      return ok({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext:
            (state ? `# 引き継ぎ (.agent/state.md)\n${state}\n\n` : '') +
            (status ? `# 現在地 (${cfg.session.status_command} の出力・実測値)\n${status}\n\n` : '') +
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
      const lastEdit = mtimeOf(editMark);
      // 何も書き換えていないセッション(調べただけ)では催促しない。
      if (!lastEdit) return ok();
      // **「最後の編集より後に」state.md が書かれたか**を見る。
      // セッション開始時刻と比べるだけだと、序盤に state.md を書いて
      // そのあと何時間も作業した場合を素通ししてしまう(実際に踏んだ)。
      if (mtimeOf(statePath) >= lastEdit) return ok();
      // 催促のあと新しい編集が無ければ黙る。あれば作業が進んだので改めて催促する。
      if (mtimeOf(nagMark) >= lastEdit) return ok();
      fs.writeFileSync(nagMark, '');
      return block(
        '.agent/state.md が最後の編集より古いままです (更新したあとに作業を続けた場合も含む)。' +
          '**引き継ぎは最後に書く。** 終了する前に、' +
          '全文を上書きする形で「今の目標 / 直近やったこと(5行以内) / 次のTODO / 未解決 / 触っているファイル」を更新してください。' +
          '追記ではなく書き直しです。詳細な経緯は .agent/journal/ に回してください。',
      );
    }

    case 'state-size': {
      // Write/Edit のたびに走る。**最後に編集した時刻**を印のファイルに残す。
      // stop がこれと state.md の mtime を比べて「記録が作業に追いついているか」を見る。
      const p = j.tool_input?.file_path || '';
      // **`.agent/` の中は「作業」ではなく「記録」。** ここで印を進めると、
      // state.md を書いたあとに journal を書き足しただけで「記録が遅れている」と
      // 誤検知する (実際に踏んだ)。引き継ぎ → 経緯 → commit の順に書けなくなる。
      if (!isNotes(root, p)) {
        fs.writeFileSync(editMark, '');
        return ok();
      }
      if (!p.endsWith(path.join('.agent', 'state.md'))) return ok();
      const max = cfg.state?.max_lines ?? 150;
      const lines = readOr(statePath).split('\n');
      if (lines.length <= max) return ok();
      // **「あと何行」と「どこが太っているか」を事実として渡す。**
      // 超過行数を自分で引き算させると 1〜2 行ずつ削り、そのたびにここで止まる
      // (実際に 5 回連続で止まった)。1 回で削り切れる形にするのがこの hook の仕事。
      const fat = fatSections(lines);
      return block(
        `.agent/state.md が ${lines.length} 行。上限 ${max} 行まで **あと ${lines.length - max} 行**削ってください。\n` +
          (fat ? `長いのは: ${fat}\n` : '') +
          `古い経緯は .agent/journal/ へ、定着した知識は docs/ へ。` +
          `**1 回で削り切ること** —— 刻んで削ると、そのたびにここで止まります。`,
      );
    }
  }
  ok();
});

/** `## ` の節ごとの行数を数えて、長い順に 3 つ返す。削る場所を探させないため。 */
function fatSections(lines) {
  const secs = [];
  for (const l of lines) {
    const m = l.match(/^##+\s+(.+?)\s*$/);
    if (m) secs.push({ name: m[1], n: 0 });
    else if (secs.length) secs[secs.length - 1].n++;
  }
  return secs
    .sort((a, b) => b.n - a.n)
    .slice(0, 3)
    .map((s) => `${s.name} (${s.n} 行)`)
    .join(' / ');
}

/** `.agent/` の下か。引き継ぎ (state.md) と経緯 (journal/) がここに入る。 */
const isNotes = (root, p) => {
  if (!p) return false;
  const rel = path.relative(root, p);
  return rel !== '' && !rel.startsWith('..') && rel.split(path.sep)[0] === '.agent';
};

const mtimeOf = (p) => {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
};

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
