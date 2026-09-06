import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
export const stripAnsi = (s) => String(s ?? '').replace(ANSI, '');

/** .agent/ を持つ最も近い祖先をリポジトリルートとみなす */
export function repoRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.agent'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(start);
    dir = up;
  }
}

/**
 * 最小 YAML リーダ。対応するのは AIDE の設定スキーマだけ:
 *   - ネストしたマップ (インデント2スペース)
 *   - スカラー (クォートは任意)
 *   - "- item" 形式のフラットな配列
 * アンカー・複数行文字列・フロー記法は非対応。
 * 本格的な YAML が必要になったら `npm i yaml` してこの関数だけ差し替える。
 */
export function parseMiniYaml(text) {
  const root = {};
  const stack = [{ indent: -1, node: root }];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node;
    const body = line.trim();

    if (body.startsWith('- ')) {
      if (!Array.isArray(parent.__list)) parent.__list = [];
      parent.__list.push(scalar(body.slice(2)));
      continue;
    }
    const m = body.match(/^([^:]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2];
    if (val === '') {
      const node = {};
      parent[key] = node;
      stack.push({ indent, node });
    } else {
      parent[key] = scalar(val);
    }
  }
  return collapse(root);
}

function scalar(v) {
  const s = v.trim().replace(/^["'](.*)["']$/, '$1');
  if (/^-?\d+$/.test(s)) return Number(s);
  if (s === 'true') return true;
  if (s === 'false') return false;
  return s;
}

// "- item" だけを持つマップを配列に畳む
function collapse(node) {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    if (Array.isArray(node.__list) && Object.keys(node).length === 1) return node.__list;
    for (const k of Object.keys(node)) node[k] = collapse(node[k]);
  }
  return node;
}

const DEFAULTS = {
  limits: { max_failures: 5, max_lines: 40 },
  delegate: { provider: 'opencode-go', model: 'glm-5.3-flash', timeout_sec: 600 },
  context: { warn_tokens: 150000, clear_tokens: 250000, cache_ttl_min: 60 },
  state: { max_lines: 150 },
};

export function loadConfig(root = repoRoot()) {
  const p = path.join(root, '.agent', 'config.yml');
  let user = {};
  try {
    user = parseMiniYaml(fs.readFileSync(p, 'utf8')) || {};
  } catch {}
  const cfg = { ...DEFAULTS, ...user };
  for (const k of Object.keys(DEFAULTS)) cfg[k] = { ...DEFAULTS[k], ...(user[k] || {}) };
  cfg.commands = user.commands || {};
  cfg.__root = root;
  return cfg;
}

/** package.json / pyproject.toml などからコマンドを推測する */
export function detectCommand(target, root) {
  const has = (f) => fs.existsSync(path.join(root, f));
  const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') ? 'bun' : 'npm';
  const runner = pm === 'npm' ? 'npm run' : `${pm} run`;
  if (has('package.json')) {
    let scripts = {};
    try {
      scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts || {};
    } catch {}
    if (scripts[target]) return `${runner} ${target}`;
    if (target === 'typecheck' && scripts['tsc']) return `${runner} tsc`;
    if (target === 'typecheck' && has('tsconfig.json')) return `${pm} exec tsc --noEmit`;
  }
  if (has('pyproject.toml') || has('pytest.ini') || has('tests')) {
    if (target === 'test') return 'python -m pytest -q';
    if (target === 'lint') return 'ruff check .';
    if (target === 'typecheck') return 'mypy .';
  }
  if (has('go.mod')) {
    if (target === 'test') return 'go test ./...';
    if (target === 'build') return 'go build ./...';
    if (target === 'lint') return 'go vet ./...';
  }
  if (has('Cargo.toml')) {
    if (target === 'test') return 'cargo test';
    if (target === 'build') return 'cargo build';
    if (target === 'lint') return 'cargo clippy';
  }
  return null;
}

/**
 * どのシェルでコマンドを実行するか。
 *
 * `.agent/config.yml` の commands は POSIX sh の形で書かれている
 * (`cargo fmt --all -- --check && cargo clippy ...`, `node --test test/*.test.mjs`)。
 * Windows で `shell: true` のままにすると **cmd.exe** になり、**グロブを展開しない**ので
 * `test/*.test.mjs` がリテラルのまま渡り、AIDE 自身のテストが動かない。
 * だから Windows では Git Bash を探して明示的に渡す。
 *
 * `CLAUDE_CODE_GIT_BASH_PATH` は Claude Code が Bash ツールの場所を知るのに使う変数。
 * ユーザーが既に設定しているなら**同じ値を再利用する**のが一番ずれない。
 *
 * 見つからなければ cmd.exe に落ちる。グロブを使わないコマンドはそれでも動くので、
 * ここで止めるより動かした方がよい。落ちたことは agent init が知らせる。
 */
export function shellFor(env = process.env, platform = process.platform, exists = fs.existsSync) {
  if (platform !== 'win32') return true;
  const cands = [
    env.AGENT_SHELL,
    env.CLAUDE_CODE_GIT_BASH_PATH,
    env.ProgramFiles && `${env.ProgramFiles}\\Git\\bin\\bash.exe`,
    env['ProgramFiles(x86)'] && `${env['ProgramFiles(x86)']}\\Git\\bin\\bash.exe`,
    env.LOCALAPPDATA && `${env.LOCALAPPDATA}\\Programs\\Git\\bin\\bash.exe`,
    'C:\\Program Files\\Git\\bin\\bash.exe',
  ].filter(Boolean);
  for (const c of cands) {
    try {
      if (exists(c)) return c;
    } catch {}
  }
  return true;
}

/**
 * execSync 用。**execSync の shell は真偽値を受け付けない** (文字列か未指定のみ) ので、
 * 既定シェルでよい場合は undefined を返す。spawnSync 用の shellFor と使い分ける。
 */
export function shellPath() {
  const s = shellFor();
  return typeof s === 'string' ? s : undefined;
}

export function runCapture(cmd, opts = {}) {
  const t0 = Date.now();
  const r = spawnSync(cmd, {
    shell: shellFor(),
    cwd: opts.cwd || process.cwd(),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: (opts.timeoutSec || 1800) * 1000,
    env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', AGENT_RAW: '1' },
  });
  return {
    code: r.status ?? (r.signal ? 124 : 1),
    out: stripAnsi((r.stdout || '') + (r.stderr || '')),
    ms: Date.now() - t0,
    timedOut: r.error?.code === 'ETIMEDOUT',
  };
}

export function runDir(root) {
  const d = path.join(root, '.agent', 'run');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 全文をディスクへ退避し、参照キーを返す。「コンテキストは索引、ディスクが本体」 */
export function spill(root, target, content) {
  const d = path.join(root, '.agent', 'runs');
  fs.mkdirSync(d, { recursive: true });
  const now = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const base = `${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}-${target}`;
  let id = base;
  for (let i = 2; fs.existsSync(path.join(d, `${id}.log`)); i++) id = `${base}.${i}`;
  fs.writeFileSync(path.join(d, `${id}.log`), content);
  pruneRuns(d);
  return id;
}

function pruneRuns(dir, keep = 60) {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(keep)) fs.unlinkSync(path.join(dir, f));
  } catch {}
}

export function readJson(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

export const fmt = {
  n: (v) => Number(v).toLocaleString('en-US'),
  k: (v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)),
  dur: (ms) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`),
};

/** 出力予算の最終防衛線。どの経路でもここを通してから stdout に出す */
export function emit(lines, maxLines) {
  const arr = Array.isArray(lines) ? lines : String(lines).split('\n');
  if (arr.length <= maxLines) return arr.join('\n');
  return [...arr.slice(0, maxLines - 1), `… +${arr.length - maxLines + 1} lines (agent log <id>)`].join('\n');
}
