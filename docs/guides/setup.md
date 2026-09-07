# setup — agent CLI と hook の導入

## 1. PATH を通す

```sh
chmod +x bin/agent
export PATH="$PWD/bin:$PATH"        # 恒久化するなら ~/.zshrc へ
```

他プロジェクトでも使う場合は symlink:

```sh
ln -sf "$PWD/bin/agent" ~/.local/bin/agent
```

## 2. 対象プロジェクトに `.agent/` を置く

`agent` は「`.agent/` を持つ最も近い祖先」をルートとみなす。

```sh
mkdir -p .agent/journal .agent/run
cp /path/to/aide/.agent/config.yml .agent/
```

`config.yml` は空でもよい。`package.json` / `pyproject.toml` / `go.mod` / `Cargo.toml` から
`test` / `lint` / `build` / `typecheck` を自動検出する。自動検出を上書きしたいときだけ書く。

## 3. hook と statusline を有効にする

`.claude/settings.json` を対象プロジェクトにコピーする。`$CLAUDE_PROJECT_DIR` は
Claude Code がプロジェクトルートに展開する。AIDE 本体を別の場所に置いた場合は絶対パスに直す。

**確認:**

```sh
echo '{"tool_input":{"command":"pnpm test"}}' | node hooks/guard-bash.mjs
echo '{"transcript_path":"","workspace":{"current_dir":"'$PWD'"}}' | node hooks/statusline.mjs
```

## 4. node の解決に注意

hook は非対話シェルで実行される。mise/nvm を使っている場合、`node` が PATH に無いことがある。
その場合は `settings.json` の `command` を絶対パスにする:

```sh
command -v node   # → /home/you/.local/share/mise/installs/node/24/bin/node
```

> 既存のグローバル設定に Windows パス (`C:\Users\...`) を指す hook が残っていると、
> WSL 側では静かに失敗する。`~/.claude/settings.json` を確認すること。

## 4.5 Windows (ネイティブ) の場合

WSL は不要。Claude Code はネイティブ Windows を正式サポートする。手順は上と同じだが、
**踏む順に** 次の 4 点だけ違う (2026-09-07 実機で確認済み)。

1. **`node` を PATH に載せる。** ここが最初に効く。mise / nvm-windows を使っていると
   `node` はユーザ PATH に無く、**hook と statusline が黙って起動しない**
   (`agent` は自分で叩けるので動いているように見える)。発火しているかは
   `.agent/run/<session_id>.json` ができるかで判る。

   ```powershell
   [Environment]::SetEnvironmentVariable('PATH', "$env:LOCALAPPDATA\mise\shims;" + [Environment]::GetEnvironmentVariable('PATH','User'), 'User')
   ```

   PATH を変えたら **Claude Code を再起動する**。hook のコマンドは起動時に解決される。

2. **`settings.json` は `agent init --write` で生成する。** checked-in の
   `$CLAUDE_PROJECT_DIR` 形式は POSIX シェルの展開に依存していて、Windows のシェルでは
   展開されない。`agent init` は絶対パスで書くのでどちらでも動く。
   1 つの clone を WSL と Windows で共有しないこと ([state.md](../../.agent/state.md) の方針)。

3. **Git for Windows を入れる。** 無いと `shell: true` = cmd.exe になり、
   `node --test test/*.test.mjs` のグロブが展開されない。`agent init` が見つからなければ
   警告を出す。`agent delegate` は POSIX の引用符を使うので、この場合は実行を拒む。

4. **`agent` コマンドは `bin/agent.cmd`。** `bin` を PATH に足せば `agent test` が通る。
   symlink は要らない。

**確認 (PowerShell):**

```powershell
agent test
'{"tool_name":"PowerShell","tool_input":{"command":"Set-Content src/x.mjs -Value hi"},"cwd":"C:\\path\\to\\repo"}' | node hooks/guard-bash.mjs   # → deny
agent age    # transcript が引けているか (~/.claude/projects/<slug> の slug は `:` も `-` に潰れる)
```

## 5. 効果を測る

```sh
agent stats            # このプロジェクトの直近セッション
agent stats --all      # 全プロジェクト横断
agent age              # 今のコンテキストサイズとキャッシュ残り
```

施策の**前後**で `agent stats` を回して、加重合計と再読み込み件数が下がったかを確認する。

## 6. 委譲

```sh
agent delegate "src/ 配下で foo を使っている箇所を全部列挙"
agent delegate --write -m qwen3.8-flash "全 *.test.ts の import を vitest に統一"
```

`opencode providers list` で認証状態を確認できる。`--write` の後は必ず `agent test` と
diff で検証すること。
