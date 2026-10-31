/**
 * 结构闸（退出码非零即失败，打印清单）：
 *   · 词表：概念 id 唯一、`broader` 无环且深度 ≤ 3、被引概念存在、`deprecated` 必带 `replaced_by`、`facets.design.values` 与引擎 `EVIDENCE_STUDY_DESIGNS` 完全相同；
 *   · JSONL 每行可解析且是对象；断言的 `by.id` 形如 `gh:\d+`、`redacted:<12 hex>` 或模型 id；
 *   · 不存邮箱（正则 `[\w.+-]+@[\w-]+\.[\w.]+` 扫 data/ vocab/ config/ 与导出）；文件 < 50 MB；名片 `abstract === null`；
 *   · `--export <dir>`：用引擎 `readCommunityExport` 读回并要求 issues 为空，另核对每个分片的 sha256 与字节数。
 * 用法：`pnpm check [--export export/v1] [--root <dir>]`
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EVIDENCE_STUDY_DESIGNS, EVIDENCE_TRUST_TIERS, readCommunityExport } from 'scholar-meta'
import type { EvidenceAnnotation, EvidenceConcept } from 'scholar-meta'
import { REPO_ROOT, listFiles, loadVocab, paths, readJsonl, sha256 } from './lib/store.js'
import type { WorkSnapshot } from './lib/store.js'
import { argValue } from './export.js'

export const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/
export const MAX_FILE_BYTES = 50 * 1024 * 1024
const BY_ID = /^(gh:\d+|redacted:[0-9a-f]{12})$/
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/

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

/** 全仓检查（data / vocab / config） */
export function checkRepo(root: string = REPO_ROOT): Problem[] {
  const out: Problem[] = []
  const p = paths(root)
  const rel = (f: string) => relative(root, f)
  const vocab = loadVocab(root)
  out.push(...checkFacets(vocab.facets), ...checkConcepts(vocab.concepts))

  const dataFiles = [...listFiles(join(root, 'data')), ...listFiles(join(root, 'vocab')), ...listFiles(join(root, 'config'))]
  for (const f of dataFiles) {
    const size = statSync(f).size
    if (size >= MAX_FILE_BYTES) out.push({ where: rel(f), what: `file is ${(size / 1024 / 1024).toFixed(1)} MB (limit 50 MB)` })
    const content = readFileSync(f, 'utf8')
    const m = EMAIL.exec(content)
    if (m) out.push({ where: rel(f), what: `looks like an email address: ${m[0].replace(/^(.).*(@.*)$/, '$1…$2')}` })
    if (f.endsWith('.jsonl')) {
      const r = readJsonl(f)
      for (const b of r.bad) out.push({ where: `${rel(f)}:${b.line}`, what: `unparsable JSONL line (${b.error})` })
      if (f.startsWith(p.assertions)) for (const row of r.rows) out.push(...checkAnnotation(row.value as EvidenceAnnotation, `${rel(f)}:${row.line}`))
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

/** 导出目录：读回零问题 + 分片哈希对得上 */
export function checkExport(dir: string): Problem[] {
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
  for (const f of listFiles(dir)) {
    const m = EMAIL.exec(readFileSync(f, 'utf8'))
    if (m) out.push({ where: relative(dir, f), what: 'looks like an email address' })
  }
  return out
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const root = argValue(argv, '--root') ? resolve(argValue(argv, '--root')!) : REPO_ROOT
  const problems = checkRepo(root)
  const exportDir = argValue(argv, '--export')
  if (exportDir) problems.push(...checkExport(resolve(root, exportDir)))
  if (problems.length > 0) {
    console.error(`❌ ${problems.length} 个问题：`)
    for (const p of problems) console.error(`  - ${p.where}: ${p.what}`)
    return 1
  }
  console.log(`✅ 结构闸通过${exportDir ? `（含导出 ${exportDir} 读回零问题）` : ''}`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code }, (e) => { console.error(e); process.exitCode = 1 })
}
