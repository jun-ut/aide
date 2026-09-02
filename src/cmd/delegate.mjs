import fs from 'node:fs';
import path from 'node:path';
import { emit, fmt, runCapture, spill, stripAnsi } from '../util.mjs';

/**
 * agent delegate — 安いモデル(opencode)へ丸投げする。
 *
 * Claude のレート制限を一切消費せず、コンテキストには要約結果だけが乗る。
 * サブエージェントより厳密に安い。ただし品質は落ちるので、
 * 「機械的」「検証可能」なタスクに限ること。
 *
 *   agent delegate "src/ 配下で foo を使っている箇所を全部列挙"        # 読み取り専用
 *   agent delegate --write "全 *.test.ts の import を vitest に統一"   # 編集あり
 *   agent delegate -m qwen3.8-flash --timeout 300 "..."
 */
export default function delegate(argv, cfg) {
  const root = cfg.__root;
  const flag = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
  const write = argv.includes('--write');
  const model = flag('-m', flag('--model', cfg.delegate?.model));
  const provider = flag('--provider', cfg.delegate?.provider);
  const timeoutSec = Number(flag('--timeout', cfg.delegate?.timeout_sec)) || 600;
  const task = argv.filter((a, i) => !a.startsWith('-') && !isFlagValue(argv, i)).join(' ').trim();

  if (!task) {
    console.log('delegate: タスクを指定してください  例: agent delegate "..." ');
    return 2;
  }

  const guard = write
    ? 'You may edit files. Make the minimal change. Do not run destructive commands. Do not commit.'
    : 'READ-ONLY. Do not create, edit, or delete any file. Only investigate and report.';
  const prompt = `${guard}\nAnswer concisely: at most 20 lines. Cite file:line for every claim.\n\nTASK: ${task}`;

  const before = write ? gitSnapshot(root) : null;
  const cmd = `opencode run -m ${shq(`${provider}/${model}`)} --format default ${shq(prompt)}`;
  const r = runCapture(cmd, { cwd: root, timeoutSec });
  const id = spill(root, 'delegate', `$ ${cmd}\n\n${r.out}`);

  // opencode のバナー/進捗行を落として最終回答だけ残す
  const body = stripAnsi(r.out)
    .split('\n')
    .filter((l) => l.trim() && !/^[>│┌└●⠀▄█▀]/.test(l.trim()) && !/^(build|plan)\s+·/.test(l.trim()))
    .join('\n')
    .trim();

  const L = [`delegate ${r.code === 0 ? 'OK' : 'FAIL'}  ${provider}/${model}  ${fmt.dur(r.ms)}${write ? '  [write]' : '  [read-only]'}`];
  L.push(...body.split('\n'));
  if (write) {
    const diff = gitSnapshot(root);
    L.push(diff && diff !== before ? `--- 変更 ---\n${diff}` : '--- 変更なし ---');
  }
  L.push(`log ${id}`);
  console.log(emit(L, (cfg.limits?.max_lines ?? 40) + 10));
  return r.code;
}

function isFlagValue(argv, i) {
  const p = argv[i - 1];
  return ['-m', '--model', '--provider', '--timeout'].includes(p);
}

function gitSnapshot(root) {
  if (!fs.existsSync(path.join(root, '.git'))) return null;
  const r = runCapture('git diff --stat', { cwd: root, timeoutSec: 20 });
  return r.code === 0 ? r.out.trim() : null;
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
