# 模型参考标注 / Model comparison labels (not human)

这里放的**不是标准答案**，也**不是人标的**。是一个语言模型读了作品的名片（标题、关键词、主题词——没有摘要、没有全文）之后，
从 `vocab/tags.json` 的受控词表里挑的标签，用来在还没有人标的标准答案时，先看一眼打标签器「大概在哪里和另一个读者不一样」。

怎么读这些数：`pnpm evaluate` 与 `quality.json` 的 `model_reference` 一节，把这里的标签当参考，算账本里各模型的建议与它有多一致。
用的是与标准答案相同的算法，所以也有精确率、召回率、F1 三个数——但它们量的是**两个模型的一致程度，不是准确率**（`quality.json` 里这一节的键名是 `agreement`、`pairs.both / model_only / reference_only`，不用 gold、tp 之类的字眼）：

- 参考标注者自己会错；它和打标签器读的是同一份名片，会犯同一类错；
- 它只用词表里的标签，词表之外该有的标签在这里看不出来；
- 它没有被任何人核对过。

真正的质量数字只能来自人标的标准答案（`data/gold/`，`by` 是 `gh:<数字>`）。两边分开存、分开评、互不混入：
结构闸要求这里的 `by` 是 `model:<id>`、标签在受控词表里，`data/gold/` 里的 `by` 是 `gh:<数字>`；读取时也各只认自己那一种。

一个 `.jsonl` 文件，一行一篇：

```json
{"work_id":"doi:10.1016/j.jad.2020.01.001","tags":["ADHD","Methylphenidate"],"by":"model:llm-reader","at":"2026-11-24T02:00:00Z","note":"read the card only"}
```

同一个标注者对同一篇出现多行时，最新一行生效。只标标签，不标研究设计。

`llm-reader.jsonl`：80 篇。怎么来的（哪些能从仓里核对、哪些不能，分开写）：

- 选哪 80 篇可以核对：把有名片的作品按 `sha256(作品键)` 排序，取第 61–140 篇（前 60 篇留给人标，不重叠）。
- 标的过程无从由仓里核对：标注者是一个语言模型助手，只看了这 80 篇的名片字段，标的时候没有看任何打标签器的建议；没有记录提示词与模型版本。
- 事后做过一次抽查：另一个独立的模型读者对其中 20 篇盲标，与这里的一致程度是 F1 93%（20 篇里 11 篇完全相同）——这仍然是两个模型之间的一致，不是人核对。

---

These are **not** human-labelled and **not** the reference labels used to measure quality: a language model read each work's card (title, keywords, index terms; no abstract, no full text) and picked tags from the controlled vocabulary.
`pnpm evaluate` and the `model_reference` section of `quality.json` report how far each tagging model agrees with them — agreement between two models, not accuracy.
Human reference labels live in `data/gold/` (`by` is `gh:<numeric id>`); here `by` must be `model:<id>`. The two are stored, loaded and scored separately.
