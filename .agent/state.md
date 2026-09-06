# 引き継ぎ

このファイルは**常に全文を上書き**する。追記しない。上限 150 行 (hook が強制)。
経緯は `.agent/journal/` へ、定着した知識は `docs/` へ回す。

## 今の目標

AIDE の実測フェーズ。実装は一巡したので、実プロジェクトで使って効果を数値化する。
いまは sightline での実運用で出た課題を潰す段。次は Windows ネイティブ対応。

## 直近やったこと (5行以内)

- **確定した加重内訳** ([ADR-0004](../docs/decisions/0004-edit-payload-and-ast.md)):
  tool_result 49.1% / Write 18.6% / Edit 14.8% / thinking 7.9% / Bash 5.6% / 可視テキスト 2.4%。
  **1 往復 = 34,759 加重トークン** (平均 ctx 347k)。トークン削減より往復削減が効く
- 2026-09-03 `../sightline` に導入。**本体はコピーせず絶対パス参照**。壊れるのは
  `settings.json` と symlink の 2 つだけ。`node:test` パーサと cargo 複数集計行の合算を追加
- guard-bash に **WRITE ルール**を新設 (`sed -i` 等が実際には素通りしていた) + find 誤爆修正
- stop の催促を**「最後の編集より後に state.md が書かれたか」**基準に直した (mtime 比較)
- **status_command を実運用して 3 件修正** → `agent last` 追加 / 途中出力を捨てない /
  行数上限。sightline の `bin/status` が 5.7s → 0.56s

## 次の TODO

- [ ] **Windows ネイティブ対応** (WSL なし・Git Bash 前提で使えるようにする)。詳細は下の節
- [ ] **`go test` パーサの検出条件 `/_test\.go|go: /` が緩い。** `go: ` が「car**go: **」に
      当たるため、AIDE 自身の `agent test` が `88 passed [go test]` と誤判定する
      (真値は node:test の 6 passed)。`^ok\s+\S+` 等に絞るか、判定順を見直す
- [ ] `session.status_command` / `status_max_lines` の設定例とドキュメントが無い
      (コード内にしか存在しない)。`.agent/config.yml` のコメントと docs/guides へ
- [ ] AIDE 自身に `commands.lint` が無い (`agent lint` が NO_COMMAND のまま)
- [ ] read-dedup を 1 セッション有効にして誤検知率を測る (多ければ deny → warn に後退)
- [ ] `agent stats` をトークン基準に直す (現状は文字数ベースで同じ錯覚を再生産する)
- [ ] Bash の呼び出し回数 1,554 件を減らす複合コマンド (tool_result の 44%)
- [ ] `agent map` — Aider 方式の定義索引。探索用 Bash の代替。**往復を増やさないことが条件**
- [ ] 常駐ベースライン 22〜31k の棚卸し (無関係な Cloudflare skill 13 個)
- [ ] `/handoff` skill (state.md 圧縮 + journal 追記 + docs 昇格の提案)

## Windows ネイティブ対応 (次にやる。調査済み・未着手)

方針: **WSL から Windows へ clone し直して移るのではなく、AIDE 側の POSIX 依存を外す。**
1 つの clone を WSL と Windows の両方から触るのは禁止 (9p 越しに mtime がずれ、
stop の催促が前提にしている「同じ時計」が壊れる)。両方要るなら ext4 と NTFS に
別 clone を置き git remote で同期する。

Claude Code 側の事実 (2026-09-07 に docs で確認):
- ネイティブ Windows を正式サポート。WSL 不要。Git for Windows は**任意だが
  入れると Bash ツールが有効になる**。無いと **PowerShell ツール**になる
- Git Bash が見つからないときは settings.json の `env.CLAUDE_CODE_GIT_BASH_PATH`
- **Git for Windows があると PowerShell ツールが Bash と併存し、claude.ai /
  Console アカウントでは既定で on。**`CLAUDE_CODE_USE_POWERSHELL_TOOL=0` で切れる
- **sandboxing はネイティブ Windows では非対応** (WSL2 のみ)

直すもの:
- [ ] **guard-bash の matcher が `Bash` だけ。PowerShell ツールが素通りする** —
      今回入れた WRITE ルールに穴が開く。matcher を足すか PowerShell ツールを切る。
      **これが最優先**(セキュリティではなく、規律が片肺になるため)
- [ ] `src/util.mjs` の `runCapture` は `shell: true` → Windows では **cmd.exe**。
      グロブ展開が無く AIDE 自身の `node --test test/*.test.mjs` が動かない。
      shell を明示指定するか、コマンドを glob 非依存にする
- [ ] `hooks/guard-bash.mjs` の `WRITE_OK` が `/tmp` `/dev` 前提
- [ ] `.claude/settings.json` の絶対パス、`~/.local/bin/agent` の symlink (`.cmd` shim)
- [ ] `bin/status` (sightline) が bash。Git Bash 前提で許すか Node へ移すか決める

## 対象外と決めたもの（蒸し返さない）

- **thinking: high はそのまま。** 加重 7.9% だが蓄積せず 5x。切ると性能を失うだけ
- **可視テキスト（説明文）の短縮。** 加重 2.4%。明快さを削っても得られるものがない
- **自動圧縮 (auto-compact)。** 引き継ぎがあるなら /clear の方が素直・確実・低コスト
- **symbol ベースの編集 (Serena 方式)。** 上限 3.5%、Edit ツールは差し替え不可、
  Bash 経由の編集はグローバル方針が禁止 ([ADR-0004](../docs/decisions/0004-edit-payload-and-ast.md))
- **`agent outline` / ファイル分割をトークン理由で進めること。** read:edit が 0.66x
- **SessionStart で検証コマンドを走らせること。** 開始をブロックし、タイムアウトで
  status ごと消え、結果はどのみち最初の編集で嘘になる。記録を鮮度つきで読む (`agent last`)

## 未解決 / 判断待ち

- read-dedup の誤検知率が未測定。自動圧縮で消えた内容を mtime だけでは見分けられない
- thinking 84% は残差による推定値。本文が transcript に無いため直接検証できない
- 画像 1,500 tok/枚は仮定。実解像度から `幅×高さ/750` で数え直す余地あり
- guard-bash の UNBOUNDED ルールは 5 件で様子見。増やしすぎると邪魔になる
- `status_command` は checked-in の config から任意コマンドを SessionStart で実行する。
  自分のリポジトリなら問題ないが、性質として残しておく

## 触っているファイル

`bin/agent`, `src/{util,parsers,session}.mjs`, `src/cmd/{check,last,stats,delegate}.mjs`,
`hooks/{statusline,read-dedup,guard-bash,session}.mjs`,
`test/{guard-bash,guard-write,parsers,session-stop,last,status-inject}.test.mjs`

## 最重要の一行

**蓄積するトークンの実効単価は 133x、thinking は 5x。削るべきは思考でも説明でもなく、
コンテキストに残るもの（tool_result と Edit/Write の payload）だけ。**
そして 133x を断ち切れるのは `/clear` だけなので、`.agent/state.md` の役割は clear を安くすること。
