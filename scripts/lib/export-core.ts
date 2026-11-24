/**
 * 导出的纯函数部分：断言 + 名片 + 词表 → `EvidenceCommunityExport` 的全部文件内容（零 IO，重点测试；replay 也用它重放）。
 * ─────────────────────────────────────────────────────────────────────────────
 * 裁决 `resolveAnnotations` → 按作品分组 → 行 `reconcileRows`（竞争值 / 互为复录）→ 概念 `resolveConcepts` 写进 `rows[].concept_ids`
 * → `EvidenceCommunityWork`：`tags` 只放映射后有账本立场的（`communityStateToWorkTagState`，带 `quorum`），pending 的标签单列；
 * → 分片 `works/<hh>.jsonl`（sha256 真算）→ `frames.json`（`createCommunityPorts(exp).records()` → `buildSynthesisTable` → `summarizeFrames`）
 * → `bindings.json` / `concepts.json` / `queues.json` / `manifest.json`；另出模型建议旁路文件 `suggestions/<hh>.jsonl` 与 `suggestions.json`（`buildSuggestions`）。
 * 除 `generated_at` 与 `source_commit` 外全部由数据决定：同一批断言重放出同一批字节（replay 据此比对）。
 */
import {
  EVIDENCE_CONTRACT_VERSION, buildSynthesisTable, communityStateToWorkTagState, createCommunityPorts, reconcileRows, resolveAnnotations, resolveConcepts, summarizeFrames,
} from 'scholar-meta'
import type {
  EvidenceAnnotation, EvidenceAnnotationPayload, EvidenceCommunityDecision, EvidenceCommunityExport, EvidenceCommunityExportManifest, EvidenceCommunityPolicy,
  EvidenceCommunityWork, EvidenceConcept, EvidenceFrame, EvidenceTagBinding, EvidenceWorkTag,
} from 'scholar-meta'
import { canonical, sha256, workShard } from './store.js'
import type { FacetVocab, WorkSnapshot } from './store.js'

export interface ExportInput {
  assertions: readonly EvidenceAnnotation[]
  works: Map<string, WorkSnapshot>
  policy: EvidenceCommunityPolicy
  blocklist: readonly string[]
  facets: FacetVocab
  concepts: readonly EvidenceConcept[]
  /** `vocab/bindings.jsonl` 的行（最新一条生效） */
  vocabBindings: readonly EvidenceTagBinding[]
  label: string
  repository: string
  maintainers: readonly string[]
  generated_at: string
  source_commit: string | null
  /** 待定多久算陈旧（进 queues.stale） */
  stale_days: number
}

export interface ExportFiles {
  manifest: EvidenceCommunityExportManifest
  /** 路径（`works/<hh>.jsonl`）→ 作品行（已排序） */
  shards: Map<string, EvidenceCommunityWork[]>
  frames: EvidenceFrame[]
  bindings: EvidenceTagBinding[]
  concepts: EvidenceConcept[]
  queues: Queues
  /** 装好的导出（与写出的文件同内容），方便自检 */
  export: EvidenceCommunityExport
  /** 模型建议旁路文件（不在引擎契约里；宿主的读取函数不读） */
  suggestions: SuggestionFiles
}

/** 一篇作品的模型建议：只收模型层当前生效的标签建议。模型层永不计票，这里只是把它们按作品摆出来给标注页看 */
export interface SuggestionRow {
  work_id: string
  models: Array<{ id: string; version: string | null; tags: Array<{ tag_key: string; label: string; confidence: number | null }> }>
}
export interface SuggestionIndex {
  /** `models`：模型 id → 建议条数 */
  counts: { works: number; suggestions: number; models: Record<string, number> }
  shards: Array<{ path: string; works: number; suggestions: number; sha256: string }>
}
export interface SuggestionFiles { shards: Map<string, SuggestionRow[]>; index: SuggestionIndex }


/** 任务板。`stale_pending` 按导出时刻算，是唯一随时间变的部分（replay 比对时跳过它）。 */
export interface Queues {
  disputed: Array<{ work_id: string; subject: string; kind: string; reasons: string[]; issues: string[] }>
  challenged: Array<{ work_id: string; subject: string; kind: string; challengers: number }>
  needs_re_extraction: Array<{ work_id: string; row_id: string; locator: string }>
  /** 解析不到概念、出现最多的语境原文 */
  unlisted_values: Array<{ facet: string; value: string; rows: number }>
  stale_pending: Array<{ work_id: string; subject: string; since: string }>
}

const later = (a: EvidenceAnnotation, b: EvidenceAnnotation) => a.at > b.at || (a.at === b.at && a.id > b.id)
export const shardPath = (workId: string) => `works/${workShard(workId)}.jsonl`
export const serializeShard = (works: readonly EvidenceCommunityWork[]) => works.map((w) => JSON.stringify(w)).join('\n') + (works.length > 0 ? '\n' : '')

export const recordIdOf = (workId: string, rowId: string) => `community:${workId}/${rowId}`

export const suggestionPath = (workId: string) => `suggestions/${workShard(workId)}.jsonl`
export const serializeSuggestions = (rows: readonly SuggestionRow[]) => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : '')
/** 贡献包入库时把置信度记在 note 里（`import:<文件>;confidence=<x>`）；没有 ⇒ null */
export const confidenceOfNote = (note: string | null | undefined): number | null => {
  const m = /(?:^|;)confidence=([0-9]*\.?[0-9]+)(?:;|$)/.exec(note ?? '')
  const n = m ? Number(m[1]) : NaN
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null
}

/** 贡献包写成的断言的来源标记（`source.form`） */
export const IMPORT_FORM = 'import/1'

export interface ModelTagSet { version: string | null; tags: Map<string, EvidenceAnnotation> }

/** 贡献包入库时记在 note 里的「回答指纹」（`…;answer=<12 位十六进制>`）：同一个包条目写出来的各行带同一个指纹 */
export const answerOfNote = (note: string | null | undefined): string | null => /(?:^|;)answer=([0-9a-f]{12})(?:;|$)/.exec(note ?? '')?.[1] ?? null

/**
 * 每篇作品、每个模型**当前生效**的标签建议（作品 → 模型 → 那一组）。导出的旁路文件与质量评估都用它。
 *   · 贡献包的一条是模型对这一篇的完整回答，入库时整组写进来、各行带同一个（版本, 回答指纹）。同一个模型在同一篇上
 *     只有**最后写进来的那一组**生效——新回答不再给的标签随之退场。入库保证最后写进来的就是 `imports/` 里现在的那一份
 *     （见 import.ts）。模型对某篇不再回答时，旧的那组仍然留着（模型不能撤回）。
 *   · 其他来源（样本脚本）的「版本」只是运行日期，逐个标签键累积。
 *   · 同一个标签键留最新一条；这一组的版本取其中最新一条断言的版本。`canon` 把作品键换成同一个（别名 → 导出里的键）。
 */
export function currentModelTags(
  assertions: readonly EvidenceAnnotation[], opts: { blocklist?: readonly string[]; canon?: (workId: string) => string } = {},
): Map<string, Map<string, ModelTagSet>> {
  const blocked = new Set(opts.blocklist ?? [])
  const canon = opts.canon ?? ((k: string) => k)
  const rows = new Map<string, Map<string, EvidenceAnnotation[]>>()
  for (const a of assertions) {
    if (!a || a.by?.kind !== 'model' || a.kind !== 'tag' || a.op !== 'add' || a.payload?.kind !== 'tag' || !a.subject.startsWith('tag:') || blocked.has(a.by.id)) continue
    const work = canon(a.work_id)
    let models = rows.get(work)
    if (!models) { models = new Map(); rows.set(work, models) }
    const list = models.get(a.by.id)
    if (list) list.push(a)
    else models.set(a.by.id, [a])
  }
  const newestOf = (list: readonly EvidenceAnnotation[]) => list.reduce((x, y) => (later(y, x) ? y : x))
  const out = new Map<string, Map<string, ModelTagSet>>()
  for (const [work, models] of rows) {
    const sets = new Map<string, ModelTagSet>()
    for (const [model, list] of models) {
      const imported = list.filter((a) => a.source?.form === IMPORT_FORM)
      const newest = imported.length > 0 ? newestOf(imported) : null
      const inGroup = (a: EvidenceAnnotation) => newest !== null && (a.by.model_version ?? null) === (newest.by.model_version ?? null) && answerOfNote(a.note) === answerOfNote(newest.note)
      const kept = list.filter((a) => a.source?.form !== IMPORT_FORM || inGroup(a))
      const tags = new Map<string, EvidenceAnnotation>()
      for (const a of kept) {
        const key = a.subject.slice(4)
        const prev = tags.get(key)
        if (!prev || later(a, prev)) tags.set(key, a)
      }
      sets.set(model, { version: newestOf(kept).by.model_version ?? null, tags })
    }
    out.set(work, sets)
  }
  return out
}

/** 作品键的别名表：名片快照的别名 → 它的作品键 */
export function workCanon(works: ReadonlyMap<string, WorkSnapshot>): (workId: string) => string {
  const alias = new Map<string, string>()
  for (const w of works.values()) { alias.set(w.work_id, w.work_id) }
  for (const w of works.values()) for (const a of w.aliases) if (!alias.has(a)) alias.set(a, w.work_id)
  return (k) => alias.get(k) ?? k
}

/**
 * 模型建议旁路文件：当前生效的模型标签建议（`currentModelTags`）→ 按作品分片（与作品分片同一种分法）。
 * 全部由断言与名片的别名决定，重放可逐字节比对。
 */
export function buildSuggestions(assertions: readonly EvidenceAnnotation[], opts: { blocklist?: readonly string[]; canon?: (workId: string) => string } = {}): SuggestionFiles {
  const current = currentModelTags(assertions, opts)
  const shards = new Map<string, SuggestionRow[]>()
  const perModel: Record<string, number> = {}
  let total = 0
  for (const workId of [...current.keys()].sort()) {
    const models = [...current.get(workId)!.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, set]) => {
      const list = [...set.tags.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
      perModel[id] = (perModel[id] ?? 0) + list.length
      total += list.length
      return { id, version: set.version, tags: list.map(([tag_key, a]) => ({ tag_key, label: a.payload.kind === 'tag' ? a.payload.tag : tag_key, confidence: confidenceOfNote(a.note) })) }
    })
    const path = suggestionPath(workId)
    shards.set(path, [...(shards.get(path) ?? []), { work_id: workId, models }])
  }
  const meta = [...shards.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, rows]) => ({
    path, works: rows.length, suggestions: rows.reduce((n, r) => n + r.models.reduce((k, m) => k + m.tags.length, 0), 0), sha256: sha256(Buffer.from(serializeSuggestions(rows), 'utf8')),
  }))
  return { shards, index: { counts: { works: current.size, suggestions: total, models: Object.fromEntries(Object.entries(perModel).sort(([a], [b]) => (a < b ? -1 : 1))) }, shards: meta } }
}

export function buildExport(input: ExportInput): ExportFiles {
  const blocked = new Set(input.blocklist)
  const decisions = resolveAnnotations(input.assertions, input.policy, { blocklist: input.blocklist })
  const byId = new Map(input.assertions.map((a) => [a.id, a]))
  const byWork = new Map<string, EvidenceAnnotation[]>()
  for (const a of input.assertions) { if (!a || typeof a.work_id !== 'string') continue; byWork.set(a.work_id, [...(byWork.get(a.work_id) ?? []), a]) }
  const decisionsByWork = new Map<string, EvidenceCommunityDecision[]>()
  for (const d of decisions) decisionsByWork.set(d.work_id, [...(decisionsByWork.get(d.work_id) ?? []), d])

  // 行：先全部收齐再 reconcileRows（同一作品内比较槽位）
  type RowEntry = { work_id: string; row_id: string; input: Extract<EvidenceAnnotationPayload, { kind: 'row' }>; decision: EvidenceCommunityDecision }
  const rowEntries: RowEntry[] = []
  for (const d of decisions) {
    if (d.kind !== 'row') continue
    const eff = d.effective_id ? byId.get(d.effective_id) : undefined
    if (!eff || eff.payload.kind !== 'row') continue
    rowEntries.push({ work_id: d.work_id, row_id: d.subject.replace(/^row:/, ''), input: eff.payload, decision: d })
  }
  reconcileRows(rowEntries, input.policy)

  const works: EvidenceCommunityWork[] = []
  // 有裁决的作品 + 只有名片快照、还没人表态的作品（打样书架靠它们出现在导出里；标签 / 分面 / 行为空，模型建议从名片的主题与关键词来）
  const workIds = [...new Set([...decisionsByWork.keys(), ...input.works.keys()])].sort()
  const presentTagsOf = new Map<string, string[]>()
  const unlisted = new Map<string, { facet: string; value: string; rows: number }>()
  for (const workId of workIds) {
    const ds = decisionsByWork.get(workId) ?? []
    const anns = byWork.get(workId) ?? []
    const snap = input.works.get(workId) ?? [...input.works.values()].find((w) => w.aliases.includes(workId)) ?? null
    const tags: EvidenceWorkTag[] = []
    const pending: EvidenceCommunityWork['pending'] = []
    const facets: EvidenceCommunityWork['facets'] = {}
    for (const d of ds) {
      if (d.kind === 'tag') {
        const state = communityStateToWorkTagState(d.state)
        const key = d.subject.replace(/^tag:/, '')
        if (!state) { pending.push({ subject: d.subject, decision: d }); continue }
        tags.push({ tag_key: key, label: d.value ?? key, state, decided_by: d.decided_by, support: d.support, last_changed: d.last_changed, request_id: null, quorum: d.quorum })
      } else if (d.kind === 'facet') {
        const facet = d.subject.replace(/^facet:/, '')
        if (!d.value) continue
        const locators = [...new Set(anns
          .filter((a) => a.kind === 'facet' && a.op === 'add' && a.payload.kind === 'facet' && a.payload.value === d.value && !blocked.has(a.by.id) && typeof a.payload.locator === 'string' && a.payload.locator.trim())
          .map((a) => (a.payload as { locator: string }).locator.trim()))].sort()
        facets[facet] = { value: d.value, decision: d, locators }
      }
    }
    const rows: EvidenceCommunityWork['rows'] = rowEntries.filter((r) => r.work_id === workId).sort((a, b) => (a.row_id < b.row_id ? -1 : 1)).map((r) => {
      const ids = resolveConcepts(r.input.context, input.concepts)
      for (const facet of ['outcome', 'population', 'comparison', 'timepoint'] as const) {
        if (ids[facet]) continue
        const value = r.input.context[facet]
        if (!value) continue
        const k = `${facet}\u0000${value.toLowerCase()}`
        const cur = unlisted.get(k) ?? { facet, value, rows: 0 }
        cur.rows++
        unlisted.set(k, cur)
      }
      return { row_id: r.row_id, input: r.input, ...(Object.keys(ids).length > 0 ? { concept_ids: ids } : {}), decision: r.decision }
    })
    // unsure：每人在每个 subject 上的最新评议是「不确定」的人次
    const latestReview = new Map<string, EvidenceAnnotation>()
    for (const a of anns) {
      if (a.kind !== 'review' || blocked.has(a.by.id)) continue
      const k = `${a.by.id}\u0000${a.subject}`
      const prev = latestReview.get(k)
      if (!prev || later(a, prev)) latestReview.set(k, a)
    }
    const unsure = [...latestReview.values()].filter((a) => a.op === 'unsure').length
    const updated_at = anns.map((a) => a.at).sort().at(-1) ?? snap?.snapshot_at ?? ''
    const aliases = snap ? [...new Set([snap.work_id, ...snap.aliases])].filter((k) => k !== workId).sort() : []
    tags.sort((a, b) => (a.tag_key < b.tag_key ? -1 : 1))
    pending.sort((a, b) => (a.subject < b.subject ? -1 : 1))
    presentTagsOf.set(workId, tags.filter((t) => t.state === 'present').map((t) => t.tag_key))
    works.push({ work_id: workId, aliases, card: snap?.card ?? null, tags, pending, facets, rows, unsure, updated_at })
  }

  // 分片
  const shards = new Map<string, EvidenceCommunityWork[]>()
  for (const w of works) { const p = shardPath(w.work_id); shards.set(p, [...(shards.get(p) ?? []), w]) }
  const shardMeta = [...shards.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, list]) => {
    const bytes = Buffer.from(serializeShard(list), 'utf8')
    return { path, bytes: bytes.length, sha256: sha256(bytes), works: list.length }
  })

  // 绑定：词表文件（最新一条生效）被编辑层的绑定裁决覆盖
  const bindingMap = new Map<string, EvidenceTagBinding>()
  for (const b of input.vocabBindings) {
    if (!b || typeof b.tag_key !== 'string' || b.kind === 'machine') continue
    const prev = bindingMap.get(b.tag_key)
    if (!prev || b.bound_at >= prev.bound_at) bindingMap.set(b.tag_key, { ...b, confidence: null })
  }
  for (const d of decisions) {
    if (d.kind !== 'binding' || d.state !== 'confirmed' || !d.effective_id) continue
    const eff = byId.get(d.effective_id)
    if (!eff || eff.payload.kind !== 'binding') continue
    const key = d.subject.replace(/^binding:/, '')
    const prev = bindingMap.get(key)
    if (prev && prev.bound_at > d.last_changed) continue
    bindingMap.set(key, {
      tag_key: key, topic_id: eff.payload.topic?.id ?? null, topic_name: eff.payload.topic?.display_name ?? null,
      kind: eff.payload.topic ? 'curated' : 'rejected', confidence: null, bound_at: eff.at, bound_by: eff.by.id, note: eff.note,
    })
  }
  const bindings = [...bindingMap.values()].sort((a, b) => (a.tag_key < b.tag_key ? -1 : 1))
  const concepts = [...input.concepts].sort((a, b) => (a.id < b.id ? -1 : 1))

  const facet_vocab: EvidenceCommunityExportManifest['facet_vocab'] = Object.fromEntries(Object.entries(input.facets.facets).map(([k, v]) => [k, { values: [...v.values], maps_to: v.maps_to, locator_required: v.locator_required }]))
  const contributors = new Set(input.assertions.filter((a) => a?.by?.kind === 'person' && !blocked.has(a.by.id)).map((a) => a.by.id)).size
  const countState = (pred: (s: EvidenceCommunityDecision['state']) => boolean) => decisions.filter((d) => pred(d.state)).length
  const manifestBase: Omit<EvidenceCommunityExportManifest, 'counts'> & { counts: Omit<EvidenceCommunityExportManifest['counts'], 'frames'> } = {
    contract: EVIDENCE_CONTRACT_VERSION,
    export_version: 1,
    generated_at: input.generated_at,
    source_commit: input.source_commit,
    label: input.label,
    license: 'CC0-1.0',
    repository: input.repository,
    policy: input.policy,
    facet_vocab,
    concepts_version: sha256(canonical(concepts)).slice(0, 12),
    maintainers: [...input.maintainers].sort(),
    shards: shardMeta,
    counts: {
      works: works.length, assertions: input.assertions.length, contributors,
      accepted: countState((s) => s === 'accepted' || s === 'confirmed'), pending: countState((s) => s === 'pending'), disputed: countState((s) => s === 'disputed'),
    },
  }

  // frames：装成导出 → 端口 → 记录 → 分面表 → frame
  const draft: EvidenceCommunityExport = { manifest: { ...manifestBase, counts: { ...manifestBase.counts, frames: 0 } }, works, bindings, concepts, frames: [] }
  const ports = createCommunityPorts(draft, { retrieved_at: input.generated_at })
  const { records, contexts } = ports.records()
  const recordWork = new Map<string, EvidenceCommunityWork>()
  for (const w of works) for (const r of w.rows) recordWork.set(recordIdOf(w.work_id, r.row_id), w)
  const table = buildSynthesisTable(records, contexts)
  const frames = summarizeFrames(table, {
    concepts,
    locale: 'en',
    tagsOf: (id) => { const w = recordWork.get(id); return w ? presentTagsOf.get(w.work_id) ?? [] : [] },
    topicsOf: (id) => recordWork.get(id)?.card?.topics.map((t) => t.id) ?? [],
  })
  const manifest: EvidenceCommunityExportManifest = { ...manifestBase, counts: { ...manifestBase.counts, frames: frames.length } }

  const queues: Queues = {
    disputed: decisions.filter((d) => d.state === 'disputed').map((d) => ({ work_id: d.work_id, subject: d.subject, kind: d.kind, reasons: d.reasons, issues: d.issues })),
    challenged: decisions.filter((d) => d.quorum?.challenged).map((d) => ({ work_id: d.work_id, subject: d.subject, kind: d.kind, challengers: d.quorum!.challengers })),
    needs_re_extraction: rowEntries.filter((r) => r.decision.state === 'pending' && r.decision.issues.includes('needs_re_extraction'))
      .map((r) => ({ work_id: r.work_id, row_id: r.row_id, locator: r.input.context.locator })),
    unlisted_values: [...unlisted.values()].sort((a, b) => b.rows - a.rows || (a.facet < b.facet ? -1 : a.facet > b.facet ? 1 : a.value < b.value ? -1 : 1)).slice(0, 100),
    stale_pending: decisions.filter((d) => d.state === 'pending' && d.last_changed && Date.parse(input.generated_at) - Date.parse(d.last_changed) > input.stale_days * 86_400_000)
      .map((d) => ({ work_id: d.work_id, subject: d.subject, since: d.last_changed })),
  }

  return { manifest, shards, frames, bindings, concepts, queues, export: { manifest, works, bindings, concepts, frames }, suggestions: buildSuggestions(input.assertions, { blocklist: input.blocklist, canon: workCanon(input.works) }) }
}
