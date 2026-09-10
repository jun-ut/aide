import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scan } from '../src/cmd/stats.mjs';

// 「再読込」列が何を数えているかの回帰テスト。
// ここを間違えると read-dedup を有効にするほど数字が増え、効果が消えて見える。

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aide-stats-')));
const file = path.join(dir, 's.jsonl');

let id = 0;
const lines = [];
/** Read の呼び出しと結果を 1 往復ぶん書く。 */
const readCall = (fp, { offset, limit, error } = {}) => {
  const tid = `t${++id}`;
  const input = { file_path: fp };
  if (offset != null) input.offset = offset;
  if (limit != null) input.limit = limit;
  lines.push(JSON.stringify({ message: { content: [{ type: 'tool_use', id: tid, name: 'Read', input }] } }));
  lines.push(
    JSON.stringify({
      message: {
        content: [{ type: 'tool_result', tool_use_id: tid, content: 'x'.repeat(100), ...(error ? { is_error: true } : {}) }],
      },
    }),
  );
};

readCall('/a.mjs'); // 1 回目: 数える
readCall('/a.mjs'); // 通ってしまった再読込: 数える → dup 1
readCall('/a.mjs', { error: true }); // read-dedup が止めた分: 数えない
readCall('/a.mjs', { offset: 10, limit: 5 }); // 範囲読み: 数えない
readCall('/b.mjs'); // 別ファイルの初回: dup にならない
readCall('/b.mjs', { limit: 20 }); // 範囲読み: 数えない

fs.writeFileSync(file, lines.join('\n'));
const s = scan(file);

let bad = 0;
const t = (label, got, want) => {
  const okc = got === want;
  if (!okc) bad++;
  console.log(`${okc ? 'ok  ' : 'NG  '}${label}  (got ${got}, want ${want})`);
};

t('通った全文の再読込だけを数える', s.dupReads, 1);
t('止めた Read は再読込に数えない', s.reads.get('/a.mjs').n, 2);
t('範囲読みは再読込に数えない', s.reads.get('/b.mjs').n, 1);
t('tool_result の総量は止めた分も含めて数える', s.tools.Read.n, 6);

fs.rmSync(dir, { recursive: true, force: true });
console.log(bad ? `\n${bad} 件 NG` : '\n全件 ok');
process.exit(bad ? 1 : 0);
