# 贡献包 / Contribution packages

批量入口：一个模型（或规则）给一批论文打的标签，打成一个 `.json` 文件放在这里，经 PR 进仓。

格式就是引擎的 `EvidenceTagContribution`（用 `buildTagContribution` 生成最省事）：

```json
{
  "contract": "0.6.2",
  "tagger": { "id": "my-model", "version": "2026-11" },
  "items": [
    { "work_id": "doi:10.1016/j.jad.2020.01.001", "tags": [ { "tag": "ADHD", "confidence": 0.92 }, { "tag": "Methylphenidate", "confidence": null } ] }
  ]
}
```

规则：

- **模型层永不计票。** 这些标签不进裁决、不进导出的作品分片；它们出现在作品页的「模型建议 · 不计票」（来自导出的旁路文件 `suggestions/`）与质量评估里（`quality.json`）。要计票的标注只能经 issue、按 GitHub 账号进来。
- `tagger.id` 只用小写字母、数字、`.`、`_`、`-`（最长 64），不能与仓里样本脚本用的模型 id 相同；`version` 必填，不含控制字符。
- 文件名只用字母、数字、`.`、`_`、`-`，以 `.json` 结尾。
- 作品键用 `doi:` / `openalex:` / `pmid:`；DOI 链接会被认成 `doi:`。
- 置信度低于 `config/smt.config.json` 里 `model_min_confidence` 的建议被丢弃；`confidence: null` 表示模型没给，不因门槛被丢。
- 每包最多 5000 篇、每篇最多 20 个标签；更多就拆成几个文件。
- **这个目录里的包就是每个模型当前的回答；账本记历史。** 一条 item 是模型对一篇的完整回答。入库时拿它与账本里这个模型在这一篇上当前生效的那一组比（标签与置信度）：一样就一行不写（重复提交、换大小写写法重报、换了版本但这一篇的回答没变，都不写）；不一样就整组写进来，旧的行留在账本里不动，页面与质量评估只认最后写进来的那一组。
- 所以要改回答，就改包（或换一个包）：标签变了、置信度变了、改回从前的答案，都会生效。页面上一篇标的版本，是第一次给出现在这个回答的那个版本。包里不再提到的作品，旧的那组仍然有效（模型不能撤回）。
- **同一个模型不许有两个包回答同一篇**（同一篇用 DOI 与别的键各写一次也算）——否则两个回答会轮流生效；后一个包整包拒绝。出新版本的包时，把旧包从这个目录拿走。
- 包只放在这个目录这一层，不放子目录。
- 整包不成形（不是 JSON、没有合法的模型 id 与版本）整包拒绝，而且那次运行什么都不写、工作流失败——坏包要先拿走；个别条目坏的逐条报告，其余照常入库。
- 不要放摘要、原文段落、邮箱或任何个人信息。

流程：开 PR 加文件 → `check` 工作流用 `pnpm bulk --dry-run` 验形 → 维护者合并 → `import` 工作流先再验一遍，写入 `data/assertions/`、给没有名片的作品补名片，核只追加与导出读回，都过了才提交并重新导出。
本地先验：`pnpm bulk --dry-run`。

本仓自己的打标签器（`smt-vocabulary-*.json`）不是手写的：`pnpm tag` 用仓里的名片与 `vocab/tags.json` 生成（并换掉旧文件），`pnpm tag --check` 要求这个目录里它的文件与从仓里重算出来的那一套逐文件、逐字节相同。要改它打的标签，改词表再 `pnpm tag`，不要改包；改了词表、置信门槛或引擎版本而没有重新出包，检查不过。别的包不许用 `smt-vocabulary` 这个模型 id。

---

Bulk entry point: one model's tags for a batch of papers as an `EvidenceTagContribution` JSON file, submitted by pull request.
Model-tier assertions never vote; they are shown on the work page as "model suggestions · not counted" and are the subject of quality evaluation. The packages in this directory are each model's current answers (one item = the model's complete answer for one work); the ledger keeps history and only the last written set per model and work is current. Two packages of the same model may not answer the same work. Validation is the engine's
`validateTagContribution`. Up to 5000 works per file and 20 tags per work. Run `pnpm bulk --dry-run` locally first.
