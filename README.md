# scholar-meta-tags（SMT）

**公开、可审计的论文标注平台：GitHub 仓库就是数据库，规则与形状来自 [scholar-meta](https://github.com/sairaisaika/scholar-meta-visulization) 引擎。**

任何人都可以来：贴一个 DOI / 链接 / 标题，看到这篇论文现在被说成什么，然后回答三个问题——它讲什么（标签）、它是什么研究（设计）、主结局偏向哪边；
愿意的话再从原文抄一行数字（效应量、区间、样本量、p 值，带出处）。别人可以认可、不认可，或者**盲复录**你抄的数字。
提交走 GitHub issue；Action 鉴权、校验、追加到 `data/`，按规则裁决，再发成一份静态导出，任何接了 scholar-meta 的站点都能装进自己的图里。

- 标注页面：https://sairaisaika.github.io/scholar-meta-tags/ （Pages 开启后可用）
- 规则与设计（共享 Wiki）：[标签模型](https://github.com/sairaisaika/scholar-meta-visulization/blob/main/docs/wiki/Tagging-model.md) · [社区标注平台](https://github.com/sairaisaika/scholar-meta-visulization/blob/main/docs/wiki/Community-annotation.md)
- 工程入口：[Engineering-entry](https://github.com/sairaisaika/scholar-meta-visulization/blob/main/docs/wiki/Engineering-entry.md)（路由 `community-annotation`）

## 它怎么裁决

| 谁 | 怎么算 |
|---|---|
| 仓库 write / maintain / admin（编辑、维护者） | 按层级：一致即生效，分歧即争议；维护者压过编辑 |
| 其他所有 GitHub 账号（贡献者） | 按**支持比例**：Wilson 区间（两侧 80%）整体高于 0.5 ⇒ 认可，整体低于 ⇒ 否决，跨门槛且两边都有人 ⇒ 争议，其余待定；至少 2 个独立账号；反对不足 2 人只算「挑战」 |
| 模型（OpenAlex 的主题 / 关键词、标题线索） | 只是建议，永不计票 |
| 数字 | 整行原子：认可必须整行盲复录，容差内一致才算一票；要有第二个人独立一致（或编辑层）才计入；没写出处最多到待定 |

参数在 [`config/smt.config.json`](config/smt.config.json)，随导出下发；算例与旋钮表见 Wiki。

## 仓库布局

```
data/assertions/<yyyy>/<mm>.jsonl   真源：断言，只追加（EvidenceAnnotation 一行一条）
data/works/<hh>.jsonl               名片快照（EvidenceWorkCard，摘要恒 null）
vocab/                              分面词表、概念词表（broader 只导航）、标签别名、编辑层绑定
config/                             裁决参数、额外角色、黑名单、冷启动种子
scripts/                            intake · export · sample · replay · check · redact（Node 20+，依赖 scholar-meta）
site/                               静态标注页（浏览器直接用 scholar-meta 的纯函数）
.github/workflows/                  intake（含 export 作业）· export · sample · replay · check
```

派生导出（`export/v1/manifest.json` + `works/<hh>.jsonl` + `frames.json` + `bindings.json` + `concepts.json` + `queues.json`）**不进 main**：随 Pages 工件发布，每日另附 Release 资产。

## 怎么接到自己的站点

不需要和本仓对接：拉导出文件、校 sha256，交给引擎——

```ts
import { readCommunityExport, createCommunityPorts, mergeWorkTagSources } from 'scholar-meta'
const parsed = readCommunityExport(manifest, shards)
const community = createCommunityPorts(parsed.value, { tagStates: 'present_only', minVerification: 'double' })
// workTags: mergeWorkTagSources([yourLedger, community.workTags]); community: community.articles
```

细节见引擎接入指南第 9 节。

## 许可与隐私

代码 MIT（[LICENSE](LICENSE)）；标注事实与书目快照 CC0 1.0（[LICENSE-DATA](LICENSE-DATA)，范围见文件）。
原文引文只留在 issue 里，摘要不落盘不导出。只存 `gh:<数字 id>` 与登录名快照，不存邮箱；公开 issue 与 git 历史里的登录名抹不掉，页面如实声明。

## 开发

```bash
pnpm install
pnpm typecheck && pnpm test && pnpm check      # 词表 / JSONL / 名片结构闸
pnpm export && pnpm check --export export/v1  # 导出并用引擎读回
pnpm site:build                               # 静态页 → site/dist
```

---

## English

A public, auditable annotation platform for research papers. The GitHub repository is the database; rules and data shapes come from the [scholar-meta](https://github.com/sairaisaika/scholar-meta-visulization) engine.
Anyone can paste a DOI, link or title, see what a paper is currently said to be, and answer three questions — what it is about (tags), what kind of study it is (design), which way its primary outcome points — and optionally transcribe one row of numbers with its location. Others endorse, dispute or blindly re-extract.
Submissions go through GitHub issues; an Action authenticates, validates, appends to `data/`, decides by the rules (tiers for editors, a Wilson-interval share-of-support rule for everyone else, blind re-extraction for numbers) and publishes a static export that any site running scholar-meta can load through `readCommunityExport` / `createCommunityPorts`.
Code is MIT; annotation facts and bibliographic snapshots are CC0 1.0 (see LICENSE-DATA for scope).
