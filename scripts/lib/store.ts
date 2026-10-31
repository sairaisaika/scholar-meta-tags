/**
 * 仓库即数据库：路径、JSONL 读写、哈希、配置与词表的读取（Node 侧，可用 node:*）。
 * ─────────────────────────────────────────────────────────────────────────────
 * 形状全部来自引擎（`scholar-meta`），这里只管「文件在哪、一行怎么读」。
 *   · `data/assertions/<yyyy>/<mm>.jsonl`：一行一条 `EvidenceAnnotation`，只追加；
 *   · `data/works/<hh>.jsonl`：名片快照（`abstract` 恒 null），`hh` ＝ sha256(work_id) 前两位十六进制；
 *   · `data/actors.jsonl`：`gh:<数字 id>` → 最近一次见到的登录名（最新一条生效）；
 *   · `vocab/`、`config/`：词表与规则参数。
 * 断言 id ＝ `a_` + sha256(canonical({work_id, kind, op, subject, payload, by.id, source.issue, source.comment}))[:20]，
 * canonical ＝ 键排序的 JSON——同一事件重跑同 id，入库天然幂等。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, appendFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EvidenceAnnotation, EvidenceCommunityPolicy, EvidenceConcept, EvidenceTagBinding, EvidenceWorkCard } from 'scholar-meta'

/** 仓库根：脚本目录的上一级（测试可以传别的根） */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const paths = (root: string = REPO_ROOT) => ({
  root,
  assertions: join(root, 'data', 'assertions'),
  works: join(root, 'data', 'works'),
  actors: join(root, 'data', 'actors.jsonl'),
  sample: join(root, 'data', 'sample.json'),
  redactions: join(root, 'data', 'REDACTIONS.md'),
  facets: join(root, 'vocab', 'facets.json'),
  concepts: join(root, 'vocab', 'concepts'),
  tags: join(root, 'vocab', 'tags.json'),
  bindings: join(root, 'vocab', 'bindings.jsonl'),
  config: join(root, 'config', 'smt.config.json'),
  roles: join(root, 'config', 'roles.json'),
  blocklist: join(root, 'config', 'blocklist.json'),
  seeds: join(root, 'config', 'seeds.json'),
})

// ── 哈希与 id ──────────────────────────────────────────────────────────────────

export const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')

/** 键排序的 JSON（递归；undefined 的键丢掉），用来算内容哈希 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).filter((k) => (value as Record<string, unknown>)[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
}

/** 断言 id：内容哈希（见头注） */
export function annotationId(a: Pick<EvidenceAnnotation, 'work_id' | 'kind' | 'op' | 'subject' | 'payload' | 'by' | 'source'>): string {
  const body = {
    work_id: a.work_id, kind: a.kind, op: a.op, subject: a.subject, payload: a.payload, by_id: a.by.id,
    issue: a.source.issue ?? null, comment: a.source.comment ?? null,
  }
  return `a_${sha256(canonical(body)).slice(0, 20)}`
}

/** 名片 / 导出分片：sha256(work_id) 前两位十六进制 */
export const workShard = (workId: string): string => sha256(workId).slice(0, 2)

/** 入库月片：`<yyyy>/<mm>.jsonl` */
export const monthFile = (at: string | Date): { year: string; month: string; rel: string } => {
  const d = typeof at === 'string' ? new Date(at) : at
  const year = String(d.getUTCFullYear())
  const month = String(d.getUTCMonth() + 1).padStart(2, '0')
  return { year, month, rel: `${year}/${month}.jsonl` }
}

/** 上一个月的 `<yyyy>/<mm>.jsonl` */
export const previousMonthFile = (at: string | Date): { year: string; month: string; rel: string } => {
  const d = typeof at === 'string' ? new Date(at) : new Date(at.getTime())
  return monthFile(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)))
}

// ── JSONL ───────────────────────────────────────────────────────────────────────

export interface JsonlLine<T = unknown> { line: number; value: T }
export interface JsonlBad { line: number; error: string }

/** 读一个 JSONL：每行一个对象；空行跳过；坏行单列（不抛） */
export function readJsonl<T = unknown>(file: string): { rows: JsonlLine<T>[]; bad: JsonlBad[] } {
  const rows: JsonlLine<T>[] = []
  const bad: JsonlBad[] = []
  if (!existsSync(file)) return { rows, bad }
  const text = readFileSync(file, 'utf8')
  text.split('\n').forEach((raw, i) => {
    const s = raw.trim()
    if (!s) return
    try {
      const v = JSON.parse(s) as unknown
      if (!v || typeof v !== 'object' || Array.isArray(v)) bad.push({ line: i + 1, error: 'not_an_object' })
      else rows.push({ line: i + 1, value: v as T })
    } catch (e) {
      bad.push({ line: i + 1, error: e instanceof Error ? e.message : String(e) })
    }
  })
  return { rows, bad }
}

export function appendJsonl(file: string, values: readonly unknown[]): void {
  if (values.length === 0) return
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, values.map((v) => `${JSON.stringify(v)}\n`).join(''), 'utf8')
}

export function writeJsonl(file: string, values: readonly unknown[]): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, values.map((v) => `${JSON.stringify(v)}\n`).join(''), 'utf8')
}

export function readJson<T = unknown>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** 目录下全部文件（递归，按路径排序）；目录不存在 ⇒ [] */
export function listFiles(dir: string, filter: (name: string) => boolean = () => true): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...listFiles(full, filter))
    else if (filter(name)) out.push(full)
  }
  return out
}

// ── 数据 ─────────────────────────────────────────────────────────────────────────

/** 全部断言（所有月片，按文件名顺序，再按 at、id 稳定排序）。TODO：`archive-*.tar.zst` 归档片暂不读（仓库到 600 MB 再做）。 */
export function loadAssertions(root: string = REPO_ROOT): { assertions: EvidenceAnnotation[]; bad: Array<JsonlBad & { file: string }> } {
  const p = paths(root)
  const assertions: EvidenceAnnotation[] = []
  const bad: Array<JsonlBad & { file: string }> = []
  for (const file of listFiles(p.assertions, (n) => n.endsWith('.jsonl'))) {
    const r = readJsonl<EvidenceAnnotation>(file)
    for (const row of r.rows) assertions.push(row.value)
    for (const b of r.bad) bad.push({ ...b, file })
  }
  assertions.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { assertions, bad }
}

/** 当月与上月的断言（入库时查幂等与日上限用） */
export function loadRecentAssertions(now: Date, root: string = REPO_ROOT): EvidenceAnnotation[] {
  const p = paths(root)
  const out: EvidenceAnnotation[] = []
  for (const m of [previousMonthFile(now), monthFile(now)]) {
    for (const row of readJsonl<EvidenceAnnotation>(join(p.assertions, m.rel)).rows) out.push(row.value)
  }
  return out
}

export interface WorkSnapshot {
  work_id: string
  aliases: string[]
  card: EvidenceWorkCard | null
  snapshot_at: string
  snapshot_source: 'openalex'
}

/** 全部名片快照：作品键 → 快照（同键多条取最新） */
export function loadWorks(root: string = REPO_ROOT): Map<string, WorkSnapshot> {
  const p = paths(root)
  const out = new Map<string, WorkSnapshot>()
  for (const file of listFiles(p.works, (n) => n.endsWith('.jsonl'))) {
    for (const row of readJsonl<WorkSnapshot>(file).rows) {
      const w = row.value
      if (!w || typeof w.work_id !== 'string') continue
      const prev = out.get(w.work_id)
      if (!prev || (w.snapshot_at ?? '') >= (prev.snapshot_at ?? '')) out.set(w.work_id, w)
    }
  }
  return out
}

/** 按作品键或别名找快照 */
export function findWork(works: Map<string, WorkSnapshot>, key: string): WorkSnapshot | null {
  const direct = works.get(key)
  if (direct) return direct
  for (const w of works.values()) if (w.aliases.includes(key)) return w
  return null
}

export function appendWork(snapshot: WorkSnapshot, root: string = REPO_ROOT): string {
  const file = join(paths(root).works, `${workShard(snapshot.work_id)}.jsonl`)
  appendJsonl(file, [snapshot])
  return file
}

export interface ActorRow { id: string; login: string; seen_at: string }

/** 账号登录名快照：最新一条生效 */
export function loadActors(root: string = REPO_ROOT): Map<string, ActorRow> {
  const out = new Map<string, ActorRow>()
  for (const row of readJsonl<ActorRow>(paths(root).actors).rows) if (row.value && typeof row.value.id === 'string') out.set(row.value.id, row.value)
  return out
}

/** 登录名有变（或第一次见到）才追加一行 */
export function rememberActor(actors: Map<string, ActorRow>, id: string, login: string, seenAt: string, root: string = REPO_ROOT): boolean {
  const prev = actors.get(id)
  if (prev && prev.login === login) return false
  const row: ActorRow = { id, login, seen_at: seenAt }
  appendJsonl(paths(root).actors, [row])
  actors.set(id, row)
  return true
}

// ── 配置与词表 ────────────────────────────────────────────────────────────────────

export interface SmtConfig extends EvidenceCommunityPolicy {
  abuse: { min_account_age_days: number; daily_issue_limit: number; daily_assertion_limit: number; max_assertions_per_issue: number; max_rows_per_work: number; max_quote_chars: number }
  queue: { stale_days: number }
  export: { label: string; shard_bits: number }
}

export interface FacetVocab {
  facets: Record<string, { label: Record<string, string>; values: string[]; maps_to: 'study_type' | null; locator_required: boolean }>
}

export interface Vocab {
  facets: FacetVocab
  concepts: EvidenceConcept[]
  tags: { tags: Record<string, { label: string; aliases: string[] }> }
  /** `vocab/bindings.jsonl` 原样（最新一条生效由导出端处理） */
  bindings: EvidenceTagBinding[]
}

const stripComment = <T extends object>(o: T & { _comment?: string }): T => { const { _comment: _, ...rest } = o; return rest as T }

export function loadConfig(root: string = REPO_ROOT): SmtConfig {
  return stripComment(readJson<SmtConfig & { _comment?: string }>(paths(root).config))
}

/** 配置 → 随导出下发的 `policy`（去掉 abuse / queue / export 三节） */
export function policyOf(config: SmtConfig): EvidenceCommunityPolicy {
  return { quorum: config.quorum, row: config.row, min_tier: config.min_tier, model_min_confidence: config.model_min_confidence }
}

export function loadRoles(root: string = REPO_ROOT): Record<string, 'editor' | 'maintainer'> {
  const file = paths(root).roles
  if (!existsSync(file)) return {}
  return readJson<{ roles?: Record<string, 'editor' | 'maintainer'> }>(file).roles ?? {}
}

export function loadBlocklist(root: string = REPO_ROOT): string[] {
  const file = paths(root).blocklist
  if (!existsSync(file)) return []
  return readJson<{ blocked?: string[] }>(file).blocked ?? []
}

export function loadVocab(root: string = REPO_ROOT): Vocab {
  const p = paths(root)
  const facets = stripComment(readJson<FacetVocab & { _comment?: string }>(p.facets))
  const concepts: EvidenceConcept[] = []
  for (const file of listFiles(p.concepts, (n) => n.endsWith('.jsonl'))) for (const row of readJsonl<EvidenceConcept>(file).rows) concepts.push(row.value)
  const tags = existsSync(p.tags) ? stripComment(readJson<Vocab['tags'] & { _comment?: string }>(p.tags)) : { tags: {} }
  const bindings = readJsonl<EvidenceTagBinding>(p.bindings).rows.map((r) => r.value)
  return { facets, concepts, tags, bindings }
}
