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

- **模型层永不计票。** 这些标签目前只作质量评估的对象（`quality.json`）；它们不进导出分片，页面上还不显示（页面上的模型建议来自名片的主题与关键词）。要计票的标注只能经 issue、按 GitHub 账号进来。
- `tagger.id` 只用小写字母、数字、`.`、`_`、`-`（最长 64），不能与仓里样本脚本用的模型 id 相同；`version` 必填，不含控制字符。
- 文件名只用字母、数字、`.`、`_`、`-`，以 `.json` 结尾。
- 作品键用 `doi:` / `openalex:` / `pmid:`；DOI 链接会被认成 `doi:`。
- 置信度低于 `config/smt.config.json` 里 `model_min_confidence` 的建议被丢弃；`confidence: null` 表示模型没给，不因门槛被丢。
- 每包最多 5000 篇、每篇最多 20 个标签；更多就拆成几个文件。
- 幂等：同一个模型对同一篇的同一个标签只记一条，重复提交、换版本重报、换大小写写法重报都不会多写。
- 整包不成形（不是 JSON、没有合法的模型 id 与版本）整包拒绝；个别条目坏的逐条报告，其余照常入库。
- 不要放摘要、原文段落、邮箱或任何个人信息。

流程：开 PR 加文件 → `check` 工作流用 `pnpm bulk --dry-run` 验形 → 维护者合并 → `import` 工作流写入 `data/assertions/`、给没有名片的作品补名片、重新导出。
本地先验：`pnpm bulk --dry-run`。

---

Bulk entry point: one model's tags for a batch of papers as an `EvidenceTagContribution` JSON file, submitted by pull request.
Model-tier assertions never vote; for now they are only the subject of quality evaluation and are not shown on the page. Validation is the engine's
`validateTagContribution`. Up to 5000 works per file and 20 tags per work. Run `pnpm bulk --dry-run` locally first.
