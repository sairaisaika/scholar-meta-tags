/**
 * 数据层：拉本站导出（export/v1）、用引擎读回、建索引；词表与裁决参数来自构建期注入的常量。
 * 导出不存在（404 / file:// 下 fetch 失败）⇒ `status: 'missing'`，页面显示空书架，不报错。
 */
import {
  EVIDENCE_CONTRACT_VERSION, createCommunityPorts, readCommunityExport, normalizeWorkId,
  type CommunityPorts, type EvidenceCommunityExport, type EvidenceCommunityWork, type EvidenceConcept, type EvidenceRecord, type SynthesisContext,
} from 'scholar-meta'

export interface TagEntry { tag_key: string; label: string; works: Set<string> }

export interface Loaded {
  exp: EvidenceCommunityExport
  ports: CommunityPorts
  /** 全部作品的记录与语境（accepted / confirmed 的行，核验档 ≥ single：页面预览用它；宿主自己会用更严的 double） */
  records: EvidenceRecord[]
  contexts: SynthesisContext[]
  /** 记录 id → 作品键 */
  workOfRecord: Map<string, string>
  tags: Map<string, TagEntry>
  concepts: EvidenceConcept[]
}

export type ExportState =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'bad'; issues: number }
  | { status: 'ok'; data: Loaded }

export const config: SmtConfig = __SMT_CONFIG__
export const vocab: SmtVocab = __SMT_VOCAB__
export const policyFile: Record<string, unknown> = __SMT_POLICY__
export const buildInfo = __SMT_BUILD__

/** 词表里的概念（经引擎同一套宽松读法验形）；导出带 concepts 时以导出为准 */
export function vocabConcepts(): EvidenceConcept[] {
  const read = readCommunityExport(
    { contract: EVIDENCE_CONTRACT_VERSION, export_version: 1, license: 'CC0-1.0', policy: {}, shards: [], counts: {} },
    [],
    { concepts: vocab.concepts },
  )
  return read.ok ? read.value.concepts : []
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

function parseShard(text: string): unknown {
  const t = text.trim()
  if (!t) return []
  if (t.startsWith('[') || t.startsWith('{')) {
    try {
      const v: unknown = JSON.parse(t)
      // 只有一行的 JSON Lines 整个也是合法 JSON：它是一行，不是整片——包成数组（`{ works: [...] }` 这种整片写法原样交回）
      if (Array.isArray(v) || (v !== null && typeof v === 'object' && Array.isArray((v as { works?: unknown }).works))) return v
      return [v]
    } catch { /* 当 JSON Lines 再试 */ }
  }
  const out: unknown[] = []
  for (const line of t.split('\n')) {
    const l = line.trim()
    if (!l) continue
    try { out.push(JSON.parse(l)) } catch { out.push(null) }
  }
  return out
}

export async function loadExport(base: string): Promise<ExportState> {
  // file:// 下浏览器不允许 fetch 同目录文件（控制台会报 CORS）：直接当「没有导出」，不发请求
  if (typeof location !== 'undefined' && location.protocol === 'file:') return { status: 'missing' }
  const root = base.replace(/\/+$/, '')
  const manifestText = await fetchText(`${root}/manifest.json`)
  if (manifestText === null) return { status: 'missing' }
  let manifest: unknown
  try { manifest = JSON.parse(manifestText) } catch { return { status: 'bad', issues: 1 } }
  const shardPaths = Array.isArray((manifest as { shards?: unknown }).shards)
    ? ((manifest as { shards: Array<{ path?: unknown }> }).shards).map((s) => (typeof s.path === 'string' ? s.path : '')).filter(Boolean)
    : []
  const [shards, bindings, concepts, frames] = await Promise.all([
    Promise.all(shardPaths.map(async (p) => { const t = await fetchText(`${root}/${p.replace(/^\/+/, '')}`); return t === null ? [] : parseShard(t) })),
    fetchText(`${root}/bindings.json`).then((t) => (t === null ? undefined : safeJson(t))),
    fetchText(`${root}/concepts.json`).then((t) => (t === null ? undefined : safeJson(t))),
    fetchText(`${root}/frames.json`).then((t) => (t === null ? undefined : safeJson(t))),
  ])
  const read = readCommunityExport(manifest, shards, {
    ...(bindings !== undefined ? { bindings } : {}),
    ...(concepts !== undefined ? { concepts } : {}),
    ...(frames !== undefined ? { frames } : {}),
  })
  if (!read.ok) return { status: 'bad', issues: read.issues.length }
  return { status: 'ok', data: index(read.value) }
}

const safeJson = (t: string): unknown => { try { return JSON.parse(t) } catch { return undefined } }

/** 账本里某个模型给一篇作品的标签建议（模型层：永不计票） */
export interface ModelSuggestion { id: string; version: string | null; tags: Array<{ tag_key: string; label: string; confidence: number | null }> }

/** `failed` ＝ 没取成（网络、服务器错误）：不是「没有」，页面要如实说，也不记住这次失败 */
export type SuggestionState = { status: 'ok'; models: ModelSuggestion[] } | { status: 'failed' }

const suggestionCache = new Map<string, Promise<SuggestionState>>()

/**
 * 一篇作品的模型建议：导出的旁路文件 `suggestions/<hh>.jsonl`（hh ＝ sha256(作品键) 前两位十六进制，与作品分片同一种分法）。
 * 只取这一片。没有这个文件（404）⇒ 没有建议；取不成 ⇒ `failed`（下次打开这一篇再取）。同一篇取成之后只取一次。
 */
export function loadSuggestions(base: string, workId: string): Promise<SuggestionState> {
  const hit = suggestionCache.get(workId)
  if (hit) return hit
  const run = (async (): Promise<SuggestionState> => {
    if (typeof location !== 'undefined' && location.protocol === 'file:') return { status: 'ok', models: [] }
    if (typeof crypto === 'undefined' || !crypto.subtle) return { status: 'failed' }
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(workId)))
    const hh = (digest[0] ?? 0).toString(16).padStart(2, '0')
    const res = await fetch(`${base.replace(/\/+$/, '')}/suggestions/${hh}.jsonl`, { cache: 'no-store' })
    if (res.status === 404) return { status: 'ok', models: [] }
    if (!res.ok) return { status: 'failed' }
    const rows = parseShard(await res.text())
    const row = (Array.isArray(rows) ? rows : []).find((r) => !!r && typeof r === 'object' && (r as { work_id?: unknown }).work_id === workId) as { models?: unknown } | undefined
    const models: ModelSuggestion[] = []
    for (const m of Array.isArray(row?.models) ? (row.models as Array<Record<string, unknown>>) : []) {
      if (!m || typeof m.id !== 'string' || !Array.isArray(m.tags)) continue
      const tags = (m.tags as Array<Record<string, unknown>>)
        .filter((x) => !!x && typeof x.tag_key === 'string' && typeof x.label === 'string')
        .map((x) => ({ tag_key: x.tag_key as string, label: x.label as string, confidence: typeof x.confidence === 'number' && Number.isFinite(x.confidence) ? x.confidence : null }))
      if (tags.length > 0) models.push({ id: m.id, version: typeof m.version === 'string' ? m.version : null, tags })
    }
    return { status: 'ok', models }
  })().catch((): SuggestionState => ({ status: 'failed' }))
  suggestionCache.set(workId, run)
  // 没取成的不留在缓存里
  void run.then((r) => { if (r.status === 'failed' && suggestionCache.get(workId) === run) suggestionCache.delete(workId) })
  return run
}

function index(exp: EvidenceCommunityExport): Loaded {
  const ports = createCommunityPorts(exp, { minVerification: 'single' })
  const { records, contexts } = ports.records()
  const workOfRecord = new Map<string, string>()
  for (const r of records) {
    const i = r.external_id.lastIndexOf('/')
    workOfRecord.set(r.id, i > 0 ? r.external_id.slice(0, i) : r.external_id)
  }
  const tags = new Map<string, TagEntry>()
  const put = (key: string, label: string, work: string) => {
    const e = tags.get(key) ?? { tag_key: key, label, works: new Set<string>() }
    e.works.add(work)
    tags.set(key, e)
  }
  for (const w of exp.works) {
    for (const t of w.tags) if (t.state !== 'absent') put(t.tag_key, t.label, w.work_id)
    for (const p of w.pending) if (p.decision.kind === 'tag' && p.subject.startsWith('tag:')) put(p.subject.slice(4), p.decision.value ?? p.subject.slice(4), w.work_id)
  }
  const concepts = exp.concepts.length > 0 ? exp.concepts : vocabConcepts()
  return { exp, ports, records, contexts, workOfRecord, tags, concepts }
}

/** 按作品键（或别名）取导出里的作品 */
export function findWork(data: Loaded | null, key: string): EvidenceCommunityWork | null {
  return data ? data.ports.work(normalizeWorkId(key) ?? key) : null
}

/** 一篇作品上「被说成」的标签键（有 + 争议 + 待定；不含「没有」） */
export function tagKeysOf(work: EvidenceCommunityWork | null): string[] {
  if (!work) return []
  const keys = new Set<string>()
  for (const t of work.tags) if (t.state !== 'absent') keys.add(t.tag_key)
  for (const p of work.pending) if (p.decision.kind === 'tag' && p.subject.startsWith('tag:')) keys.add(p.subject.slice(4))
  return [...keys]
}

/** 带这些标签键的作品的记录与语境；一个都没有时回全部 */
export function scopeByTags(data: Loaded, keys: readonly string[]): { records: EvidenceRecord[]; contexts: SynthesisContext[]; scoped: boolean } {
  const works = new Set<string>()
  for (const k of keys) for (const w of data.tags.get(k)?.works ?? []) works.add(w)
  if (works.size === 0) return { records: data.records, contexts: data.contexts, scoped: false }
  const records = data.records.filter((r) => works.has(data.workOfRecord.get(r.id) ?? ''))
  const ids = new Set(records.map((r) => r.id))
  return { records, contexts: data.contexts.filter((c) => ids.has(c.record_id)), scoped: true }
}

export function tagKeysOfRecord(data: Loaded, recordId: string): string[] {
  const work = data.workOfRecord.get(recordId)
  return work ? tagKeysOf(data.ports.work(work)) : []
}
