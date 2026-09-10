# 引き継ぎ

このファイルは**常に全文を上書き**する。追記しない。上限 150 行 (hook が強制)。
経緯は `.agent/journal/` へ、定着した知識は `docs/` へ回す。

## 今の目標

AIDE の実測フェーズ。実装は一巡したので、実プロジェクトで使って効果を数値化する。
sightline での実運用で出た課題は一通り潰した。**Windows 実機検証は 2026-09-07 に完了。**
**再起動後の hook 発火も 2026-09-07 に確認済み。** 次は実測の継続。

## 直近やったこと (5行以内)

- **2026-09-10 分岐していた 2 枝を合流させた** (`c53b885`)。衝突は journal の 1 か所
  (両側が別日付の節を追記) だけ。**コードは自動マージが通ったうえで壊れた**:
  origin 側の「実在して小さい `cat` は測れているので止めない」判定が cwd 起点で
  statSync するのに、guard-bash のテストが cwd をリテラル `/home/jun/project/aide` で
  渡しており Windows で全部 deny に落ちた。cwd も `import.meta.url` 起点へ。11/11 PASS
- **2026-09-07 実測の計測器を用意した。** read-dedup が deny と bypass を
  `.agent/run/<sid>.denies.json` に残す → `agent stats` の「拒否(誤)」列。
  同時に `再読込` 列が **deny された Read と範囲読みまで数えていた**のを修正
  (hook を有効にするほど数字が増え、効果が消えて見える状態だった)。
  test は 9 → 11 本 (`read-dedup` / `stats-reads` を新規追加)
- **2026-09-07 Windows 11 実機で検証完了。** `agent test` が 9/9 PASS。詰まった順に:
  テストの hook パスがリテラル `/home/jun/...` → Windows でカレントドライブ相対に解決され
  全滅 / go パーサ誤検出が失敗 6 件を隠していた / transcript slug が `:` を潰さず
  `agent stats` が黙って空 / `init` が JSON.stringify で囲み `\\` が化ける
- **node が PATH に無いのが最大の落とし穴。** hook と statusline だけが静かに死ぬ
  (`agent` は手で叩けるので動いて見える)。mise shims をユーザ PATH に追加して解決

- **確定した加重内訳** ([ADR-0004](../docs/decisions/0004-edit-payload-and-ast.md)):
  tool_result 49.1% / Write 18.6% / Edit 14.8% / thinking 7.9% / Bash 5.6% / 可視テキスト 2.4%。
  **1 往復 = 34,759 加重トークン** (平均 ctx 347k)。トークン削減より往復削減が効く
- 2026-09-03 `../sightline` に導入。**本体はコピーせず絶対パス参照**。`node:test` パーサと
  cargo 複数集計行の合算を追加。guard-bash に **WRITE ルール**新設 + find 誤爆修正
- stop の催促を**「最後の編集より後に state.md が書かれたか」**基準に直した (mtime 比較)
- status_command を実運用して 3 件修正 → `agent last` 追加 / 途中出力を捨てない /
  行数上限。sightline の `bin/status` が **5.7s → 0.56s**
- **Windows ネイティブ対応**: guard-bash が PowerShell を見る / `shellFor()` /
  `agent init` / `bin/agent.cmd`。テスト 88 → 140 ケース
- 2026-09-10 sightline の実作業で出た**往復の無駄 3 件**を潰した: cargo の panic
  本文が要約から落ちる (5 往復/セッション) / 測れる `cat` を止めていた / 150 行 hook
  が刻ませる。**どれも「設計どおり動いた結果」**で、実測しないと出ない類

## 次の TODO

- [x] ~~Claude Code 再起動後に hook が本当に発火するか~~ → **全系統 OK** (2026-09-07)。
      SessionStart (`.agent/run/<sid>.json` + state.md 注入) / PreToolUse guard は
      Bash・PowerShell 両ツールで deny (PowerShell には `$env:AGENT_RAW='1';` を案内) /
      statusline は `ctx 47k · cache 60m` を表示。node は mise shims で PATH 上
- [ ] `agent test` の「9 passed」は node:test 自身の粒度 (`ℹ tests 9` = テストファイル 9 本)。
      中の 141 アサーションは各ファイルが自前で `ok ` を print しているだけ。
      **パーサの取りこぼしではない** (前回の go 誤検出と混同しないこと)
- [ ] AIDE 自身に `commands.lint` が無い (`agent lint` が NO_COMMAND のまま)
- [ ] **read-dedup の誤検知率を 1 セッションぶん貯める (実測の本命)。** 計測器は用意済み:
      `agent stats` の「拒否(誤)」= deny 件数(逃げ道を使われた件数)。
      **逃げ道 `AGENT_NO_DEDUP=1` を使った = 止めたのが誤りだったと確定した**、が分子。
      逃げ道を使わず諦めた分は数えられないので**下限値**。高ければ deny → warn に後退。
      判断材料が要るときは `.agent/run/<sid>.denies.json` にファイル名と経過分が残っている
- [ ] `agent stats` をトークン基準に直す (現状は文字数ベースで同じ錯覚を再生産する)
- [ ] Bash の呼び出し回数 1,554 件を減らす複合コマンド (tool_result の 44%)
- [ ] `agent map` — Aider 方式の定義索引。探索用 Bash の代替。**往復を増やさないことが条件**
- [ ] 常駐ベースライン 22〜31k の棚卸し (無関係な Cloudflare skill 13 個)
- [ ] `/handoff` skill (state.md 圧縮 + journal 追記 + docs 昇格の提案)

## Windows 対応の現状 (2026-09-07 実機検証済み)

**方針: clone し直して移るのではなく、AIDE 側の POSIX 依存を外す。**
1 つの clone を WSL と Windows の両方から触るのは**禁止**。9p 越しに mtime がずれ、
stop の催促が前提にしている「両辺を FS の時計に揃える」が成立しない。
両方要るなら ext4 と NTFS に別 clone を置き git remote で同期する。

Claude Code 側の事実 (docs で確認済み):
- ネイティブ Windows を正式サポート。**WSL 不要**。Git for Windows は任意だが
  入れると Bash ツールが有効になる。無いと PowerShell ツールが自動で有効
- Git Bash の場所は `env.CLAUDE_CODE_GIT_BASH_PATH` (settings.json)
- Git Bash があると PowerShell ツールが**併存**し claude.ai / Console では既定 on。
  `CLAUDE_CODE_USE_POWERSHELL_TOOL=0` で切れる (が、今は切らなくても guard が効く)
- **sandboxing はネイティブ Windows では非対応** (WSL2 のみ)

済み:
- [x] guard-bash の matcher を `Bash|PowerShell` に。PowerShell の書き込み構文も解釈
- [x] `shellFor()` / `shellPath()` — `shell: true` (= cmd.exe) をやめ Git Bash を明示
- [x] `WRITE_OK` に Windows の temp と `$null`。パスは `\` を `/` に正規化して判定
- [x] `agent init [--write]` で settings.json 生成、`bin/agent.cmd`

実機で追加で潰したもの (すべてテスト付き):
- [x] テストの `HOOK` がリテラル絶対パス。Windows では `/home/...` が `C:\home\...` に
      解決され hook が起動できず 6 件が「起動失敗」で落ちていた → `import.meta.url` 起点へ
- [x] `go test` パーサの誤検出。`go: ` が「car**go: **」に当たり、`ok  ` 始まりの行を
      自前で print する node:test の出力を go と誤判定 → **失敗 6 件が 0 failed に化けていた**。
      検出を `^ok <pkg> <秒>` / `^go: ` に絞った
- [x] transcript slug が `:` を潰していない。実測の命名は `C:\Hub\Project\aide` →
      `c--Hub-Project-aide`。`util.mjs` の `projectDir()` に集約し、ドライブ文字の大小は
      候補総当たり + 大小無視の実ディレクトリ探索で吸収
- [x] `init` が `JSON.stringify` でパスを囲んでいた → `node "C:\\Hub\\..."` と二重の `\` に
      化ける。素の引用符に変更 (settings.json への escape は書き出し側がやる)
- [x] `delegate` は Git Bash が無い Windows で実行を拒む (POSIX 引用符が壊れるため)
- [x] `.gitattributes` で `bin/agent` を `eol=lf` に固定 (CRLF だと POSIX 側で shebang が死ぬ)

残り:
- [ ] **`node` を PATH に載せること自体が最大の落とし穴。** mise/nvm だと hook と
      statusline だけが静かに死ぬ。`agent` は手で叩けるので気づけない
- [ ] checked-in の `.claude/settings.json` を `agent init --write --force` で絶対パス化した。
      **この clone は Windows 専用になった。** WSL 側の clone では init し直すこと
- [ ] sightline の `bin/status` は bash。Git Bash 前提のまま許す (無ければ status が
      出ないだけで、途中出力を捨てない修正のおかげで起動は壊れない)

## 対象外と決めたもの（蒸し返さない）

- **thinking: high はそのまま。** 加重 7.9% だが蓄積せず 5x。切ると性能を失うだけ
- **可視テキスト（説明文）の短縮。** 加重 2.4%。明快さを削っても得られるものがない
- **自動圧縮 (auto-compact)。** 引き継ぎがあるなら /clear の方が素直・確実・低コスト
- **symbol ベースの編集 (Serena 方式)。** 上限 3.5%、Edit ツールは差し替え不可
  ([ADR-0004](../docs/decisions/0004-edit-payload-and-ast.md))
- **`agent outline` / ファイル分割をトークン理由で進めること。** read:edit が 0.66x
- **SessionStart で検証コマンドを走らせること。** 開始をブロックし、タイムアウトで
  不完全になり、結果はどのみち最初の編集で嘘になる。記録を読む (`agent last`)
- **WSL から Windows へ clone し直して移ること。** 上の「方針」を参照

## 未解決 / 判断待ち

- read-dedup の誤検知率が未測定。自動圧縮で消えた内容を mtime だけでは見分けられない
- thinking 84% は残差による推定値。本文が transcript に無いため直接検証できない
- 画像 1,500 tok/枚は仮定。実解像度から `幅×高さ/750` で数え直す余地あり
- guard-bash の UNBOUNDED ルールは 5 件で様子見。PowerShell 側は 2 件で開始
- `status_command` は checked-in の config から任意コマンドを SessionStart で実行する。
  自分のリポジトリなら問題ないが、性質として残しておく

## 触っているファイル

`bin/{agent,agent.cmd}`, `src/{util,parsers,session}.mjs`,
`src/cmd/{check,init,last,stats,delegate}.mjs`,
`hooks/{statusline,read-dedup,guard-bash,session}.mjs`,
`test/{guard-bash,guard-write,guard-powershell,parsers,session-stop,last,status-inject,shell,init,read-dedup,stats-reads}.test.mjs`

## 最重要の一行

**蓄積するトークンの実効単価は 133x、thinking は 5x。削るべきは思考でも説明でもなく、
コンテキストに残るもの（tool_result と Edit/Write の payload）だけ。**
そして 133x を断ち切れるのは `/clear` だけなので、`.agent/state.md` の役割は clear を安くすること。
