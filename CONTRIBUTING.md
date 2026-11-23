# 贡献规则 / Contributing

规则与形状都来自引擎 [scholar-meta](https://github.com/sairaisaika/scholar-meta-visulization)；设计与计划在它的共享 Wiki 里（入口见 [AGENTS.md](AGENTS.md)）。

## 三种贡献，三条路

| 你想做什么 | 怎么做 | 计不计票 |
|---|---|---|
| 给一篇论文打标签、说它是什么研究、抄一行数字、认可或不认可别人的 | 用[标注页面](https://sairaisaika.github.io/scholar-meta-tags/)生成 issue 提交 | 计，按你的 GitHub 账号 |
| 提交一个模型给一批论文打的标签 | 开 PR，在 `imports/` 加贡献包（格式见 [imports/README.md](imports/README.md)） | 不计，目前只作质量评估的对象 |
| 改词表、裁决参数、脚本或页面 | 开 PR | — |

不要手改 `data/assertions/`：账本只追加，旧行被改或被删会被 `check` 拦下。改主意就再提交一条。

## 提交之前

```bash
pnpm install
pnpm typecheck && pnpm test && pnpm check
pnpm export && pnpm check --export export/v1
pnpm site:test        # 改了页面时
```

## 边界

- 不重写引擎已有的归一、裁决、校验与导出形状；引擎缺东西就先改引擎。
- 不存摘要、原文段落、邮箱；账号只存 `gh:<数字 id>` 与登录名快照。
- 不写任何接了引擎的站点的名字、域名或内部细节。
- 提交用 GitHub 提供的 noreply 邮箱，避免把个人邮箱留在公开历史里。

---

Three ways in: annotate through the page (counts, by GitHub account); submit a model's tags as a contribution package under `imports/`
by pull request (never counts); or change vocabularies, policy, scripts or the page by pull request. Never hand-edit `data/assertions/`:
the ledger is append-only and the `check` workflow rejects rewritten or removed lines.
