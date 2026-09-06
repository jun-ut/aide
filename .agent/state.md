# 引き継ぎ

このファイルは**常に全文を上書き**する。追記しない。上限 150 行 (hook が強制)。
経緯は `.agent/journal/` へ、定着した知識は `docs/` へ回す。

## 今の目標

AIDE の実測フェーズ。実装は一巡したので、実プロジェクトで使って効果を数値化する。

## 直近やったこと (5行以内)

- `bin/agent` (test/lint/build/typecheck/log/runs/stats/age/delegate) と hook 5 種を実装、全経路動作確認
- 加重コストを実測 → cacheRead 62% / cacheWrite 29% / output 9% ([ADR-0001](../docs/decisions/0001-context-economics.md))
- **確定した加重内訳** ([ADR-0004](../docs/decisions/0004-edit-payload-and-ast.md), 測定を 3 回訂正した後の確定値):
  tool_result 49.1% / Write 18.6% / Edit 14.8% / thinking 7.9% / Bash 5.6% / 可視テキスト 2.4%
- 2026-09-03 `../sightline` に環境を導入。**本体はコピーせず絶対パス参照**で hook/CLI が正しく動くことを確認。
  ついでに AIDE 自身の `commands.test` を設定 (`node --test test/*.test.mjs`) し、`node:test` パーサを追加
- **1 往復 = 34,759 加重トークン**（平均 ctx 347k）。トークン削減より往復削減が効く
- guard-bash が 5 回誤爆 (最新: find の絶対パス誤判定) → `test/guard-bash.test.mjs` (23 ケース) で固定

## 次の TODO

- [ ] **実プロジェクト (groomaster / nyaque) で `agent test` を回し、パーサ精度を実データで確認**
- [ ] read-dedup を 1 セッション有効にして誤検知率を測る (多ければ deny → warn に後退)
- [ ] `agent stats` をトークン基準に直す (現状は文字数ベースで同じ錯覚を再生産する)
- [ ] Bash の呼び出し回数 1,554 件を減らす複合コマンド（tool_result の 44%）
- [ ] `agent map` — Aider 方式の定義索引。探索用 Bash の代替。**往復を増やさないことが条件**
- [ ] 常駐ベースライン 22〜31k の棚卸し (無関係な Cloudflare skill 13 個)
- [ ] `/handoff` skill (state.md 圧縮 + journal 追記 + docs 昇格の提案)

## 対象外と決めたもの（蒸し返さない）

- **thinking: high はそのまま。** 加重 7.9% だが蓄積せず 5x。切ると性能を失うだけ
- **可視テキスト（説明文）の短縮。** 加重 2.4%。明快さを削っても得られるものがない
- **自動圧縮 (auto-compact)。** 引き継ぎがあるなら /clear の方が素直・確実・低コスト
- **symbol ベースの編集 (Serena 方式)。** 上限 3.5%、Edit ツールは差し替え不可、
  Bash 経由の編集はグローバル方針が禁止。費用対効果が合わない ([ADR-0004](../docs/decisions/0004-edit-payload-and-ast.md))
- **`agent outline` / ファイル分割をトークン理由で進めること。** read:edit が 0.66x で
  「読みすぎ」は起きていない。設計改善は保守性の理由でやること

## 未解決 / 判断待ち

- read-dedup の誤検知率が未測定。自動圧縮で消えた内容を mtime だけでは見分けられない
- thinking 84% は残差による推定値。本文が transcript に無いため直接検証できない
- 画像 1,500 tok/枚は仮定。実解像度から `幅×高さ/750` で数え直す余地あり
- guard-bash の UNBOUNDED ルールは 5 件で様子見。増やしすぎると邪魔になる

## 触っているファイル

`bin/agent`, `src/{util,parsers,session}.mjs`, `src/cmd/{check,stats,delegate}.mjs`,
`hooks/{statusline,read-dedup,guard-bash,session}.mjs`, `test/guard-bash.test.mjs`

## 最重要の一行

**蓄積するトークンの実効単価は 133x、thinking は 5x。削るべきは思考でも説明でもなく、
コンテキストに残るもの（tool_result と Edit/Write の payload）だけ。**
そして 133x を断ち切れるのは `/clear` だけなので、`.agent/state.md` の役割は clear を安くすること。
