/**
 * 批量入口：把 `imports/*.json` 里的贡献包（引擎的 `EvidenceTagContribution`：一个模型给一批论文打的标签）写成模型层断言。
 * ─────────────────────────────────────────────────────────────────────────────
 * 校验全部交给引擎 `validateTagContribution`（与单篇建议同一套清洗：归一、置信门槛、去重、上限）；这里只管「文件在哪、写到哪」。
 *   · 模型层永不计票：这些断言目前只作质量评估的对象（`pnpm evaluate`），不进导出分片、页面上还不显示。要计票的断言只能经 issue、按账号进来。
 *   · 幂等：同一个模型对同一篇的同一个标签键只记一条——同一包重跑、换版本重报、换大小写写法重报，都不会多写一行。
 *   · 文件名只用字母、数字、`.`、`_`、`-`；模型 id 不能占用仓里已有的非贡献包模型（样本脚本用的那些）；版本不许有控制字符。
 *   · 整包不成形（不是 JSON、没有合法的模型 id 与版本）⇒ 这一包整个拒绝；包里个别条目坏的逐条报、其余照常入库。
 *   · 名片：`--cards <n>` 时给还没有快照的作品问 OpenAlex，最多 n 篇；问不成就先不存（外部源失败 ≠ 没有这篇），下次再补。
 * 用法：`pnpm bulk [--dry-run] [--cards <n>] [--root <dir>]`。`--dry-run` 只验不写（PR 的检查用），有整包被拒时退出码 1。
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseWorkRef, validateTagContribution } from 'scholar-meta'
import type { EvidenceAnnotation } from 'scholar-meta'
import { createOpenAlex } from './lib/openalex.js'
import type { OpenAlex } from './lib/openalex.js'
import { REPO_ROOT, annotationId, appendAssertions, appendWork, findWork, listFiles, loadAssertions, loadConfig, loadWorks } from './lib/store.js'
import type { WorkSnapshot } from './lib/store.js'
import { argValue } from './export.js'

/** 模型 id 的形状（与结构闸对模型断言的要求一致） */
export const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
export const IMPORT_FORM = 'import/1'
/** 贡献包的文件名（会写进断言的 note，所以不许有 `@`、空格之类） */
export const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.json$/

export interface PackageReport {
  file: string
  /** 整包被拒的原因；通过为 null */
  refused: 'bad_file_name' | 'not_json' | 'not_an_object' | 'bad_tagger' | 'bad_model_id' | 'reserved_model_id' | null
  tagger: { id: string; version: string } | null
  works: number
  suggestions: number
  /** 新写（或 dry-run 时将要写）的断言数 */
  added: number
  /** 账本里已经有的 */
  existing: number
  /** 逐条问题（坏作品键、重复作品、没有合法标签、条目超上限） */
  issues: Array<{ code: string; index: number | null }>
  dropped: { invalid: number; out_of_vocabulary: number; below_threshold: number; over_limit: number }
}

export interface ImportDeps {
  root?: string
  dry?: boolean
  now?: () => Date
  /** 给没有快照的作品补名片：最多几篇（缺省 0 ＝ 不出网） */
  cards?: number
  openalex?: OpenAlex | null
  log?: (s: string) => void
}

export async function runImport(deps: ImportDeps = {}): Promise<{ packages: PackageReport[]; added: number; cards: number; files: string[] }> {
  const root = deps.root ?? REPO_ROOT
  const log = deps.log ?? ((s: string) => console.log(s))
  const now = (deps.now ?? (() => new Date()))()
  const config = loadConfig(root)
  const maxItems = config.import?.max_items_per_package ?? 5000
  const maxTags = config.import?.max_tags_per_work ?? 20
  const ledger = loadAssertions(root).assertions
  const existing = new Set(ledger.map((a) => a.id))
  // 幂等按（模型, 作品, 标签键）判，不按 id：id 里含标签的写法，「adhd」与「ADHD」会是两个 id
  const slot = (model: string, work: string, subject: string) => `${model}\u0000${work}\u0000${subject}`
  const taken = new Set(ledger.filter((a) => a.by.kind === 'model' && a.kind === 'tag' && a.op === 'add').map((a) => slot(a.by.id, a.work_id, a.subject)))
  // 仓里已有、但不是贡献包写进来的模型 id（样本脚本的那些）不许被贡献包冒用——否则质量表会把两者算成一个模型
  const reserved = new Set(ledger.filter((a) => a.by.kind === 'model' && a.source?.form !== IMPORT_FORM).map((a) => a.by.id))
  const packages: PackageReport[] = []
  const fresh: EvidenceAnnotation[] = []
  const touchedWorks = new Set<string>()
  let seq = 0

  for (const file of listFiles(join(root, 'imports'), (n) => n.endsWith('.json'))) {
    const name = basename(file)
    const report: PackageReport = { file: `imports/${name}`, refused: null, tagger: null, works: 0, suggestions: 0, added: 0, existing: 0, issues: [], dropped: { invalid: 0, out_of_vocabulary: 0, below_threshold: 0, over_limit: 0 } }
    packages.push(report)
    if (!FILE_NAME.test(name)) { report.refused = 'bad_file_name'; continue }
    let raw: unknown
    try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch { report.refused = 'not_json'; continue }
    // 词表开放（null）：平台不限定标签，归一与别名在裁决与页面那一层处理
    const v = validateTagContribution(raw, { vocabulary: null, minConfidence: config.model_min_confidence, maxItems, maxTags })
    report.issues = v.issues.map((i) => ({ code: i.code, index: i.index }))
    report.dropped = v.dropped
    if (!v.tagger) { report.refused = v.issues[0]?.code === 'bad_tagger' ? 'bad_tagger' : 'not_an_object'; continue }
    if (!MODEL_ID.test(v.tagger.id)) { report.refused = 'bad_model_id'; continue }
    if (reserved.has(v.tagger.id)) { report.refused = 'reserved_model_id'; continue }
    // 引擎只要求版本非空且不超过 64 个字符；这里再拒掉控制字符（会原样进日志与账本）
    if (/[\u0000-\u001f\u007f]/.test(v.tagger.version)) { report.refused = 'bad_tagger'; continue }
    report.tagger = v.tagger
    report.works = v.items.length
    for (const item of v.items) {
      // 平台只认 doi / openalex / pmid 三种作品键
      if (!/^(doi|openalex|pmid):/.test(item.work_id)) { report.issues.push({ code: 'unsupported_work_id', index: null }); report.works--; continue }
      // 包里提到的作品都记下来补名片（不只是这次有新断言的）：上次没问成的，这次接着补
      touchedWorks.add(item.work_id)
      for (const s of item.suggestions) {
        report.suggestions++
        const base = {
          work_id: item.work_id, kind: 'tag' as const, op: 'add' as const, subject: `tag:${s.tag_key}`,
          by: { kind: 'model' as const, id: v.tagger.id, tier: 'model' as const, model_version: v.tagger.version },
          payload: { kind: 'tag' as const, tag: s.label }, source: { form: IMPORT_FORM },
        }
        const id = annotationId(base)
        const key = slot(v.tagger.id, item.work_id, base.subject)
        if (existing.has(id) || taken.has(key)) { report.existing++; continue }
        existing.add(id)
        taken.add(key)
        report.added++
        // 同一次运行里时间严格递增（毫秒），排序稳定
        const at = new Date(now.getTime() + seq++).toISOString()
        fresh.push({ id, at, ...base, note: s.confidence === null ? `import:${name}` : `import:${name};confidence=${s.confidence}`, supersedes: null })
      }
    }
  }

  const files: string[] = []
  let cards = 0
  if (!deps.dry) {
    // 分批写，让分片上限按批生效（一批约 2000 行）
    for (let i = 0; i < fresh.length; i += 2000) {
      const f = appendAssertions(fresh.slice(i, i + 2000), now, root)
      if (f && !files.includes(f)) files.push(f)
    }
    const want = Math.max(0, Math.floor(deps.cards ?? 0))
    if (want > 0 && deps.openalex) {
      const works = loadWorks(root)
      for (const workId of [...touchedWorks].sort()) {
        if (cards >= want) break
        if (findWork(works, workId)) continue
        const ref = parseWorkRef(workId)
        if (!ref) continue
        const r = await deps.openalex.fetchCard(ref)
        if (r.kind === 'error') { log(`⚠️ 名片没问成（${workId}），先不存；下次再补`); continue }
        const c = r.kind === 'found' ? r.card : null
        const aliases = c ? [c.id, c.doi ? `doi:${c.doi}` : null, c.pmid ? `pmid:${c.pmid}` : null].filter((k): k is string => !!k && k !== workId) : []
        const snapshot: WorkSnapshot = { work_id: workId, aliases: [...new Set(aliases)].sort(), card: c, snapshot_at: now.toISOString(), snapshot_source: 'openalex' }
        const f = appendWork(snapshot, root)
        works.set(workId, snapshot)
        if (!files.includes(f)) files.push(f)
        cards++
      }
    }
  }
  for (const p of packages) {
    log(p.refused
      ? `❌ ${p.file}：整包拒绝（${p.refused}）`
      : `${p.file}：模型 ${p.tagger!.id}@${p.tagger!.version} · ${p.works} 篇 · ${p.suggestions} 条建议 · ${deps.dry ? '将新增' : '新增'} ${p.added} · 已有 ${p.existing} · 逐条问题 ${p.issues.length} · 丢弃 ${Object.values(p.dropped).reduce((a, b) => a + b, 0)}`)
  }
  if (packages.length === 0) log('imports/ 里没有贡献包')
  return { packages, added: fresh.length, cards, files }
}

export async function main(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const root = argValue(argv, '--root') ?? REPO_ROOT
  const dry = argv.includes('--dry-run')
  const cards = Number(argValue(argv, '--cards') ?? 0)
  const r = await runImport({
    root, dry, cards: Number.isFinite(cards) ? cards : 0,
    openalex: cards > 0 ? createOpenAlex({ apiKey: env.OPENALEX_API_KEY, log: (m, d) => console.error(m, d) }) : null,
  })
  if (env.GITHUB_OUTPUT && existsSync(env.GITHUB_OUTPUT)) {
    const { appendFileSync } = await import('node:fs')
    appendFileSync(env.GITHUB_OUTPUT, `changed=${r.files.length > 0 ? 'true' : 'false'}\n`)
  }
  return dry && r.packages.some((p) => p.refused) ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code }, (e) => { console.error(e); process.exitCode = 1 })
}
