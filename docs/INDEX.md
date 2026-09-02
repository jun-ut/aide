# docs 目次

必要になったものだけ読む。全部読まない。

## decisions (ADR — Why / Why not と踏んだ罠)

- [0001-context-economics](decisions/0001-context-economics.md) — 加重コストの実測 (cacheRead 62%)。clear の閾値が 250k である理由。tool_result 内訳は 0002 で訂正済み
- [0002-roadmap](decisions/0002-roadmap.md) — 訂正 (Read 79% は文字数の錯覚)。Bash の集中度測定。一部 superseded
- [0003-what-actually-accumulates](decisions/0003-what-actually-accumulates.md) — thinking は蓄積しないので放置してよい。/clear 方針（自動圧縮を使わない）。数値は 0004 で訂正
- [0004-edit-payload-and-ast](decisions/0004-edit-payload-and-ast.md) — **最新の確定値**。tool_result 49% / Write 19% / Edit 15% / thinking 8%。Edit payload は圧縮不可能で symbol ベース手法をやらない判断。1ターン = 34,759 加重tok

## domain

（未着手）

## guides

- [setup](guides/setup.md) — agent CLI と hook の導入手順

---

## このディレクトリの規約

- **1 ファイル 200 行以内。** 超えたら分割するか、古い部分を削る。
- ADR は**削除しない**。古くなったら `Status: superseded by ADR-00XX` に書き換える。
  罠の知識は「なぜそう決めたか」と一体で残るので、この形が一番失われにくい。
- 新しいファイルを作ったら**必ずこの目次に 1 行足す**。目次に無いファイルは存在しないものとして扱う。
- 作業経緯は docs ではなく `.agent/journal/` へ。docs に入れていいのは「次のセッションでも真であること」だけ。
