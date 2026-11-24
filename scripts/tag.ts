/**
 * 批量打标签：仓里存着的名片 + 受控词表 → 贡献包（`imports/*.json`），由 `import` 工作流写成模型层断言。
 * ─────────────────────────────────────────────────────────────────────────────
 * 打标签器是引擎的 `createVocabularyTagger`（整词匹配），词表是 `vocab/tags.json`。它只读名片里存着的字段：
 *   · 标题；关键词与主题词表词（OpenAlex keywords、MeSH）；主主题名（次要主题太杂，不读）；摘要不存，所以不读。
 * 所以任何人克隆仓库就能重算出同一个包——`--check` 就是这么核的。
 *   · 模型 id 固定为 `smt-vocabulary`；版本 ＝ `r<规则版本>-<词表、所钉引擎、置信门槛、标签上限的哈希前 12 位>`。
 *   · 包按作品键排序，一个文件最多 `config.import.max_items_per_package` 篇，多了分 `-002`、`-003`；包里另记 `untagged`
 *     （考虑过、但没打出标签的作品）。重算只用包考虑过的那些作品的名片，所以之后别的流程新存名片不会让旧包对不上。
 *   · `imports/` 里的包是模型**当前**的回答：重新出包时旧文件被换掉（旧回答已经在账本里）。改词表、换引擎、改门槛之后，
 *     要在同一个提交里重新出包——否则可复现检查不过。
 *   · 模型层永不计票：这些标签只作建议（作品页标明「模型建议、不计票」）与质量评估的对象。
 * 三个动作：
 *   `pnpm tag --harvest <n>`  先取名片：`config/seeds.json` 每个主题从今年往回、每年取被引最高的一页（≤ 200 篇），凑够 n 篇，没有快照的写 `data/works/`；
 *                             外部索引中途没问成 ⇒ 已取到的保留、打印警告并记到运行输出里（不把「没问成」当「没有」）。
 *   `pnpm tag [--min-works <n>]`  出包；打出标签的作品少于 n ⇒ 不写文件、退出码 1。
 *   `pnpm tag --check`  可复现检查：`imports/` 里本模型的包必须与从仓里重算出来的那一套逐文件、逐字节相同，否则退出码 1。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildTagContribution, createVocabularyTagger, runTagger } from 'scholar-meta'
import type { EvidenceTagContribution, EvidenceTaggerInput, VocabularyEntry } from 'scholar-meta'
import { createOpenAlex } from './lib/openalex.js'
import type { OpenAlex } from './lib/openalex.js'
import { REPO_ROOT, appendWork, canonical, listFiles, loadConfig, loadVocab, loadWorks, paths, readJson, sha256 } from './lib/store.js'
import type { Vocab, WorkSnapshot } from './lib/store.js'
import { snapshotOf } from './sample.js'
import type { Seeds } from './sample.js'
import { argValue } from './export.js'

export const TAGGER_ID = 'smt-vocabulary'
/** 「读名片的哪些字段」这条规则的版本：改 `taggerInputOf` 就加一（版本号随之变，旧包不再参与重算） */
export const TAGGER_RULES = 1

/** 词表 → 打标签器的词条（按键排序）。标签用显示名（归一后就是键），别名里带上键本身 */
export function vocabularyEntries(tags: Vocab['tags']): VocabularyEntry[] {
  return Object.entries(tags.tags).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, v]) => ({ tag: v.label, aliases: [key, ...v.aliases] }))
}

/** 本仓钉的引擎（`package.json` 里 scholar-meta 的那一行）：匹配规则在引擎里，引擎一换，同一份词表打出来的也可能不同 */
export const enginePin = (): string => String(readJson<{ dependencies?: Record<string, string> }>(join(REPO_ROOT, 'package.json')).dependencies?.['scholar-meta'] ?? '')

export interface TaggerParams { minConfidence: number; maxTags: number; engine?: string; revision?: number }

/**
 * 版本号：词表内容、所钉的引擎、置信门槛、每篇标签上限，任何一样变了都是新版本。`revision` 是词表文件里可选的那个数，
 * 只为在内容完全一样时也能换一版。（答案变了却没换版本也不要紧：入库按回答指纹比，变了的那一篇会整组重写。）
 */
export const taggerVersion = (entries: readonly VocabularyEntry[], p: TaggerParams): string =>
  `r${TAGGER_RULES}-${sha256(canonical({ entries, engine: p.engine ?? enginePin(), min: p.minConfidence, max: p.maxTags, ...(p.revision ? { revision: p.revision } : {}) })).slice(0, 12)}`

/** 名片快照 → 打标签器的输入（只用仓里存着的字段；没有名片或没有标题 ⇒ null） */
export function taggerInputOf(snapshot: WorkSnapshot): EvidenceTaggerInput | null {
  const c = snapshot.card
  if (!c || typeof c.title !== 'string' || !c.title.trim()) return null
  const primary = c.topics[0]?.display_name
  return { work_id: snapshot.work_id, title: c.title, keywords: [...c.keywords, ...c.mesh], topics: primary ? [primary] : [], language: c.language }
}

export interface TagRun {
  tagger: { id: string; version: string }
  /** 有名片可打的作品数 */
  works: number
  /** 打出至少一个标签的作品（按作品键排序） */
  items: EvidenceTagContribution['items']
  /** 打过、但一个标签都没打出来的作品键（排序）。包里也记着：它们同样是「考虑过的」 */
  untagged: string[]
  suggestions: number
}

/** 给一批名片打标签（纯函数，除了打标签器是异步接口）。`only` 给了就只打这些作品键 */
export async function tagWorks(works: ReadonlyMap<string, WorkSnapshot>, tags: Vocab['tags'], opts: { minConfidence: number; maxTags: number; only?: ReadonlySet<string> }): Promise<TagRun> {
  const entries = vocabularyEntries(tags)
  const tagger = createVocabularyTagger({ entries, id: TAGGER_ID, version: taggerVersion(entries, { minConfidence: opts.minConfidence, maxTags: opts.maxTags, revision: typeof tags.revision === 'number' ? tags.revision : 0 }) })
  const results: Array<{ work_id: string; suggestions: NonNullable<Awaited<ReturnType<typeof runTagger>>>['suggestions'] }> = []
  const untagged: string[] = []
  let n = 0
  for (const workId of [...works.keys()].sort()) {
    if (opts.only && !opts.only.has(workId)) continue
    const input = taggerInputOf(works.get(workId)!)
    if (!input) continue
    n++
    const r = await runTagger(tagger, input, { minConfidence: opts.minConfidence, maxTags: opts.maxTags })
    if (r && r.suggestions.length > 0) results.push({ work_id: workId, suggestions: r.suggestions })
    else untagged.push(workId)
  }
  const pkg = buildTagContribution({ id: tagger.id, version: tagger.version }, results)
  return { tagger: pkg.tagger, works: n, items: pkg.items, untagged, suggestions: pkg.items.reduce((s, i) => s + i.tags.length, 0) }
}

/**
 * 包文件：引擎的贡献包再加一个 `untagged`（考虑过、但没打出标签的作品键；引擎验形时不看它）。
 * 「包里的条目 + untagged」就是这套包考虑过的全部作品：重算只用这些作品的名片，所以之后别的流程新存名片不会让旧包对不上；
 * 把一篇从条目挪进 untagged 也藏不住（重算会给它打出标签）。
 * 已知边界：把一篇从包里**整条**拿掉，它就与「出包之后才存的名片」无法区分——检查不判不一致，只计入「没考虑过」的数。
 */
export type PackageFile = EvidenceTagContribution & { untagged: string[] }

/** 包文件的字节：一篇一行，方便看差异；内容只由词表、参数与考虑过的那些名片决定（不带时间） */
export function serializePackage(pkg: PackageFile): string {
  const head = JSON.stringify({ contract: pkg.contract, tagger: pkg.tagger, untagged: pkg.untagged })
  return `${head.slice(0, -1)},"items":[\n${pkg.items.map((i) => JSON.stringify(i)).join(',\n')}\n]}\n`
}

export const packageName = (version: string, part: number) => `${TAGGER_ID}-${version}-${String(part).padStart(3, '0')}.json`
/** `imports/` 里属于本模型的包文件名：只认 `pnpm tag` 生成的那种形状。本模型的 id 只有这些文件能用（见 import.ts 与 `checkPackages`） */
export const isOwnPackage = (name: string) => name.startsWith(`${TAGGER_ID}-`) && /^-r\d+-[0-9a-f]{12}-\d{3}\.json$/.test(name.slice(TAGGER_ID.length))

/**
 * 这个仓现在应该有的包：文件名 → 字节。`only` 不给就打仓里全部有名片的作品。
 * 一个文件最多 `config.import.max_items_per_package` 篇，按作品键排序后切；`untagged` 记在第一个文件里。
 */
export async function expectedPackages(root: string, only?: ReadonlySet<string>): Promise<{ run: TagRun; files: Map<string, string> }> {
  const config = loadConfig(root)
  const run = await tagWorks(loadWorks(root), loadVocab(root).tags, { minConfidence: config.model_min_confidence, maxTags: config.import?.max_tags_per_work ?? 20, ...(only ? { only } : {}) })
  const perFile = Math.max(1, config.import?.max_items_per_package ?? 5000)
  const files = new Map<string, string>()
  const parts = Math.max(1, Math.ceil(run.items.length / perFile))
  if (run.items.length + run.untagged.length > 0) {
    for (let part = 1; part <= parts; part++) {
      files.set(packageName(run.tagger.version, part), serializePackage({
        ...buildTagContribution(run.tagger, []), untagged: part === 1 ? run.untagged : [], items: run.items.slice((part - 1) * perFile, part * perFile),
      }))
    }
  }
  return { run, files }
}

/** 宽松地读一个包文件（不是 JSON、不是对象 ⇒ null；那种文件由贡献包验形去报） */
function parsePackage(text: string): { tagger?: { id?: unknown }; untagged?: unknown; items?: unknown } | null {
  try { const v: unknown = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? (v as { tagger?: { id?: unknown } }) : null } catch { return null }
}

/** `imports/` 这一层的文件名（不进子目录） */
const topLevel = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort() : [])

export interface TagDeps { root?: string; minWorks?: number; log?: (s: string) => void }

/**
 * 出包：把 `imports/` 里本模型的包换成现在应该有的那一套（内容没变的文件不动；不再需要的旧文件删掉——
 * `imports/` 里的包是模型当前的回答，旧回答已经在账本里）。篇数不够 ⇒ `ok: false`、什么都不动。
 */
export async function runTag(deps: TagDeps = {}): Promise<{ ok: boolean; run: TagRun; files: string[]; written: number; removed: string[] }> {
  const root = deps.root ?? REPO_ROOT
  const log = deps.log ?? ((s: string) => console.log(s))
  const { run, files } = await expectedPackages(root)
  const min = Math.max(0, Math.floor(deps.minWorks ?? 0))
  if (run.items.length < min) {
    log(`❌ 打出标签的作品只有 ${run.items.length} 篇，少于门槛 ${min}：不写贡献包`)
    return { ok: false, run, files: [], written: 0, removed: [] }
  }
  const dir = join(root, 'imports')
  let written = 0
  if (files.size > 0) mkdirSync(dir, { recursive: true })
  for (const [name, text] of files) {
    const file = join(dir, name)
    if (existsSync(file) && readFileSync(file, 'utf8') === text) continue
    writeFileSync(file, text, 'utf8')
    written++
  }
  const removed = topLevel(dir).filter((name) => isOwnPackage(name) && !files.has(name))
  for (const name of removed) rmSync(join(dir, name))
  log(`打标签：模型 ${run.tagger.id}@${run.tagger.version} · ${run.works} 篇有名片 · ${run.items.length} 篇打出标签 · ${run.suggestions} 条建议 · ${files.size} 个包（改写 ${written} 个${removed.length ? `，拿走旧包 ${removed.length} 个` : ''}）`)
  return { ok: true, run, files: [...files.keys()].map((n) => `imports/${n}`), written, removed }
}

export interface TagCheck {
  /** 逐字节核过的包 */
  checked: string[]
  /** 仓里有名片、但这套包没考虑过的作品数（出包之后才存的；不是问题，运行 `pnpm tag` 就会打上） */
  newer: number
  problems: Array<{ where: string; what: string }>
}

/**
 * 可复现检查：`imports/` 里本模型的包，必须与「用仓里的词表、参数，对这套包考虑过的那些作品（条目 + `untagged`）重算出来的那一套」
 * **逐文件、逐字节相同**——多一个文件、少一个文件、改一个标签、加一篇、版本不是当前的，都不过。
 * 别的文件用本模型的 id（前后带空白也算）不过；`imports/` 的子目录里有 `.json` 也不过（包只放在这一层）。
 * 没有本模型的包 ⇒ 没有可核的，如实说。
 */
export async function checkPackages(root: string = REPO_ROOT): Promise<TagCheck> {
  const out: TagCheck = { checked: [], newer: 0, problems: [] }
  const dir = join(root, 'imports')
  for (const f of listFiles(dir, (n) => n.endsWith('.json'))) {
    const rel = relative(dir, f).split('\\').join('/')
    if (rel.includes('/')) out.problems.push({ where: `imports/${rel}`, what: 'packages must sit directly in imports/ (no subdirectories)' })
  }
  const own = new Map<string, string>()
  const considered = new Set<string>()
  for (const name of topLevel(dir).filter((n) => n.endsWith('.json'))) {
    const text = readFileSync(join(dir, name), 'utf8')
    const pkg = parsePackage(text)
    // 与入库时同样地看模型 id：引擎验形会去掉前后空白
    const claims = pkg !== null && typeof pkg.tagger?.id === 'string' && pkg.tagger.id.trim() === TAGGER_ID
    if (!isOwnPackage(name)) {
      if (claims) out.problems.push({ where: `imports/${name}`, what: `uses the model id ${TAGGER_ID} but is not one of its generated files` })
      continue
    }
    own.set(name, text)
    if (!claims || !Array.isArray(pkg!.untagged) || !Array.isArray(pkg!.items)) { out.problems.push({ where: `imports/${name}`, what: 'not a package generated by pnpm tag (model id, untagged or items missing)' }); continue }
    for (const id of pkg!.untagged as unknown[]) if (typeof id === 'string') considered.add(id)
    for (const item of pkg!.items as Array<{ work_id?: unknown }>) if (item && typeof item.work_id === 'string') considered.add(item.work_id)
  }
  if (own.size === 0 || out.problems.length > 0) return out
  const expected = await expectedPackages(root, considered)
  for (const [name, text] of own) {
    out.checked.push(`imports/${name}`)
    const want = expected.files.get(name)
    if (want === undefined) { out.problems.push({ where: `imports/${name}`, what: `not a current package (current version is ${expected.run.tagger.version}); run pnpm tag` }); continue }
    if (want === text) continue
    // 指出第一处不同的那一行（一篇一行）
    const a = text.split('\n')
    const b = want.split('\n')
    const line = a.findIndex((l, i) => l !== b[i])
    const sample = (a[line] ?? b[line] ?? '').slice(0, 80)
    out.problems.push({ where: `imports/${name}:${(line < 0 ? Math.min(a.length, b.length) : line) + 1}`, what: `differs from the package recomputed from the repository (${a.length - 3} items here, ${b.length - 3} recomputed): ${sample}` })
  }
  for (const name of expected.files.keys()) if (!own.has(name)) out.problems.push({ where: `imports/${name}`, what: 'missing: recomputing from the repository produces this file' })
  out.newer = [...loadWorks(root).values()].filter((w) => taggerInputOf(w) !== null && !considered.has(w.work_id)).length
  return out
}

export interface HarvestDeps { root?: string; openalex: OpenAlex; perTopic: number; now?: () => Date; log?: (s: string) => void }

/** 取名片：每个种子主题从今年往回、每年取被引最高的一页，凑够 `perTopic` 篇；没有快照的写进 `data/works/`。中途没问成 ⇒ `complete: false`，已取到的保留 */
export async function runHarvest(deps: HarvestDeps): Promise<{ complete: boolean; seen: number; added: number; pages: number }> {
  const root = deps.root ?? REPO_ROOT
  const log = deps.log ?? ((s: string) => console.log(s))
  const now = (deps.now ?? (() => new Date()))()
  const at = now.toISOString()
  const seeds = readJson<Seeds & { _comment?: string }>(paths(root).seeds)
  const works = loadWorks(root)
  const known = new Set<string>()
  for (const w of works.values()) { known.add(w.work_id); for (const a of w.aliases) known.add(a) }
  let complete = true
  let seen = 0
  let added = 0
  let pages = 0
  for (const topic of seeds.topics) {
    const tid = topic.id.replace(/^openalex:/, '')
    const r = await deps.openalex.harvestCards(`primary_topic.id:${tid}${seeds.filters ? `,${seeds.filters}` : ''}`, deps.perTopic, now.getUTCFullYear())
    pages += r.pages
    for (const card of r.cards) {
      // 期刊封面、目录之类的记录不是论文
      if (card.publication_type === 'paratext') continue
      const s = snapshotOf(card, at)
      if (!s) continue
      seen++
      if (known.has(s.work_id) || s.aliases.some((a) => known.has(a))) continue
      appendWork(s, root)
      known.add(s.work_id)
      for (const a of s.aliases) known.add(a)
      added++
    }
    if (!r.complete) {
      complete = false
      log(`⚠️ 外部索引没问成（${topic.id}，已取 ${r.pages} 页）：已经取到的名片保留；这次没取完，不代表后面没有（外部源失败 ≠ 没有数据）`)
    }
  }
  log(`取名片：见到 ${seen} 篇 · 新存 ${added} 张名片 · ${pages} 页${complete ? '' : ' · 没取完'}`)
  return { complete, seen, added, pages }
}

export async function main(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const root = argValue(argv, '--root') ?? REPO_ROOT
  const output = (line: string) => { if (env.GITHUB_OUTPUT && existsSync(env.GITHUB_OUTPUT)) appendFileSync(env.GITHUB_OUTPUT, `${line}\n`) }
  if (argv.includes('--check')) {
    const r = await checkPackages(root)
    for (const p of r.problems.slice(0, 20)) console.error(`❌ ${p.where}：${p.what}`)
    if (r.problems.length > 20) console.error(`… 另有 ${r.problems.length - 20} 处`)
    console.log(r.checked.length === 0 && r.problems.length === 0
      ? `可复现检查：imports/ 里没有 ${TAGGER_ID} 的包，没有可核的`
      : `可复现检查：${r.checked.length} 个包与从仓里重算的逐字节比 · ${r.problems.length} 处不一致${r.newer ? ` · 另有 ${r.newer} 张名片这套包没考虑过，还没打（运行 pnpm tag）` : ''}`)
    return r.problems.length > 0 ? 1 : 0
  }
  const harvest = argValue(argv, '--harvest')
  if (harvest !== undefined) {
    const n = Number(harvest)
    if (!/^\d+$/.test(harvest) || n <= 0) { console.error('--harvest 要一个正整数（每个种子主题取几篇）'); return 2 }
    const h = await runHarvest({ root, perTopic: n, openalex: createOpenAlex({ apiKey: env.OPENALEX_API_KEY, log: (m, d) => console.error(m, d) }) })
    output(`harvest_complete=${h.complete ? 'true' : 'false'}`)
    if (!h.complete && env.GITHUB_ACTIONS) console.log('::warning title=取名片没取完::外部索引中途没问成，已取到的名片保留；见上面的日志')
  }
  const minArg = argValue(argv, '--min-works')
  if (minArg !== undefined && !/^\d+$/.test(minArg)) { console.error('--min-works 要一个非负整数'); return 2 }
  const r = await runTag({ root, minWorks: minArg === undefined ? 0 : Number(minArg) })
  output(`tagged_works=${r.run.items.length}`)
  output(`suggestions=${r.run.suggestions}`)
  return r.ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code }, (e) => { console.error(e); process.exitCode = 1 })
}
