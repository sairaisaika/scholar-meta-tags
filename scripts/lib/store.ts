/**
 * 仓库即数据库：路径、JSONL 读写、哈希、配置与词表的读取（Node 侧，可用 node:*）。
 * ─────────────────────────────────────────────────────────────────────────────
 * 形状全部来自引擎（`scholar-meta`），这里只管「文件在哪、一行怎么读」。
 *   · `data/assertions/<yyyy>/<mm>.jsonl`（满了接着写 `<mm>-002.jsonl`、`-003`…）：一行一条 `EvidenceAnnotation`，只追加；
 *   · `data/gold/*.jsonl`：维护者标的标准答案（一行一篇：作品键、标签、可选的研究设计），最新一行生效；
 *   · `data/model-reference/*.jsonl`：模型参考标注（不是人标；`by` 是 `model:<id>`），与标准答案分开存、分开评；
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

/** 一个断言分片的上限（缺省 20 MB）：GitHub 单文件 50 MB 起警告、100 MB 拒绝，留足余量；`config.store.max_part_mb` 可改 */
export const DEFAULT_PART_BYTES = 20 * 1024 * 1024

const partName = (month: string, n: number) => (n <= 1 ? `${month}.jsonl` : `${month}-${String(n).padStart(3, '0')}.jsonl`)

/** 某个月已有的分片（按序号；绝对路径）。`<mm>.jsonl` 是第 1 片，`<mm>-002.jsonl` 是第 2 片 */
export function monthParts(at: string | Date, root: string = REPO_ROOT): string[] {
  const m = monthFile(at)
  const dir = join(paths(root).assertions, m.year)
  if (!existsSync(dir)) return []
  const re = new RegExp(`^${m.month}(?:-(\\d{3}))?\\.jsonl$`)
  return readdirSync(dir)
    .map((name) => ({ name, hit: re.exec(name) }))
    .filter((x): x is { name: string; hit: RegExpExecArray } => x.hit !== null)
    .map((x) => ({ n: x.hit[1] ? Number(x.hit[1]) : 1, file: join(dir, x.name) }))
    .sort((a, b) => a.n - b.n)
    .map((x) => x.file)
}

/**
 * 追加断言：写进当月最后一片；这一片加上这批会超过上限（且它不是空的）就开下一片。
 * 读取是全部分片合并后按时间与 id 排序，所以分在哪一片不影响裁决与重放。回写入的文件（没有内容时为 null）。
 */
export function appendAssertions(rows: readonly EvidenceAnnotation[], at: string | Date, root: string = REPO_ROOT, maxBytes?: number): string | null {
  if (rows.length === 0) return null
  const limit = maxBytes ?? partLimit(root)
  const m = monthFile(at)
  const dir = join(paths(root).assertions, m.year)
  const text = rows.map((v) => `${JSON.stringify(v)}\n`).join('')
  const parts = monthParts(at, root)
  let n = Math.max(1, parts.length)
  let file = parts[parts.length - 1] ?? join(dir, partName(m.month, 1))
  const size = existsSync(file) ? statSync(file).size : 0
  if (size > 0 && size + Buffer.byteLength(text, 'utf8') > limit) { n += 1; file = join(dir, partName(m.month, n)) }
  mkdirSync(dir, { recursive: true })
  appendFileSync(file, text, 'utf8')
  return file
}

function partLimit(root: string): number {
  try {
    const mb = (readJson<{ store?: { max_part_mb?: number } }>(paths(root).config)).store?.max_part_mb
    return typeof mb === 'number' && mb > 0 ? Math.floor(mb * 1024 * 1024) : DEFAULT_PART_BYTES
  } catch { return DEFAULT_PART_BYTES }
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
  void p
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  for (const file of [...monthParts(prev, root), ...monthParts(now, root)]) {
    for (const row of readJsonl<EvidenceAnnotation>(file).rows) out.push(row.value)
  }
  return out
}

// ── 账本摘要 ─────────────────────────────────────────────────────────────────────

export interface LedgerFile { path: string; bytes: number; lines: number; sha256: string }
export interface Ledger { files: LedgerFile[]; assertions: number; digest: string }

/**
 * 全部断言文件的字节数、行数与 sha256，以及按路径排序后的总哈希（`<路径>\t<sha256>\n` 逐行拼起来再哈希）。
 * 随导出与每日存档发布：任何一天的存档都能回答「那天的账本是什么」，事后改写对不上。
 */
export function ledgerOf(root: string = REPO_ROOT): Ledger {
  const dir = paths(root).assertions
  const files = listFiles(dir, (n) => n.endsWith('.jsonl')).map((file) => {
    const bytes = readFileSync(file)
    const text = bytes.toString('utf8')
    return { path: file.slice(root.length + 1).split('\\').join('/'), bytes: bytes.length, lines: text.split('\n').filter((l) => l.trim() !== '').length, sha256: sha256(bytes) }
  }).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { files, assertions: files.reduce((n, f) => n + f.lines, 0), digest: sha256(files.map((f) => `${f.path}\t${f.sha256}\n`).join('')) }
}

// ── 标准答案 ─────────────────────────────────────────────────────────────────────

export interface GoldRow { work_id: string; tags: string[]; design?: string | null; by: string; at: string; note?: string | null }

/** 标准答案：`data/gold/*.jsonl` 全部行，同一篇取最新一行（按 at，再按出现顺序）。坏行另报，不抛。 */
export function loadGold(root: string = REPO_ROOT): { rows: GoldRow[]; bad: Array<JsonlBad & { file: string }> } {
  const latest = new Map<string, GoldRow>()
  const bad: Array<JsonlBad & { file: string }> = []
  for (const file of listFiles(join(root, 'data', 'gold'), (n) => n.endsWith('.jsonl'))) {
    const r = readJsonl<GoldRow>(file)
    for (const b of r.bad) bad.push({ ...b, file })
    for (const { value } of r.rows) {
      // 标准答案只收人标的：`by` 是模型的行不读（它们属于 data/model-reference；结构闸另外会报）
      if (!value || typeof value.work_id !== 'string' || !Array.isArray(value.tags) || (typeof value.by === 'string' && value.by.startsWith('model:'))) continue
      const prev = latest.get(value.work_id)
      // 按时刻比（不同时区写法、带不带毫秒都能比对）；解析不了的当最早
      const t = (g: GoldRow) => { const n = Date.parse(String(g.at ?? '')); return Number.isNaN(n) ? -Infinity : n }
      if (!prev || t(value) >= t(prev)) latest.set(value.work_id, value)
    }
  }
  return { rows: [...latest.values()].sort((a, b) => (a.work_id < b.work_id ? -1 : a.work_id > b.work_id ? 1 : 0)), bad }
}

/** 模型参考标注的标注者：`model:<id>` */
export const MODEL_ANNOTATOR = /^model:[a-z0-9][a-z0-9._-]{0,63}$/

/** 模型参考标注的一行：不是人标的。`by` 形如 `model:<id>`，与标准答案（`gh:<数字>`）分开存、分开评 */
export interface ReferenceRow { work_id: string; tags: string[]; by: string; at: string; note?: string | null }

/**
 * 模型参考标注：`data/model-reference/*.jsonl` 全部行，同一个标注者对同一篇取最新一行。坏行另报，不抛。
 * 它们**不是标准答案**：是另一个模型读名片后给的标签，只能说明两个模型有多一致。
 * 只收 `by` 是 `model:<id>` 的行——人的账号写在这里的行直接不读（结构闸另外会报）。
 */
export function loadReference(root: string = REPO_ROOT): { rows: ReferenceRow[]; bad: Array<JsonlBad & { file: string }> } {
  const latest = new Map<string, ReferenceRow>()
  const bad: Array<JsonlBad & { file: string }> = []
  for (const file of listFiles(join(root, 'data', 'model-reference'), (n) => n.endsWith('.jsonl'))) {
    const r = readJsonl<ReferenceRow>(file)
    for (const b of r.bad) bad.push({ ...b, file })
    for (const { value } of r.rows) {
      if (!value || typeof value.work_id !== 'string' || typeof value.by !== 'string' || !MODEL_ANNOTATOR.test(value.by) || !Array.isArray(value.tags)) continue
      const k = `${value.by}\u0000${value.work_id}`
      const prev = latest.get(k)
      const t = (g: ReferenceRow) => { const n = Date.parse(String(g.at ?? '')); return Number.isNaN(n) ? -Infinity : n }
      if (!prev || t(value) >= t(prev)) latest.set(k, value)
    }
  }
  return { rows: [...latest.values()].sort((a, b) => (a.by < b.by ? -1 : a.by > b.by ? 1 : a.work_id < b.work_id ? -1 : a.work_id > b.work_id ? 1 : 0)), bad }
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
  /** 断言分片上限（MB，缺省 20） */
  store?: { max_part_mb?: number }
  /** 贡献包入库：每包最多几篇、每篇最多几个标签（缺省 5000 / 20） */
  import?: { max_items_per_package?: number; max_tags_per_work?: number }
}

export interface FacetVocab {
  facets: Record<string, { label: Record<string, string>; values: string[]; maps_to: 'study_type' | null; locator_required: boolean }>
}

export interface Vocab {
  facets: FacetVocab
  concepts: EvidenceConcept[]
  /** `revision`（可选）：只为让打标签器的版本号变一下——把词表改回与某个旧版本一模一样的内容时，加一才会被当成新的一版 */
  tags: { revision?: number; tags: Record<string, { label: string; aliases: string[] }> }
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
