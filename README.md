# scholar-meta-tags（SMT）

**公开、可审计的论文标注平台：GitHub 仓库就是数据库，规则与形状来自 [scholar-meta](https://github.com/sairaisaika/scholar-meta-visulization) 引擎。**

任何人都可以来：贴一个 DOI / 链接 / 标题，看到这篇论文现在被说成什么，然后回答三个问题——它讲什么（标签）、它是什么研究（设计）、主结局偏向哪边；
愿意的话再从原文抄一行数字（效应量、区间、样本量、p 值，带出处）。别人可以认可、不认可，或者**盲复录**你抄的数字。
提交走 GitHub issue；Action 鉴权、校验、追加到 `data/`，按规则裁决，再发成一份静态导出，任何接了 scholar-meta 的站点都能装进自己的图里。

- 标注页面：https://sairaisaika.github.io/scholar-meta-tags/
- 规则与设计（共享 Wiki）：[标签模型](https://github.com/sairaisaika/scholar-meta-visulization/blob/main/docs/wiki/Tagging-model.md) · [社区标注平台](https://github.com/sairaisaika/scholar-meta-visulization/blob/main/docs/wiki/Community-annotation.md)
- 工程入口：[Engineering-entry](https://github.com/sairaisaika/scholar-meta-visulization/blob/main/docs/wiki/Engineering-entry.md)（路由 `community-annotation`）· [检测基本盘](https://github.com/sairaisaika/scholar-meta-visulization/blob/main/docs/wiki/Verification-baseline.md)

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
data/assertions/<yyyy>/<mm>.jsonl   真源：断言，只追加（EvidenceAnnotation 一行一条）；一片满了（现定 2 MB）接着写 <mm>-002.jsonl
data/works/<hh>.jsonl               名片快照（EvidenceWorkCard，摘要恒 null）
data/gold/*.jsonl                   维护者标的标准答案（评估模型建议用，见 data/gold/README.md）
imports/*.json                      模型贡献包（批量入口，见 imports/README.md）
vocab/                              分面词表、概念词表（broader 只导航）、受控标签词表（tags.json：显示名与别名）、编辑层绑定
config/                             裁决参数、额外角色、黑名单、冷启动种子
scripts/                            intake · import · tag · export · evaluate · sample · replay · check · redact（Node 20+，依赖 scholar-meta）
site/                               静态标注页（浏览器直接用 scholar-meta 的纯函数）；site/test 是它的浏览器测试
.github/workflows/                  intake（含 export 作业）· import · tag · export · sample · replay · check
```

派生导出（`export/v1/manifest.json` + `works/<hh>.jsonl` + `frames.json` + `bindings.json` + `concepts.json` + `queues.json`，另有旁路文件 `ledger.json`、`quality.json`、`suggestions.json` 与 `suggestions/<hh>.jsonl`——不在引擎契约里，宿主的读取函数不读）**不进 main**：随 Pages 工件发布，每天另存一份 Release 存档（`data-<日期>`）。

多久更新一次：有人提交 issue 时入库立即触发，随后重新导出。兜底的定时任务写的是每 15 分钟入库、每小时导出，但 GitHub 对定时触发并不保证准点——实测每天各运行约 4 次。接导出的站点按「几小时内更新」来设计，不要假设整点。

## 怎么自己复核

这个仓的数据谁都能重算一遍：

1. **导出是不是由账本算出来的。** 克隆本仓，检出导出清单里的 `source_commit`，运行 `pnpm install && pnpm export`，把 `export/v1/` 与发布的文件逐个比对（`manifest.json` 里的生成时间除外）。每周的 `replay` 工作流做的就是这件事，不一致会开 issue。
2. **账本有没有被改写。** `ledger.json` 列出每个断言文件的字节数、行数与 sha256，以及总摘要；每天的 Release 存档说明里也写着当天的总摘要与断言条数。任取两天的存档：早的那份里的每个文件，都应当是晚的那份里同名文件的前缀。本仓的 `check` 工作流对每次推送都核这一条（`pnpm check --append-only <提交>`），唯一例外是记录在 `data/REDACTIONS.md` 里的抹名。
3. **裁决是不是按写明的规则。** 规则参数随导出下发（`manifest.json` 的 `policy`）；裁决函数在引擎里（`resolveAnnotations`、`assessQuorum`），可以拿同一份断言自己跑。
4. **模型建议准不准。** `quality.json` 是各模型的建议对标准答案的精确率、召回率与 F1，另有一节 `consensus`：社区裁决的结果对同一份标准答案。没有标准答案时如实为空。算法在引擎的 `scoreTagSets` 与 `scoreLabelAgreement`。
5. **模型标签是不是照词表打出来的。** `imports/` 里本仓打标签器（`smt-vocabulary`）的包，必须与从仓里的名片、`vocab/tags.json` 和配置重算出来的那一套逐文件、逐字节相同：`pnpm tag --check`。每次推送与每次入库之前都核这一条；多一篇、少一篇、改一个标签、别的文件冒用这个模型 id，都不过。

## 批量打标签

一批模型标签怎么进来（详见 `imports/README.md`）：

1. `tag` 工作流（手动触发）按 `config/seeds.json` 的主题从 OpenAlex 取名片（不存摘要），用引擎的词表打标签器在名片的标题、关键词、主题词里找 `vocab/tags.json` 的词，出一个贡献包，自检后开 PR。
2. 合并 PR 后，`import` 工作流先验形、先重算，再把包写成**模型层断言**，写完核只追加、核导出读回，都过了才提交，然后重新导出。
3. 作品页把它们列在「模型建议 · 不计票」下面：点一下只是填进输入框，由人决定要不要提交。模型层永不进裁决，也不出现在导出的作品分片里。

`imports/` 里的包是每个模型**当前**的回答，账本记历史：词表改了、引擎升了、门槛变了，重新出包再入库，变了的那些篇整组重写，同一篇上只有最后写进来的那一组生效，旧的行留在账本里不动。

## 怎么接到自己的站点

不需要和本仓对接：拉导出文件、校 sha256，交给引擎——

```ts
import { refreshCommunityExport, mergeCommunityRecords } from 'scholar-meta'
// 定时（服务端）：失败时原样交回上一份
const r = await refreshCommunityExport({ base: 'https://sairaisaika.github.io/scholar-meta-tags/export/v1', get: serverFetch, sha256, previous })
// 装配一张图时
const { community, external } = mergeCommunityRecords(r.snapshot, { tags, external: externalRecords, settings })
```

细节见引擎接入指南第 9 节。

## 许可与隐私

代码 MIT（[LICENSE](LICENSE)）；标注事实与书目快照 CC0 1.0（[LICENSE-DATA](LICENSE-DATA)，范围见文件）。
原文引文只留在 issue 里，摘要不落盘不导出。只存 `gh:<数字 id>` 与登录名快照，不存邮箱；公开 issue 与 git 历史里的登录名抹不掉，页面如实声明。

## 开发

```bash
pnpm install
pnpm typecheck && pnpm test && pnpm check      # 词表 / JSONL / 名片 / 标准答案结构闸
pnpm check --append-only origin/main          # 只追加闸：旧断言不许改、不许删
pnpm export && pnpm check --export export/v1  # 导出并用引擎读回
pnpm bulk --dry-run                         # 验 imports/ 里的贡献包（不写）
pnpm tag && pnpm tag --check                  # 用仓里的名片与词表出贡献包；核对包能逐字节重算
pnpm evaluate                                 # 各模型的建议、社区裁决的结果，各自对标准答案
pnpm site:test                                # 导出 + 构建页面 + 浏览器测试（离线）
```

---

## English

A public, auditable annotation platform for research papers. The GitHub repository is the database; rules and data shapes come from the [scholar-meta](https://github.com/sairaisaika/scholar-meta-visulization) engine.
Anyone can paste a DOI, link or title, see what a paper is currently said to be, and answer three questions — what it is about (tags), what kind of study it is (design), which way its primary outcome points — and optionally transcribe one row of numbers with its location. Others endorse, dispute or blindly re-extract.
Submissions go through GitHub issues; an Action authenticates, validates, appends to `data/`, decides by the rules (tiers for editors, a Wilson-interval share-of-support rule for everyone else, blind re-extraction for numbers) and publishes a static export that any site running scholar-meta can load through `readCommunityExport` / `createCommunityPorts`.
Code is MIT; annotation facts and bibliographic snapshots are CC0 1.0 (see LICENSE-DATA for scope).
