# 标准答案 / Reference labels

这里放**人标的标准答案**，用来回答「模型打的标签准不准」。现在还是空的——没有标准答案时，质量表如实显示「没有」，不显示 0。

一个 `.jsonl` 文件，一行一篇：

```json
{"work_id":"doi:10.1016/j.jad.2020.01.001","tags":["ADHD","Methylphenidate"],"design":"rct","by":"gh:12345","at":"2026-11-23T00:00:00Z","note":"read the full text"}
```

- `work_id`：`doi:` / `openalex:` / `pmid:` 开头的作品键。
- `tags`：这篇**应该有**的标签，词表里有的概念用 `vocab/tags.json` 里的显示名写——评估按规范化后的标签键逐个比，不认同义词，写成别的说法会同时记一次漏给和一次多给。写空数组 `[]` 表示「看过了，这些标签都不该有」——这篇上的任何模型建议都算多给的。没列进来的作品不参与评估。
- `design`：可选，研究设计，取值是引擎词表里的（与 `vocab/facets.json` 的 design 相同）。
- `by`：标注人的 GitHub 数字 id（`gh:<数字>`），不写登录名、不写邮箱。
- `at`：标注时间。同一篇出现多行时，最新一行生效（改主意就追加一行，不改旧行）。

怎么用：`pnpm evaluate` 打印各模型的精确率、召回率与 F1，以及**社区裁决的结果**对这份标准答案的同一套指标（裁决为「成立」的标签当作预测；研究设计比裁决出来的值）；导出时同样的结果写进 `export/v1/quality.json`（后者在 `consensus` 一节）。社区还没有裁决的作品不算「社区说它没有标签」。

标准答案只能由人标：不要用模型的输出、也不要让自动化脚本代写。模型读名片后标的参考标注放在 `data/model-reference/`，分开存、分开评；这里的 `by` 必须是 `gh:<数字>`，结构闸会拦住别的。

如实说明：这些数只表示「与这份标准答案有多一致」。标准答案由维护者经 PR 加入；标多少篇、覆盖哪些主题才够有代表性，是维护者的判断，不是算法能保证的。

---

Human reference labels for evaluating model suggestions; currently empty, in which case the quality table says so instead of showing zero.
One JSON object per line: `work_id`, `tags` (use the display names in `vocab/tags.json` for concepts the vocabulary has — synonyms are not matched; an empty array means "none of them apply"), optional `design`, `by` (`gh:<numeric id>`), `at`.
The latest line per work wins. Run `pnpm evaluate`; the same result is published as `quality.json` next to the export, including `consensus` (community decisions against the same reference labels). Reference labels must be written by people.
