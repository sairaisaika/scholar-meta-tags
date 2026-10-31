/**
 * 导出的纯函数部分：断言 + 名片 + 词表 → `EvidenceCommunityExport` 的全部文件内容（零 IO，重点测试；replay 也用它重放）。
 * ─────────────────────────────────────────────────────────────────────────────
 * 裁决 `resolveAnnotations` → 按作品分组 → 行 `reconcileRows`（竞争值 / 互为复录）→ 概念 `resolveConcepts` 写进 `rows[].concept_ids`
 * → `EvidenceCommunityWork`：`tags` 只放映射后有账本立场的（`communityStateToWorkTagState`，带 `quorum`），pending 的标签单列；
 * → 分片 `works/<hh>.jsonl`（sha256 真算）→ `frames.json`（`createCommunityPorts(exp).records()` → `buildSynthesisTable` → `summarizeFrames`）
 * → `bindings.json` / `concepts.json` / `queues.json` / `manifest.json`。
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
}

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
  const workIds = [...decisionsByWork.keys()].sort()
  const presentTagsOf = new Map<string, string[]>()
  const unlisted = new Map<string, { facet: string; value: string; rows: number }>()
  for (const workId of workIds) {
    const ds = decisionsByWork.get(workId)!
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
    const updated_at = anns.map((a) => a.at).sort().at(-1) ?? ''
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

  return { manifest, shards, frames, bindings, concepts, queues, export: { manifest, works, bindings, concepts, frames } }
}
