/**
 * 结构闸（退出码非零即失败，打印清单）：
 *   · 词表：概念 id 唯一、`broader` 无环且深度 ≤ 3、被引概念存在、`deprecated` 必带 `replaced_by`、`facets.design.values` 与引擎 `EVIDENCE_STUDY_DESIGNS` 完全相同；
 *   · JSONL 每行可解析且是对象；断言的 `by.id` 形如 `gh:\d+`、`redacted:<12 hex>` 或模型 id；
 *   · 不存邮箱（正则 `[\w.+-]+@[\w-]+\.[\w.]+` 扫 data/ vocab/ config/ imports/ 与导出）；文件 < 50 MB；名片 `abstract === null`；
 *   · `--export <dir>`：用引擎 `readCommunityExport` 读回并要求 issues 为空，另核对每个分片的 sha256 与字节数；
 *     模型建议旁路文件（`suggestions.json` 与各片）的哈希、条数，并与账本里的模型标签断言对账。
 *   · 受控词表 `vocab/tags.json`：键已归一、显示名归一后等于键、同一个写法不指向两个标签。
 *   · 模型参考标注 `data/model-reference/*.jsonl`：`by` 必须是 `model:<id>`、标签必须在受控词表里（人标的进 `data/gold/`，那里的 `by` 必须是 `gh:<数字>`——两边互不混入）。
 *   · 标准答案 `data/gold/*.jsonl`：作品键、标签数组（每个都能归一）、可选的研究设计（引擎词表内）、`by` 是账号 id；
 *   · `--append-only <git 引用>`：只追加闸——那个提交里的每个断言文件，现在的内容必须以它为字节前缀、文件不能消失。
 *     唯一例外是抹名：同一范围内 `data/REDACTIONS.md` 有新增内容时，允许某行只把 `by.id` 从 `gh:<数字>` 换成 `redacted:<12 hex>`。
 *     引用解析不了：全 0（新分支）⇒ 如实说没比；否则判失败（基准不在历史里，多半是被强推过）。
 * 用法：`pnpm check [--export export/v1] [--append-only <ref>] [--root <dir>]`
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EVIDENCE_STUDY_DESIGNS, EVIDENCE_TRUST_TIERS, normalizeTag, readCommunityExport } from 'scholar-meta'
import type { EvidenceAnnotation, EvidenceConcept } from 'scholar-meta'
import { MODEL_ANNOTATOR, REPO_ROOT, listFiles, loadAssertions, loadBlocklist, loadVocab, loadWorks, paths, readJsonl, sha256 } from './lib/store.js'
import type { GoldRow, ReferenceRow, Vocab, WorkSnapshot } from './lib/store.js'
import { argValue } from './export.js'

export const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/
/** 找第一个像邮箱的片段。只在每个 `@` 两侧的有限窗口里匹配，长文件也是线性时间（整段跑正则在长串单词字符上会平方级回溯） */
export function findEmail(content: string): string | null {
  for (let i = content.indexOf('@'); i >= 0; i = content.indexOf('@', i + 1)) {
    const left = /[\w.+-]+$/.exec(content.slice(Math.max(0, i - 64), i))
    const right = /^[\w-]+\.[\w.]+/.exec(content.slice(i + 1, i + 1 + 255))
    if (left && right) return `${left[0]}@${right[0]}`
  }
  return null
}
export const MAX_FILE_BYTES = 50 * 1024 * 1024
const BY_ID = /^(gh:\d+|redacted:[0-9a-f]{12})$/
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
/** 断言文件只能叫 `data/assertions/<yyyy>/<mm>.jsonl` 或 `<mm>-NNN.jsonl`（别的名字读得到却容易躲过检查） */
const ASSERTION_FILE = /^data\/assertions\/\d{4}\/(0[1-9]|1[0-2])(-\d{3})?\.jsonl$/

export interface Problem { where: string; what: string }

/** 词表检查（纯函数，给测试直接喂概念） */
export function checkConcepts(concepts: readonly EvidenceConcept[]): Problem[] {
  const out: Problem[] = []
  const ids = new Map<string, EvidenceConcept>()
  for (const c of concepts) {
    if (!c || typeof c.id !== 'string') { out.push({ where: 'vocab/concepts', what: 'concept without id' }); continue }
    if (ids.has(c.id)) out.push({ where: c.id, what: 'duplicate concept id' })
    ids.set(c.id, c)
    if (!/^c:[a-z_]+\/[a-z0-9-]+$/.test(c.id)) out.push({ where: c.id, what: 'id should look like c:<facet>/<slug>' })
    if (c.id.split('/')[0] !== `c:${c.facet}`) out.push({ where: c.id, what: `id facet does not match facet field (${c.facet})` })
    if (c.status === 'deprecated' && !c.replaced_by) out.push({ where: c.id, what: 'deprecated concept needs replaced_by' })
    if (c.replaced_by && !concepts.some((x) => x.id === c.replaced_by)) out.push({ where: c.id, what: `replaced_by points to unknown ${c.replaced_by}` })
  }
  for (const c of concepts) {
    for (const b of c.broader ?? []) if (!ids.has(b)) out.push({ where: c.id, what: `broader points to unknown ${b}` })
    // 无环且深度 ≤ 3：沿 broader 走，走到第 4 层或回到自己就报
    const depth = (id: string, seen: string[]): number => {
      if (seen.includes(id)) { out.push({ where: c.id, what: `broader cycle through ${id}` }); return Infinity }
      const node = ids.get(id)
      if (!node || node.broader.length === 0) return 0
      return 1 + Math.max(...node.broader.map((b) => depth(b, [...seen, id])))
    }
    const d = depth(c.id, [])
    if (Number.isFinite(d) && d > 3) out.push({ where: c.id, what: `broader chain deeper than 3 (${d})` })
  }
  return out
}

export function checkFacets(facets: { facets: Record<string, { values: string[] }> }): Problem[] {
  const design = facets.facets.design?.values ?? []
  const same = design.length === EVIDENCE_STUDY_DESIGNS.length && design.every((v, i) => v === EVIDENCE_STUDY_DESIGNS[i])
  return same ? [] : [{ where: 'vocab/facets.json', what: `design.values must equal EVIDENCE_STUDY_DESIGNS exactly (${JSON.stringify(EVIDENCE_STUDY_DESIGNS)})` }]
}

export function checkAnnotation(a: EvidenceAnnotation, where: string): Problem[] {
  const out: Problem[] = []
  if (!a.by || typeof a.by.id !== 'string') { out.push({ where, what: 'assertion without by.id' }); return out }
  if (a.by.kind === 'model') { if (!MODEL_ID.test(a.by.id) || a.by.tier !== 'model' || !a.by.model_version) out.push({ where, what: `model actor needs a model id, tier model and model_version: ${a.by.id}` }) }
  else if (!BY_ID.test(a.by.id)) out.push({ where, what: `by.id must look like gh:<digits> or redacted:<12 hex>: ${a.by.id}` })
  if (!(EVIDENCE_TRUST_TIERS as readonly string[]).includes(a.by.tier)) out.push({ where, what: `unknown tier ${String(a.by.tier)}` })
  if (typeof a.id !== 'string' || !/^a_[0-9a-f]{20}$/.test(a.id)) out.push({ where, what: `bad assertion id ${String(a.id)}` })
  if (typeof a.work_id !== 'string' || !/^(doi|openalex|pmid):/.test(a.work_id)) out.push({ where, what: `bad work_id ${String(a.work_id)}` })
  return out
}

/** 标准答案的一行 */
export function checkGoldRow(g: GoldRow, where: string): Problem[] {
  const out: Problem[] = []
  if (!g || typeof g.work_id !== 'string' || !/^(doi|openalex|pmid):/.test(g.work_id)) { out.push({ where, what: `bad gold work_id ${String(g?.work_id)}` }); return out }
  if (!Array.isArray(g.tags) || g.tags.some((t) => typeof t !== 'string' || normalizeTag(t) === null)) out.push({ where, what: 'gold tags must be an array of valid tags (an empty array means: none of them)' })
  if (g.design !== undefined && g.design !== null && !(EVIDENCE_STUDY_DESIGNS as readonly string[]).includes(g.design)) out.push({ where, what: `gold design not in the engine vocabulary: ${String(g.design)}` })
  if (typeof g.by !== 'string' || !BY_ID.test(g.by)) out.push({ where, what: `gold by must look like gh:<digits>: ${String(g.by)}` })
  if (typeof g.at !== 'string' || Number.isNaN(Date.parse(g.at))) out.push({ where, what: 'gold at must be an ISO time' })
  return out
}

/**
 * 模型参考标注（`data/model-reference/*.jsonl`）的一行。标注者必须是 `model:<id>`——人的账号不许出现在这里，
 * 模型也不许出现在标准答案里，两边互不混入。标签必须在受控词表里（`vocabulary` 是词表的标签键）。
 */
export function checkReferenceRow(r: ReferenceRow, where: string, vocabulary?: ReadonlySet<string>): Problem[] {
  const out: Problem[] = []
  if (!r || typeof r.work_id !== 'string' || !/^(doi|openalex|pmid):/.test(r.work_id)) { out.push({ where, what: `bad model-reference work_id ${String(r?.work_id)}` }); return out }
  if (!Array.isArray(r.tags) || r.tags.some((t) => typeof t !== 'string' || normalizeTag(t) === null)) out.push({ where, what: 'model-reference tags must be an array of valid tags' })
  else if (vocabulary) for (const t of r.tags) if (!vocabulary.has(normalizeTag(t)!)) out.push({ where, what: `model-reference tag is not in vocab/tags.json: ${t}` })
  if (typeof r.by !== 'string' || !MODEL_ANNOTATOR.test(r.by)) out.push({ where, what: `model-reference by must look like model:<id> (human labels belong in data/gold): ${String(r.by)}` })
  if (typeof r.at !== 'string' || Number.isNaN(Date.parse(r.at))) out.push({ where, what: 'model-reference at must be an ISO time' })
  if ('design' in (r as object)) out.push({ where, what: 'model-reference rows carry tags only (no design)' })
  return out
}

/** 读 git 对象（测试可注入）；失败回 null */
export interface GitRead { (args: string[]): Buffer | null }
export const realGitRead = (cwd: string): GitRead => (args) => {
  try { return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1024 * 1024 * 1024 }) } catch { return null }
}

const REDACTED = /^redacted:[0-9a-f]{12}$/
/** 新行是不是旧行的抹名：只有 by.id 从 gh:<数字> 换成 redacted:<12 hex>，其余逐字相同。是则回（旧 id, 新 id） */
export function redactionOf(before: string, after: string): { from: string; to: string } | null {
  try {
    const a = JSON.parse(before) as { by?: { id?: unknown } }
    const b = JSON.parse(after) as { by?: { id?: unknown } }
    if (typeof a.by?.id !== 'string' || typeof b.by?.id !== 'string' || !/^gh:\d+$/.test(a.by.id) || !REDACTED.test(b.by.id)) return null
    const blank = (x: { by?: { id?: unknown } }) => JSON.stringify({ ...x, by: { ...x.by, id: '' } })
    return blank(a) === blank(b) ? { from: a.by.id, to: b.by.id } : null
  } catch { return null }
}
export const isRedactionOf = (before: string, after: string): boolean => redactionOf(before, after) !== null

const byIdOf = (line: string): string | null => {
  try { const id = (JSON.parse(line) as { by?: { id?: unknown } }).by?.id; return typeof id === 'string' ? id : null } catch { return null }
}
/** 按换行切；只去掉文件末尾换行造成的那个空元素（中间的空行算内容，插空行也是改写） */
const linesOf = (bytes: Buffer): string[] => { const out = bytes.toString('utf8').split('\n'); if (out[out.length - 1] === '') out.pop(); return out }

/**
 * 只追加闸：`base` 提交里的每个断言文件，现在必须以它为字节前缀。
 * 抹名例外要整体自洽，否则会改变裁决：一个账号只能换成一个新 id，一个新 id 只对应一个账号、且此前没出现过，
 * 这个账号在全部断言文件里的行都得换掉（不能只换一部分把一个人拆成两个，也不能把两个人并成一个）。
 * `compared: false` 表示没有基准可比（不是通过）；基准给了却解析不了 ⇒ 记一条问题。
 */
export function checkAppendOnly(root: string, base: string, git: GitRead = realGitRead(root)): { compared: boolean; files: number; problems: Problem[] } {
  const ref = base.trim()
  if (!ref || /^0+$/.test(ref)) return { compared: false, files: 0, problems: [] }
  if (git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) === null) {
    return { compared: false, files: 0, problems: [{ where: ref, what: 'append-only base commit is not in this history (was the branch force-pushed?)' }] }
  }
  // -z：文件名原样、以 NUL 分隔（不加的话非 ASCII 名字会被加引号转义，对不上路径）
  const listed = git(['ls-tree', '-r', '-z', '--name-only', ref, '--', 'data/assertions'])
  const files = (listed?.toString('utf8') ?? '').split('\0').filter((l) => l.endsWith('.jsonl'))
  const baseRed = git(['show', `${ref}:data/REDACTIONS.md`])
  const curRedFile = join(root, 'data', 'REDACTIONS.md')
  const curRed = existsSync(curRedFile) ? readFileSync(curRedFile) : Buffer.alloc(0)
  // 声明 ＝ 抹名记录多了至少一行非空内容（只加空白不算）
  const added = baseRed !== null && curRed.length >= baseRed.length && curRed.subarray(0, baseRed.length).equals(baseRed) ? curRed.subarray(baseRed.length).toString('utf8') : baseRed === null ? curRed.toString('utf8') : ''
  const redactionDeclared = added.trim() !== ''
  const problems: Problem[] = []
  const mapping = new Map<string, string>()   // gh id → redacted id
  const reverse = new Map<string, string>()   // redacted id → gh id
  const baseIds = new Set<string>()
  for (const path of files) {
    const before = git(['show', `${ref}:${path}`])
    if (before === null) { problems.push({ where: path, what: 'could not read the base version' }); continue }
    const a = linesOf(before)
    for (const line of a) { const id = byIdOf(line); if (id) baseIds.add(id) }
    const file = join(root, path)
    if (!existsSync(file)) { problems.push({ where: path, what: 'assertion file was deleted (the ledger is append-only)' }); continue }
    const now = readFileSync(file)
    if (now.length >= before.length && now.subarray(0, before.length).equals(before)) continue
    const b = linesOf(now)
    if (b.length < a.length) { problems.push({ where: path, what: `lines were removed (${a.length} → ${b.length}); the ledger is append-only` }); continue }
    let reported = 0
    for (let i = 0; i < a.length && reported < 5; i++) {
      if (a[i] === b[i]) continue
      const r = redactionDeclared ? redactionOf(a[i]!, b[i]!) : null
      if (!r) {
        problems.push({ where: `${path}:${i + 1}`, what: redactionDeclared ? 'line changed beyond a redaction of by.id' : 'existing line was changed (only a redaction recorded in data/REDACTIONS.md may do that)' })
        reported++
        continue
      }
      const to = mapping.get(r.from)
      const from = reverse.get(r.to)
      if ((to !== undefined && to !== r.to) || (from !== undefined && from !== r.from)) {
        problems.push({ where: `${path}:${i + 1}`, what: 'inconsistent redaction: one account must map to exactly one redacted id, and one redacted id to one account' })
        reported++
        continue
      }
      mapping.set(r.from, r.to)
      reverse.set(r.to, r.from)
    }
  }
  if (mapping.size > 0) {
    for (const [from, to] of mapping) if (baseIds.has(to)) problems.push({ where: to, what: `redacted id was already in use before this change (would merge ${from} into another actor)` })
    // 被抹名的账号不能还留着原样的行（新旧文件都算）：拆成两个身份会多出独立票
    const left = new Set<string>()
    for (const file of listFiles(join(root, 'data', 'assertions'), (n) => n.endsWith('.jsonl'))) {
      for (const line of linesOf(readFileSync(file))) { const id = byIdOf(line); if (id && mapping.has(id)) left.add(id) }
    }
    for (const id of left) problems.push({ where: id, what: 'partial redaction: some lines of this account still carry the original id' })
  }
  return { compared: true, files: files.length, problems }
}

/** 词表自身的问题：键必须已归一、显示名归一后等于键、别名能归一、同一个写法不能指向两个标签 */
export function checkTagVocabulary(tags: Vocab['tags']): Problem[] {
  const out: Problem[] = []
  const owner = new Map<string, string>()
  for (const [key, v] of Object.entries(tags.tags)) {
    const where = `vocab/tags.json:${key}`
    if (normalizeTag(key) !== key) out.push({ where, what: 'tag key is not in normalised form' })
    if (!v || typeof v.label !== 'string' || normalizeTag(v.label) !== key) { out.push({ where, what: 'label must normalise to the tag key' }); continue }
    if (!Array.isArray(v.aliases)) { out.push({ where, what: 'aliases must be an array' }); continue }
    for (const raw of [key, ...v.aliases]) {
      const k = typeof raw === 'string' ? normalizeTag(raw) : null
      if (!k) { out.push({ where, what: `alias cannot be normalised: ${String(raw)}` }); continue }
      const prev = owner.get(k)
      if (prev && prev !== key) out.push({ where, what: `"${k}" is also a spelling of "${prev}"` })
      owner.set(k, key)
    }
  }
  return out
}

/** 全仓检查（data / vocab / config） */
export function checkRepo(root: string = REPO_ROOT): Problem[] {
  const out: Problem[] = []
  const p = paths(root)
  const rel = (f: string) => relative(root, f)
  const vocab = loadVocab(root)
  out.push(...checkFacets(vocab.facets), ...checkConcepts(vocab.concepts), ...checkTagVocabulary(vocab.tags))

  const tagKeys = new Set(Object.keys(vocab.tags.tags))
  const dataFiles = [...listFiles(join(root, 'data')), ...listFiles(join(root, 'vocab')), ...listFiles(join(root, 'config')), ...listFiles(join(root, 'imports'))]
  for (const f of dataFiles) {
    const size = statSync(f).size
    if (size >= MAX_FILE_BYTES) out.push({ where: rel(f), what: `file is ${(size / 1024 / 1024).toFixed(1)} MB (limit 50 MB)` })
    const content = readFileSync(f, 'utf8')
    const email = findEmail(content)
    if (email) out.push({ where: rel(f), what: `looks like an email address: ${email.replace(/^(.).*(@.*)$/, '$1…$2')}` })
    if (f.startsWith(p.assertions) && f.endsWith('.jsonl') && !ASSERTION_FILE.test(rel(f).split('\\').join('/'))) out.push({ where: rel(f), what: 'unexpected file under data/assertions (expected <yyyy>/<mm>.jsonl or <yyyy>/<mm>-NNN.jsonl)' })
    if (f.endsWith('.jsonl')) {
      const r = readJsonl(f)
      for (const b of r.bad) out.push({ where: `${rel(f)}:${b.line}`, what: `unparsable JSONL line (${b.error})` })
      if (f.startsWith(p.assertions)) for (const row of r.rows) out.push(...checkAnnotation(row.value as EvidenceAnnotation, `${rel(f)}:${row.line}`))
      if (f.startsWith(join(root, 'data', 'gold'))) for (const row of r.rows) out.push(...checkGoldRow(row.value as GoldRow, `${rel(f)}:${row.line}`))
      if (f.startsWith(join(root, 'data', 'model-reference'))) for (const row of r.rows) out.push(...checkReferenceRow(row.value as ReferenceRow, `${rel(f)}:${row.line}`, tagKeys))
      if (f.startsWith(p.works)) {
        for (const row of r.rows) {
          const w = row.value as WorkSnapshot
          if (w.card && w.card.abstract !== null) out.push({ where: `${rel(f)}:${row.line}`, what: 'card.abstract must be null' })
          if (typeof w.work_id !== 'string') out.push({ where: `${rel(f)}:${row.line}`, what: 'work snapshot without work_id' })
        }
      }
    }
  }
  return out
}

/**
 * 模型建议旁路文件：`suggestions.json` 列的每一片都在、哈希与条数对得上、目录里没有多余的片；
 * 给了仓根就再与账本对账——旁路文件里的建议条数必须等于账本里（模型, 作品, 标签键）的个数（这里另数一遍，不复用导出的代码）。
 */
export function checkSuggestions(dir: string, root?: string): Problem[] {
  const out: Problem[] = []
  const indexFile = join(dir, 'suggestions.json')
  if (!existsSync(indexFile)) return [{ where: 'suggestions.json', what: 'missing (the export always writes it, even when empty)' }]
  let index: { counts?: { works?: number; suggestions?: number }; shards?: Array<{ path: string; works: number; suggestions: number; sha256: string }> }
  try { index = JSON.parse(readFileSync(indexFile, 'utf8')) } catch { return [{ where: 'suggestions.json', what: 'not JSON' }] }
  const listed = new Set<string>()
  let works = 0
  let suggestions = 0
  for (const s of index.shards ?? []) {
    listed.add(s.path)
    const file = join(dir, s.path)
    if (!/^suggestions\/[0-9a-f]+\.jsonl$/.test(s.path) || !existsSync(file)) { out.push({ where: s.path, what: 'suggestion shard listed in suggestions.json is missing' }); continue }
    const bytes = readFileSync(file)
    if (sha256(bytes) !== s.sha256) out.push({ where: s.path, what: 'sha256 does not match suggestions.json' })
    const r = readJsonl<{ work_id?: unknown; models?: unknown }>(file)
    for (const b of r.bad) out.push({ where: `${s.path}:${b.line}`, what: `unparsable JSONL line (${b.error})` })
    let n = 0
    for (const row of r.rows) {
      const models = Array.isArray(row.value?.models) ? (row.value.models as Array<{ id?: unknown; tags?: unknown }>) : null
      if (typeof row.value?.work_id !== 'string' || !models || models.some((m) => typeof m?.id !== 'string' || !Array.isArray(m.tags))) { out.push({ where: `${s.path}:${row.line}`, what: 'bad suggestion row' }); continue }
      for (const m of models) n += (m.tags as unknown[]).length
    }
    if (r.rows.length !== s.works) out.push({ where: s.path, what: `works ${r.rows.length} ≠ suggestions.json ${s.works}` })
    if (n !== s.suggestions) out.push({ where: s.path, what: `suggestions ${n} ≠ suggestions.json ${s.suggestions}` })
    works += r.rows.length
    suggestions += n
  }
  for (const f of listFiles(join(dir, 'suggestions'))) {
    const rel = `suggestions/${relative(join(dir, 'suggestions'), f).split('\\').join('/')}`
    if (!listed.has(rel)) out.push({ where: rel, what: 'file is not listed in suggestions.json' })
  }
  if (works !== index.counts?.works) out.push({ where: 'suggestions.json', what: `counts.works ${index.counts?.works} ≠ ${works} rows in shards` })
  if (suggestions !== index.counts?.suggestions) out.push({ where: 'suggestions.json', what: `counts.suggestions ${index.counts?.suggestions} ≠ ${suggestions} in shards` })
  if (root) {
    // 另数一遍「当前生效的模型建议」：每个（模型, 作品）上，贡献包的行只算最后写进来的那一组（版本与回答指纹相同的），其他来源的行都算；数不同的标签键
    const blocked = new Set(loadBlocklist(root))
    const alias = new Map<string, string>()
    const snapshots = [...loadWorks(root).values()]
    for (const w of snapshots) alias.set(w.work_id, w.work_id)
    for (const w of snapshots) for (const k of w.aliases) if (!alias.has(k)) alias.set(k, w.work_id)
    const groups = new Map<string, EvidenceAnnotation[]>()
    for (const a of loadAssertions(root).assertions) {
      if (a.by?.kind !== 'model' || a.kind !== 'tag' || a.op !== 'add' || a.payload?.kind !== 'tag' || !a.subject.startsWith('tag:') || blocked.has(a.by.id)) continue
      const g = `${a.by.id}\u0000${alias.get(a.work_id) ?? a.work_id}`
      groups.set(g, [...(groups.get(g) ?? []), a])
    }
    let expected = 0
    const answer = (a: EvidenceAnnotation) => /(?:^|;)answer=([0-9a-f]{12})(?:;|$)/.exec(a.note ?? '')?.[1] ?? null
    for (const list of groups.values()) {
      const imported = list.filter((a) => a.source?.form === 'import/1')
      // loadAssertions 已按时间与 id 排好序：最后一条就是最后写进来的那一组的成员
      const last = imported[imported.length - 1]
      const current = (a: EvidenceAnnotation) => !!last && (a.by.model_version ?? null) === (last.by.model_version ?? null) && answer(a) === answer(last)
      expected += new Set(list.filter((a) => a.source?.form !== 'import/1' || current(a)).map((a) => a.subject)).size
    }
    if (expected !== suggestions) out.push({ where: 'suggestions.json', what: `ledger has ${expected} current model tag suggestions, the export shows ${suggestions}` })
  }
  return out
}

/** 导出目录：读回零问题 + 分片哈希对得上 + 模型建议旁路文件对得上（给了仓根就与账本对账） */
export function checkExport(dir: string, root?: string): Problem[] {
  const out: Problem[] = []
  const manifestFile = join(dir, 'manifest.json')
  if (!existsSync(manifestFile)) return [{ where: dir, what: 'manifest.json missing' }]
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { shards?: Array<{ path: string; bytes: number; sha256: string; works: number }> }
  const shards: unknown[] = []
  for (const s of manifest.shards ?? []) {
    const file = join(dir, s.path)
    if (!existsSync(file)) { out.push({ where: s.path, what: 'shard listed in manifest is missing' }); continue }
    const bytes = readFileSync(file)
    if (bytes.length !== s.bytes) out.push({ where: s.path, what: `bytes ${bytes.length} ≠ manifest ${s.bytes}` })
    if (sha256(bytes) !== s.sha256) out.push({ where: s.path, what: 'sha256 does not match manifest' })
    const r = readJsonl(file)
    for (const b of r.bad) out.push({ where: `${s.path}:${b.line}`, what: `unparsable JSONL line (${b.error})` })
    if (r.rows.length !== s.works) out.push({ where: s.path, what: `works ${r.rows.length} ≠ manifest ${s.works}` })
    shards.push(r.rows.map((x) => x.value))
  }
  const extra = (name: string): unknown => { const f = join(dir, name); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : undefined }
  const read = readCommunityExport(manifest, shards, { bindings: extra('bindings.json'), concepts: extra('concepts.json'), frames: extra('frames.json') })
  for (const i of read.issues) out.push({ where: `export:${i.path}`, what: i.code })
  if (!read.ok) out.push({ where: 'export', what: 'readCommunityExport refused the manifest' })
  out.push(...checkSuggestions(dir, root))
  for (const f of listFiles(dir)) {
    if (findEmail(readFileSync(f, 'utf8'))) out.push({ where: relative(dir, f), what: 'looks like an email address' })
  }
  return out
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const root = argValue(argv, '--root') ? resolve(argValue(argv, '--root')!) : REPO_ROOT
  const problems = checkRepo(root)
  const exportDir = argValue(argv, '--export')
  if (exportDir) problems.push(...checkExport(resolve(root, exportDir), root))
  const base = argValue(argv, '--append-only')
  let appendNote = ''
  if (base !== undefined && base !== null) {
    const r = checkAppendOnly(root, base)
    problems.push(...r.problems)
    appendNote = r.compared ? `；只追加：与 ${base.slice(0, 12)} 比过 ${r.files} 个断言文件` : r.problems.length === 0 ? '；只追加：没有基准可比（这次没比，不是通过）' : ''
  }
  if (problems.length > 0) {
    console.error(`❌ ${problems.length} 个问题：`)
    for (const p of problems) console.error(`  - ${p.where}: ${p.what}`)
    return 1
  }
  console.log(`✅ 结构闸通过${exportDir ? `（含导出 ${exportDir} 读回零问题）` : ''}${appendNote}`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code }, (e) => { console.error(e); process.exitCode = 1 })
}
