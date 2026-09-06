# 引き継ぎ

このファイルは**常に全文を上書き**する。追記しない。上限 150 行 (hook が強制)。
経緯は `.agent/journal/` へ、定着した知識は `docs/` へ回す。

## 今の目標

AIDE の実測フェーズ。実装は一巡したので、実プロジェクトで使って効果を数値化する。
sightline での実運用で出た課題は一通り潰した。**次は Windows 実機での検証。**

## 直近やったこと (5行以内)

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

## 次の TODO

- [ ] **Windows 実機で検証する (最優先)。** コードは書いたが**一度も Windows で動かしていない**。
      確認する順に: `agent init --write` → `agent test` (グロブ展開) → guard-bash の
      PowerShell 経路 → `agent stats` の transcript slug
- [ ] **`go test` パーサの検出条件 `/_test\.go|go: /` が緩い。** `go: ` が「car**go: **」に
      当たるため、AIDE 自身の `agent test` が `140 passed [go test]` と誤判定する
      (真値は node:test の 8 passed)。`^ok\s+\S+` 等に絞るか、判定順を見直す
- [ ] AIDE 自身に `commands.lint` が無い (`agent lint` が NO_COMMAND のまま)
- [ ] read-dedup を 1 セッション有効にして誤検知率を測る (多ければ deny → warn に後退)
- [ ] `agent stats` をトークン基準に直す (現状は文字数ベースで同じ錯覚を再生産する)
- [ ] Bash の呼び出し回数 1,554 件を減らす複合コマンド (tool_result の 44%)
- [ ] `agent map` — Aider 方式の定義索引。探索用 Bash の代替。**往復を増やさないことが条件**
- [ ] 常駐ベースライン 22〜31k の棚卸し (無関係な Cloudflare skill 13 個)
- [ ] `/handoff` skill (state.md 圧縮 + journal 追記 + docs 昇格の提案)

## Windows 対応の現状 (2026-09-07)

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

残り:
- [ ] **実機検証** (上の TODO 最優先)
- [ ] `src/cmd/delegate.mjs` の `shq()` は POSIX の引用符 escape。Git Bash 経由なら
      正しいが、cmd.exe に落ちた場合は壊れる
- [ ] `agent stats` の transcript slug (`path.resolve(cwd).replace(/[/\\.]/g,'-')`) が
      Windows で Claude Code の実際の命名と一致するか未確認 (`C:` のコロンを見ていない)
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
`test/{guard-bash,guard-write,guard-powershell,parsers,session-stop,last,status-inject,shell,init}.test.mjs`

## 最重要の一行

**蓄積するトークンの実効単価は 133x、thinking は 5x。削るべきは思考でも説明でもなく、
コンテキストに残るもの（tool_result と Edit/Write の payload）だけ。**
そして 133x を断ち切れるのは `/clear` だけなので、`.agent/state.md` の役割は clear を安くすること。
