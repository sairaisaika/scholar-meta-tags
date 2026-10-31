/**
 * 冷启动书架：按 `config/seeds.json` 每主题两次列表请求（被引最高 take 篇；近两年 recent 篇），每条经引擎 `workCardOf` → `publicWorkCard`
 * 写 `data/works/`；每篇写模型层建议断言（`openalex-primary-topic`：主主题名作标签；`smt-vocab-keywords`：每个关键词一条，最多 5 条），
 * 更新 `data/sample.json`。模型断言永不计票（只作页面「建议」）。无网（fetch 失败）⇒ 打印提示、退出码 0。
 * 用法：`pnpm sample [--root <dir>]`；环境 `OPENALEX_API_KEY`（可选）。
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { normalizeTag } from 'scholar-meta'
import type { EvidenceAnnotation, EvidenceWorkCard } from 'scholar-meta'
import { createOpenAlex } from './lib/openalex.js'
import type { OpenAlex } from './lib/openalex.js'
import { REPO_ROOT, annotationId, appendJsonl, appendWork, loadAssertions, loadWorks, monthFile, paths, readJson, writeJson } from './lib/store.js'
import type { WorkSnapshot } from './lib/store.js'
import { argValue } from './export.js'

export interface Seeds { filters?: string; topics: Array<{ id: string; name: string; take: number; recent: number }> }
export const MAX_KEYWORDS = 5

/** 名片的作品键：优先 DOI，其次 OpenAlex 编号 */
export const workKeyOfCard = (c: EvidenceWorkCard): string | null => (c.doi ? `doi:${c.doi}` : c.id ? c.id : null)

/** 一张名片 → 快照 + 模型建议断言（纯函数） */
export function sampleOf(card: EvidenceWorkCard, topic: { id: string; name: string }, at: string, modelVersion: string): { snapshot: WorkSnapshot; assertions: EvidenceAnnotation[] } | null {
  const workId = workKeyOfCard(card)
  if (!workId) return null
  const aliases = [card.id, card.doi ? `doi:${card.doi}` : null, card.pmid ? `pmid:${card.pmid}` : null].filter((k): k is string => !!k && k !== workId)
  const snapshot: WorkSnapshot = { work_id: workId, aliases: [...new Set(aliases)].sort(), card: { ...card, abstract: null }, snapshot_at: at, snapshot_source: 'openalex' }
  const assertions: EvidenceAnnotation[] = []
  const suggest = (modelId: string, tag: string, note: string) => {
    const key = normalizeTag(tag)
    if (!key) return
    const base = {
      work_id: workId, kind: 'tag' as const, op: 'add' as const, subject: `tag:${key}`,
      by: { kind: 'model' as const, id: modelId, tier: 'model' as const, model_version: modelVersion },
      payload: { kind: 'tag' as const, tag }, source: { sample: topic.id, form: 'sample/1' },
    }
    assertions.push({ id: annotationId(base), at, ...base, note, supersedes: null })
  }
  const primary = card.topics[0]
  if (primary) suggest('openalex-primary-topic', primary.display_name, 'openalex.primary_topic')
  for (const k of card.keywords.slice(0, MAX_KEYWORDS)) suggest('smt-vocab-keywords', k, 'openalex.keywords')
  return { snapshot, assertions }
}

export interface SampleDeps { root?: string; openalex: OpenAlex; now?: () => Date; log?: (s: string) => void }

export async function runSample(deps: SampleDeps): Promise<{ offline: boolean; works: number; assertions: number }> {
  const root = deps.root ?? REPO_ROOT
  const log = deps.log ?? ((s: string) => console.log(s))
  const now = (deps.now ?? (() => new Date()))()
  const at = now.toISOString()
  const version = at.slice(0, 10)
  const seeds = readJson<Seeds & { _comment?: string }>(paths(root).seeds)
  const works = loadWorks(root)
  const existingIds = new Set(loadAssertions(root).assertions.map((a) => a.id))
  const sinceYear = now.getUTCFullYear() - 2
  const sample: { generated_at: string; topics: Array<{ id: string; name: string; works: string[] }> } = { generated_at: at, topics: [] }
  let added = 0
  let newAssertions = 0
  for (const topic of seeds.topics) {
    const tid = topic.id.replace(/^openalex:/, '')
    const base = `primary_topic.id:${tid}${seeds.filters ? `,${seeds.filters}` : ''}`
    const top = await deps.openalex.listCards(base, topic.take)
    if (top === null) { log(`⚠️ OpenAlex 没问成（${topic.id}）：这次不改任何文件（外部源失败 ≠ 没有研究）`); return { offline: true, works: added, assertions: newAssertions } }
    const recent = topic.recent > 0 ? await deps.openalex.listCards(`${base},publication_year:>${sinceYear}`, topic.recent) : []
    if (recent === null) { log(`⚠️ OpenAlex 没问成（${topic.id} 近两年）：这次不改任何文件`); return { offline: true, works: added, assertions: newAssertions } }
    const keys: string[] = []
    for (const card of [...top, ...recent]) {
      const s = sampleOf(card, topic, at, version)
      if (!s) continue
      if (!keys.includes(s.snapshot.work_id)) keys.push(s.snapshot.work_id)
      if (!works.has(s.snapshot.work_id)) { appendWork(s.snapshot, root); works.set(s.snapshot.work_id, s.snapshot); added++ }
      const fresh = s.assertions.filter((a) => !existingIds.has(a.id))
      if (fresh.length > 0) {
        appendJsonl(join(paths(root).assertions, monthFile(now).rel), fresh)
        for (const a of fresh) existingIds.add(a.id)
        newAssertions += fresh.length
      }
    }
    sample.topics.push({ id: topic.id, name: topic.name, works: keys })
  }
  writeJson(paths(root).sample, { _comment: '打样书架：由 sample 工作流生成（种子主题 → 作品键列表）。', ...sample })
  log(`样本：新增 ${added} 张名片、${newAssertions} 条模型建议断言，${sample.topics.length} 个主题`)
  return { offline: false, works: added, assertions: newAssertions }
}

export async function main(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const root = argValue(argv, '--root') ?? REPO_ROOT
  await runSample({ root, openalex: createOpenAlex({ apiKey: env.OPENALEX_API_KEY, log: (m, d) => console.error(m, d) }) })
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code }, (e) => { console.error(e); process.exitCode = 1 })
}
