/**
 * 批量入口：把 `imports/*.json` 里的贡献包（引擎的 `EvidenceTagContribution`：一个模型给一批论文打的标签）写成模型层断言。
 * ─────────────────────────────────────────────────────────────────────────────
 * 校验全部交给引擎 `validateTagContribution`（与单篇建议同一套清洗：归一、置信门槛、去重、上限）；这里只管「文件在哪、写到哪」。
 *   · 模型层永不计票：这些断言不进裁决、不进导出的作品分片；它们出现在导出的旁路文件 `suggestions/`（作品页标明「模型建议、不计票」）
 *     与质量评估里（`pnpm evaluate`）。要计票的断言只能经 issue、按账号进来。
 *   · **`imports/` 里的包就是每个模型当前的回答，账本记历史。** 包里的一条是模型对一篇的完整回答，入库时整组写进来；
 *     每个（模型, 作品）只有最后写进来的那一组生效（`currentModelTags`）。入库时拿包里的回答与账本里当前生效的那一组比
 *     （回答指纹：标签键与置信度）：一样 ⇒ 一行不写（同一包重跑、换大小写写法重报、换了版本但这一篇的回答没变，都不写）；
 *     不一样 ⇒ 整组写进来，旧的行留在账本里不动。所以答案变了、改回从前的答案，都会生效。模型对某篇不再回答时旧的那组仍留着（不能撤回）。
 *   · 同一个模型不许有两个包回答同一篇（否则两个回答每天轮流生效；作品键按名片的别名认同一篇）：后一个包整包拒绝。
 *   · 包只放在 `imports/` 这一层；本仓打标签器的模型 id 只有它自己生成的文件能用。
 *   · 文件名只用字母、数字、`.`、`_`、`-`；模型 id 不能占用仓里已有的非贡献包模型（样本脚本用的那些）；版本不许有控制字符。
 *   · 整包不成形（不是 JSON、没有合法的模型 id 与版本）⇒ 这一包整个拒绝，并且这次运行什么都不写、退出码 1（坏包留在 `imports/` 里
 *     会让每次运行都报警，直到有人把它拿走）；包里个别条目坏的逐条报、其余照常入库。
 *   · 名片：`--cards <n>` 时给还没有快照的作品问 OpenAlex，最多 n 篇；问不成就先不存（外部源失败 ≠ 没有这篇），下次再补。
 * 用法：`pnpm bulk [--dry-run] [--cards <n>] [--root <dir>]`。`--dry-run` 只验不写（PR 的检查与写入前的自检用）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseWorkRef, validateTagContribution } from 'scholar-meta'
import type { EvidenceAnnotation } from 'scholar-meta'
import { createOpenAlex } from './lib/openalex.js'
import type { OpenAlex } from './lib/openalex.js'
import { REPO_ROOT, annotationId, appendAssertions, appendWork, canonical, findWork, listFiles, loadAssertions, loadConfig, loadWorks, sha256 } from './lib/store.js'
import type { WorkSnapshot } from './lib/store.js'
import { argValue } from './export.js'
import { IMPORT_FORM, answerOfNote, workCanon } from './lib/export-core.js'
import { TAGGER_ID, isOwnPackage } from './tag.js'

export { IMPORT_FORM }

/** 模型 id 的形状（与结构闸对模型断言的要求一致） */
export const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
/** 贡献包的文件名（会写进断言的 note，所以不许有 `@`、空格之类） */
export const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.json$/

export interface PackageReport {
  file: string
  /** 整包被拒的原因；通过为 null */
  refused: 'bad_file_name' | 'not_json' | 'not_an_object' | 'bad_tagger' | 'bad_model_id' | 'reserved_model_id' | 'overlapping_package' | null
  tagger: { id: string; version: string } | null
  works: number
  suggestions: number
  /** 新写（或 dry-run 时将要写）的断言数 */
  added: number
  /** 已经是账本里当前生效的那一组、不用再写的建议数 */
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
  // 账本里每个（模型, 作品）当前生效的那一组回答：最后写进来的贡献包断言的（版本, 回答指纹）。loadAssertions 已按时间排好序
  // 作品键先按名片的别名换成同一个：同一篇用 doi 与 openalex 两种键出现，算同一篇
  const canon = workCanon(loadWorks(root))
  const group = (model: string, work: string) => `${model}\u0000${canon(work)}`
  const current = new Map<string, { version: string; answer: string | null }>()
  // 同一个（模型, 版本, 作品, 标签键）写过几次：并进断言 id，同一组被重新写一遍时 id 不重
  const slot = (model: string, version: string, work: string, subject: string) => `${model}\u0000${version}\u0000${work}\u0000${subject}`
  const written = new Map<string, number>()
  let lastAt = 0
  for (const a of ledger) {
    const t = Date.parse(a.at)
    if (Number.isFinite(t) && t > lastAt) lastAt = t
    if (a.by.kind !== 'model' || a.kind !== 'tag' || a.op !== 'add' || a.source?.form !== IMPORT_FORM) continue
    current.set(group(a.by.id, a.work_id), { version: a.by.model_version ?? '', answer: answerOfNote(a.note) })
    const k = slot(a.by.id, a.by.model_version ?? '', a.work_id, a.subject)
    written.set(k, (written.get(k) ?? 0) + 1)
  }
  // 仓里已有、但不是贡献包写进来的模型 id（样本脚本的那些）不许被贡献包冒用——否则质量表会把两者算成一个模型
  const reserved = new Set(ledger.filter((a) => a.by.kind === 'model' && a.source?.form !== IMPORT_FORM).map((a) => a.by.id))
  const packages: PackageReport[] = []
  const fresh: EvidenceAnnotation[] = []
  const touchedWorks = new Set<string>()

  // 第一遍：逐包验形。`imports/` 里的包就是每个模型当前的回答，所以同一个模型不许有两个包回答同一篇
  type Checked = { name: string; report: PackageReport; tagger: { id: string; version: string }; items: ReturnType<typeof validateTagContribution>['items'] }
  const good: Checked[] = []
  const answered = new Map<string, string>()
  const importsDir = join(root, 'imports')
  for (const file of listFiles(importsDir, (n) => n.endsWith('.json'))) {
    const name = basename(file)
    const rel = relative(importsDir, file).split('\\').join('/')
    const report: PackageReport = { file: `imports/${rel}`, refused: null, tagger: null, works: 0, suggestions: 0, added: 0, existing: 0, issues: [], dropped: { invalid: 0, out_of_vocabulary: 0, below_threshold: 0, over_limit: 0 } }
    packages.push(report)
    // 包只放在 imports/ 这一层：子目录里的同名文件会让「按文件名认包」的检查看走眼
    if (rel !== name || !FILE_NAME.test(name)) { report.refused = 'bad_file_name'; continue }
    let raw: unknown
    try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch { report.refused = 'not_json'; continue }
    // 词表开放（null）：平台不限定标签，归一与别名在裁决与页面那一层处理
    const v = validateTagContribution(raw, { vocabulary: null, minConfidence: config.model_min_confidence, maxItems, maxTags })
    report.issues = v.issues.map((i) => ({ code: i.code, index: i.index }))
    report.dropped = v.dropped
    if (!v.tagger) { report.refused = v.issues[0]?.code === 'bad_tagger' ? 'bad_tagger' : 'not_an_object'; continue }
    if (!MODEL_ID.test(v.tagger.id)) { report.refused = 'bad_model_id'; continue }
    if (reserved.has(v.tagger.id)) { report.refused = 'reserved_model_id'; continue }
    // 本仓打标签器的 id 只给它自己生成的文件用（那些文件要过可复现检查）；别的文件用这个 id 就是冒用
    if (v.tagger.id === TAGGER_ID && !isOwnPackage(name)) { report.refused = 'reserved_model_id'; continue }
    // 引擎只要求版本非空且不超过 64 个字符；这里再拒掉控制字符（会原样进日志与账本）
    if (/[\u0000-\u001f\u007f]/.test(v.tagger.version)) { report.refused = 'bad_tagger'; continue }
    report.tagger = v.tagger
    // 平台只认 doi / openalex / pmid 三种作品键
    const items = v.items.filter((item) => {
      if (/^(doi|openalex|pmid):/.test(item.work_id)) return true
      report.issues.push({ code: 'unsupported_work_id', index: null })
      return false
    })
    const clash = items.find((item) => answered.has(group(v.tagger!.id, item.work_id)))
    if (clash) { report.refused = 'overlapping_package'; report.issues.push({ code: `overlaps ${answered.get(group(v.tagger.id, clash.work_id))}`, index: null }); continue }
    for (const item of items) answered.set(group(v.tagger.id, item.work_id), report.file)
    report.works = items.length
    good.push({ name, report, tagger: v.tagger, items })
  }

  // 第二遍：与账本里当前生效的那一组比。一样 ⇒ 不写；不一样（新版本、同版本但答案变了、被别的回答盖过之后又改回来）⇒ 整组写进来
  // 时间严格递增（毫秒），并且排在账本里已有的每一条之后：这一次写的一定是「最后写进来的」
  let clock = Math.max(now.getTime(), lastAt + 1)
  for (const { name, report, tagger, items } of good) {
    for (const item of items) {
      // 包里提到的作品都记下来补名片（不只是这次有新断言的）：上次没问成的，这次接着补
      touchedWorks.add(item.work_id)
      report.suggestions += item.suggestions.length
      const answer = sha256(canonical(item.suggestions.map((s) => [s.tag_key, s.confidence]).sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : 1)))).slice(0, 12)
      // 只比回答，不比版本：换了版本而这一篇的回答没变，就一行不写（改一个词条不该把一万多行重写一遍）；
      // 这一篇上标的版本因此是「第一次给出现在这个回答的那个版本」
      const cur = current.get(group(tagger.id, item.work_id))
      if (cur && cur.answer === answer) { report.existing += item.suggestions.length; continue }
      current.set(group(tagger.id, item.work_id), { version: tagger.version, answer })
      for (const s of item.suggestions) {
        const base = {
          work_id: item.work_id, kind: 'tag' as const, op: 'add' as const, subject: `tag:${s.tag_key}`,
          by: { kind: 'model' as const, id: tagger.id, tier: 'model' as const, model_version: tagger.version },
          payload: { kind: 'tag' as const, tag: s.label }, source: { form: IMPORT_FORM },
        }
        // 断言 id 的算法不含版本与次数；这里并进去算：同一个标签在两个版本下、或同一组被重新写一遍，都是不同的断言
        const k = slot(tagger.id, tagger.version, item.work_id, base.subject)
        const n = written.get(k) ?? 0
        let id = annotationId({ ...base, by: { ...base.by, id: `${tagger.id}@${tagger.version}#${n}` } })
        for (let bump = n + 1; existing.has(id); bump++) id = annotationId({ ...base, by: { ...base.by, id: `${tagger.id}@${tagger.version}#${bump}` } })
        written.set(k, n + 1)
        existing.add(id)
        report.added++
        fresh.push({ id, at: new Date(clock++).toISOString(), ...base, note: `import:${name}${s.confidence === null ? '' : `;confidence=${s.confidence}`};answer=${answer}`, supersedes: null })
      }
    }
  }

  const files: string[] = []
  let cards = 0
  const refusedAny = packages.some((p) => p.refused)
  if (!deps.dry && !refusedAny) {
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
      : `${p.file}：模型 ${p.tagger!.id}@${p.tagger!.version} · ${p.works} 篇 · ${p.suggestions} 条建议 · ${deps.dry ? '将新增' : refusedAny ? '有包被拒、这次没写；本来会新增' : '新增'} ${p.added} · 已有 ${p.existing} · 逐条问题 ${p.issues.length} · 丢弃 ${Object.values(p.dropped).reduce((a, b) => a + b, 0)}`)
  }
  if (packages.length === 0) log('imports/ 里没有贡献包')
  // 有整包被拒时这次什么都没写：added 如实为 0（各包报告里的 added 仍是「本来会写几条」）
  return { packages, added: !deps.dry && refusedAny ? 0 : fresh.length, cards, files }
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
  return r.packages.some((p) => p.refused) ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code }, (e) => { console.error(e); process.exitCode = 1 })
}
