import { withArgs } from '../src/cmd/check.mjs';

let bad = 0;
const t = (label, got, want) => {
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'NG  '}withArgs: ${label}`);
  if (!ok) console.log(`      got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
};

// フラグ無しは素通し
t('フラグ無しはそのまま', withArgs('cargo test', ''), 'cargo test');
t('連結でもフラグ無しならそのまま', withArgs('a && b', ''), 'a && b');

// **フラグが無くても {} は必ず消す。** 残すと `cargo test {}` が「{} という名前の
// テストだけ実行」になり、**0 件実行して PASS** で返る(実際に踏んだ)。
t('フラグ無しでも {} は消える', withArgs('cargo test {}', ''), 'cargo test');
t(
  'フラグ無しの連結でも全部の {} が消える',
  withArgs('cargo test {} && cd apps/gui && cargo test {}', ''),
  'cargo test && cd apps/gui && cargo test',
);
t('{} を消しても後続の引数は残る', withArgs('cargo test {} --locked', ''), 'cargo test --locked');

// 単一コマンドは従来どおり末尾へ
t('単一コマンドは末尾連結', withArgs('cargo build', '--release'), 'cargo build --release');

// **連結コマンドへの末尾連結は最後の 1 本にしか効かない。**
// 実例: `cargo test && cd apps/melqi/src-tauri && cargo test` に --workspace を渡すと
// GUI 側にだけ付き、要約は両方 434 passed で一致するので差に気づけなかった。
// 推測せず null を返し、呼び手が止める。
t(
  '連結コマンドは null(黙って末尾に付けない)',
  withArgs('cargo test && cd apps/gui && cargo test', '--workspace'),
  null,
);
t('パイプも同じ', withArgs('cargo test | tail -20', '--release'), null);
t('セミコロンも同じ', withArgs('a; b', '-x'), null);

// {} があれば位置は書き手が決めている。**全部に入れる**
t(
  '{} は複数あっても全部埋める',
  withArgs('cargo test {} && cd apps/gui && cargo test {}', '--workspace'),
  'cargo test --workspace && cd apps/gui && cargo test --workspace',
);
t('{} は単一コマンドでも使える', withArgs('cargo build {} --locked', '--release'), 'cargo build --release --locked');

console.log(bad ? `\n${bad} 件 NG` : '\n全件 ok');
process.exit(bad ? 1 : 0);
