/**
 * agent last — 記録を「走らせずに」読む。
 * 見たいのは鮮度が必ず添うことと、記録が無いときに黙って嘘をつかないこと。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ago, lastLine } from '../src/cmd/last.mjs';

let bad = 0;
const t = (label, got, want) => {
  const ok = want instanceof RegExp ? want.test(got) : got === want;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'NG  '}${label}`);
  if (!ok) console.log(`      got ${JSON.stringify(String(got))} want ${want}`);
};

// ---- ago ----
t('ago: 秒', ago(30_000), '30秒前');
t('ago: 分', ago(20 * 60_000), '20分前');
t('ago: 時間', ago(3 * 3600_000), '3時間前');
t('ago: 日', ago(4 * 86400_000), '4日前');
t('ago: 負の値でも壊れない', ago(-5000), '0秒前');

// ---- lastLine ----
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aide-last-'));
fs.mkdirSync(path.join(root, '.agent', 'run'), { recursive: true });
const rec = (target, obj) =>
  fs.writeFileSync(path.join(root, '.agent', 'run', `last-${target}.json`), JSON.stringify(obj));

const now = Date.parse('2026-09-07T12:00:00.000Z');

rec('test', {
  code: 0,
  counts: { passed: 138, failed: 0, skipped: 4 },
  id: '0907-004459-test',
  at: '2026-09-07T09:00:00.000Z',
});
t('件数と鮮度が両方出る', lastLine('test', root, now), 'test  PASS  138 passed / 0 failed / 4 skipped  (3時間前 · 0907-004459-test の記録)');

rec('lint', { code: 1, counts: { passed: 0, failed: 0, skipped: 0 }, id: '0907-0045-lint', at: '2026-09-07T11:50:00.000Z' });
t('件数が取れなければ exit コード', lastLine('lint', root, now), /lint  FAIL  exit 1  \(10分前/);

// **記録が無いことを「PASS 0 件」に化けさせない。** 今回直したパーサの嘘と同じ穴。
t('記録が無ければそう言う', lastLine('build', root, now), 'build  記録なし (agent build で作る)');

// at が壊れていても落ちない (古い記録・手で触った記録)
rec('typecheck', { code: 0, counts: {}, id: '0101-0000-typecheck', at: 'garbage' });
t('at が壊れていても id は出す', lastLine('typecheck', root, now), /typecheck  PASS  exit 0  \(0101-0000-typecheck の記録\)/);

console.log(bad ? `\n${bad} 件 NG` : '\n全件 ok');
process.exit(bad ? 1 : 0);
