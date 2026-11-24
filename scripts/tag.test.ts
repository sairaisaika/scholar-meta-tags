/**
 * 批量打标签管道：
 *   ① 受控词表自身的检查（键已归一、显示名对得上键、同一写法不指向两个标签）；
 *   ② 按年份取名片：每年一页（只用首页列表请求）、重试、中途没问成时已取到的照样交回；
 *   ③ 取名片 → 出包 → 可复现检查 → 入库 → 导出 → 建议旁路文件：重跑不变、篇数门槛、包被改动能被发现、词表一改是新版本；
 *   ④ 当前生效的模型建议：贡献包只算最新版本那一组、样本逐键累积、别名并到同一篇、黑名单；旁路文件被改动 / 与账本对不上能被发现；
 *   ⑤ 社区裁决对标准答案；没有裁决时如实是「没有」。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { EvidenceAnnotation, EvidenceCommunityWork, EvidenceWorkCard } from 'scholar-meta'
import { checkExport, checkRepo, checkSuggestions, checkTagVocabulary } from './check.js'
import { runExport } from './export.js'
import { runImport } from './import.js'
import { IMPORT_FORM, answerOfNote, buildSuggestions, confidenceOfNote, currentModelTags } from './lib/export-core.js'
import { HARVEST_MAX_YEARS, PAGE_ATTEMPTS, createOpenAlex } from './lib/openalex.js'
import { evaluateQuality } from './lib/quality-core.js'
import { appendWork, loadAssertions, loadGold, loadReference, loadVocab, loadWorks, readJson, writeJson } from './lib/store.js'
import { main as evaluateMain } from './evaluate.js'
import { card, fakeOpenAlex, makeTempRepo } from './lib/test-fixtures.js'
import { TAGGER_ID, checkPackages, main as tagMain, packageName, runHarvest, runTag, taggerInputOf, taggerVersion, vocabularyEntries } from './tag.js'

const AT = '2026-11-23T00:00:00.000Z'
const paper = (n: number, over: Partial<EvidenceWorkCard> = {}): EvidenceWorkCard => ({
  ...card, id: `openalex:W${9000 + n}`, doi: `10.1000/t.${n}`, pmid: null, title: `Paper ${n} about methylphenidate in children`, keywords: ['Working memory'], mesh: ['Child'], ...over,
})
const raw = (c: EvidenceWorkCard) => ({
  id: `https://openalex.org/${c.id!.slice(9)}`, doi: `https://doi.org/${c.doi}`, title: c.title, publication_year: c.year, type: 'article',
  topics: [{ id: 'https://openalex.org/T10537', display_name: 'Attention Deficit Hyperactivity Disorder' }], keywords: c.keywords.map((k) => ({ display_name: k })),
})

test('① 受控词表：仓里的词表没有问题；键没归一、显示名对不上、一个写法指向两个标签都报', () => {
  assert.deepEqual(checkTagVocabulary(loadVocab().tags), [])
  assert.ok(Object.keys(loadVocab().tags.tags).length >= 50)
  const bad = checkTagVocabulary({ tags: {
    'Not-Normal': { label: 'Not-Normal', aliases: [] },
    'sleep': { label: 'Sleeping', aliases: ['insomnia'] },
    'insomnia': { label: 'Insomnia', aliases: [] },
    'adhd': { label: 'ADHD', aliases: ['Insomnia'] },
  } })
  assert.ok(bad.some((p) => p.what.includes('not in normalised form')))
  assert.ok(bad.some((p) => p.where.endsWith(':sleep') && p.what.includes('label must normalise')))
  assert.ok(bad.some((p) => p.what.includes('also a spelling of')))
  // 打标签器的词条：按键排序，标签用显示名，别名里带键
  const e = vocabularyEntries({ tags: { 'b tag': { label: 'B-tag', aliases: ['bee'] }, 'a': { label: 'A', aliases: [] } } })
  assert.deepEqual(e, [{ tag: 'A', aliases: ['a'] }, { tag: 'B-tag', aliases: ['b tag', 'bee'] }])
  // 版本随词表、所钉的引擎、置信门槛、标签上限变；revision 让内容一样时也能换一版（不写或写 0 等于没有）
  const base = { engine: 'x', minConfidence: 0.5, maxTags: 20 }
  const v = taggerVersion(e, base)
  assert.match(v, /^r1-[0-9a-f]{12}$/)
  assert.equal(taggerVersion(e, { ...base, revision: 0 }), v)
  for (const other of [{ ...base, engine: 'y' }, { ...base, minConfidence: 0.8 }, { ...base, maxTags: 5 }, { ...base, revision: 1 }]) assert.notEqual(taggerVersion(e, other), v)
  assert.notEqual(taggerVersion([...e, { tag: 'C', aliases: [] }], base), v)
})

test('② 按年份取名片：从今年往回、每年一页，凑够为止；某一年重试后成功；一直不成就交回已取到的并说没取完；不无限翻', async () => {
  const byYear: Record<string, unknown[]> = { 2026: [raw(paper(1)), raw(paper(2))], 2025: [raw(paper(3)), raw(paper(2))], 2024: [raw(paper(4)), {}], 2023: [raw(paper(5))] }
  const calls: string[] = []
  const urls: string[] = []
  const logged: Array<Record<string, unknown>> = []
  let failures = 0
  const make = (failOn: string | null, times: number) => createOpenAlex({
    sleep: async () => {},
    log: (_m, d) => logged.push(d),
    fetch: (async (url: string) => {
      urls.push(url)
      const year = /publication_year%3A(\d{4})/.exec(url)![1]!
      calls.push(year)
      if (year === failOn && failures < times) { failures++; return { ok: false, status: 401, text: async () => `denied ${'x'.repeat(400)}`, json: async () => ({}) } }
      return { ok: true, status: 200, json: async () => ({ results: byYear[year] ?? [] }) }
    }) as never,
  })
  // 只要 4 篇：翻到 2024 就够了（2025 里重复的那一篇不重复算）
  const some = await make(null, 0).harvestCards('primary_topic.id:T1', 4, 2026)
  assert.deepEqual([some.cards.length, some.complete, some.pages, calls], [4, true, 3, ['2026', '2025', '2024']])
  assert.ok(some.cards.every((c) => c.abstract === null))
  // 请求的样子：原过滤条件保留、再加年份；被引从高到低；一页 200；不用游标
  assert.ok(urls.every((u) => u.includes(`filter=${encodeURIComponent('primary_topic.id:T1,publication_year:')}`) && u.includes('sort=cited_by_count:desc') && u.includes('per_page=200') && !u.includes('cursor=')), urls[0])
  // 要的比有的多：往回翻满上限年数就停，如实是「就这么多」
  calls.length = 0
  const all = await make(null, 0).harvestCards('x', 100, 2026)
  assert.deepEqual([all.cards.length, all.complete, calls.length], [5, true, HARVEST_MAX_YEARS])
  // 2025 先失败一次，重试成功
  failures = 0
  const retried = await make('2025', 1).harvestCards('x', 4, 2026)
  assert.deepEqual([retried.cards.length, retried.complete], [4, true])
  // 2025 一直失败：交回 2026 的两篇，complete 为 false
  failures = 0
  const broken = await make('2025', PAGE_ATTEMPTS).harvestCards('x', 4, 2026)
  assert.deepEqual([broken.cards.length, broken.complete, broken.pages], [2, false, 1])
  // 对方的错误说明进了日志（截到 200 个字符），日志里没有请求地址
  const denied = logged.filter((d) => d.status === 401)
  assert.equal(denied.length, 1 + PAGE_ATTEMPTS)
  assert.ok(denied.every((d) => typeof d.detail === 'string' && d.detail.startsWith('denied') && d.detail.length === 200 && !JSON.stringify(d).includes('http')))
})

test('③ 取名片 → 出包 → 可复现检查 → 入库 → 导出：重跑不变；篇数门槛；包被动过、被冒用、少一篇都能发现；词表一改旧包换掉', async () => {
  const root = makeTempRepo()
  const cards = [paper(1), paper(2, { title: 'A randomised controlled trial of atomoxetine', keywords: [], mesh: ['Adult'] }), paper(3, { title: 'Untaggable title', keywords: [], mesh: [], topics: [] }),
    { ...paper(4), publication_type: 'paratext' }, paper(5, { doi: null, id: null })]
  const base = fakeOpenAlex('found', cards)
  const asked: Array<[string, number, number]> = []
  const h = await runHarvest({ root, openalex: { ...base, harvestCards: async (f, n, y) => { asked.push([f, n, y]); return base.harvestCards(f, n, y) } }, perTopic: 10, now: () => new Date(AT), log: () => {} })
  assert.deepEqual([h.complete, h.seen, h.added], [true, 3, 3]) // 期刊封面与没有作品键的不算
  assert.deepEqual(asked, [['primary_topic.id:T10537,has_doi:true,is_retracted:false', 10, 2026]]) // 种子主题 + 配置里的过滤条件，从今年往回
  assert.equal(loadWorks(root).size, 3)
  assert.equal((await runHarvest({ root, openalex: fakeOpenAlex('found', cards), perTopic: 10, now: () => new Date(AT), log: () => {} })).added, 0)
  // 外部索引没问成：已取到的那一篇保留，如实说没取完；已有的名片不动
  const partial = await runHarvest({ root, openalex: fakeOpenAlex('error', [paper(6)]), perTopic: 10, now: () => new Date(AT), log: () => {} })
  assert.deepEqual([partial.complete, partial.added, loadWorks(root).size], [false, 1, 4])

  // 输入只用仓里存着的字段：关键词 + 主题词表词、主主题、标题；没有摘要
  const input = taggerInputOf(loadWorks(root).get('doi:10.1000/t.1')!)!
  assert.deepEqual([input.keywords, input.topics, 'abstract' in input], [['Working memory', 'Child'], ['Attention Deficit Hyperactivity Disorder'], false])

  // 没有包：没有可核的；参数不是数字：拒绝
  assert.deepEqual(await checkPackages(root), { checked: [], newer: 0, problems: [] })
  assert.equal(await tagMain(['--min-works', 'abc', '--root', root], {}), 2)
  assert.equal(await tagMain(['--harvest', '-3', '--root', root], {}), 2)
  // 篇数门槛：不够就不写
  const low = await runTag({ root, minWorks: 99, log: () => {} })
  assert.deepEqual([low.ok, existsSync(join(root, 'imports'))], [false, false])
  const first = await runTag({ root, minWorks: 3, log: () => {} })
  assert.deepEqual([first.ok, first.run.works, first.run.items.length, first.files.length, first.written], [true, 4, 3, 1, 1]) // 第 3 篇什么都没打出来，不进包
  const file = join(root, first.files[0]!)
  assert.equal(first.files[0], `imports/${packageName(first.run.tagger.version, 1)}`)
  const bytes = readFileSync(file, 'utf8')
  const pkg = JSON.parse(bytes) as { untagged: string[]; tagger: { id: string }; items: Array<{ work_id: string; tags: Array<{ tag: string; confidence: number; rationale: string }> }> }
  assert.deepEqual([pkg.tagger.id, pkg.untagged], [TAGGER_ID, ['doi:10.1000/t.3']]) // 考虑过但没打出标签的那一篇记在包里
  assert.deepEqual(pkg.items.map((i) => i.work_id), [...pkg.items.map((i) => i.work_id)].sort())
  const t1 = pkg.items.find((i) => i.work_id === 'doi:10.1000/t.1')!
  assert.deepEqual(t1.tags.map((t) => t.tag).sort(), ['ADHD', 'Children', 'Methylphenidate', 'Working memory'])
  assert.ok(t1.tags.find((t) => t.tag === 'Methylphenidate')!.rationale.includes('title'))
  // 重跑：一个字节都不变，不改写文件
  const second = await runTag({ root, log: () => {} })
  assert.deepEqual([second.written, second.removed, readFileSync(file, 'utf8') === bytes], [0, [], true])

  // 可复现检查通过；结构闸与贡献包验形通过
  assert.deepEqual(await checkPackages(root), { checked: [first.files[0]], newer: 0, problems: [] })
  assert.deepEqual(checkRepo(root), [])
  assert.equal(await tagMain(['--check', '--root', root], {}), 0)
  const problems = async () => (await checkPackages(root)).problems.map((p) => p.what)
  // 包里的一个标签被人改了 ⇒ 抓到
  writeFileSync(file, bytes.replace('"tag":"Methylphenidate"', '"tag":"Atomoxetine"'))
  assert.ok((await problems()).some((w) => w.includes('differs from the package recomputed')))
  assert.equal(await tagMain(['--check', '--root', root], {}), 1)
  // 整条拿掉一篇：它就成了「这套包没考虑过的名片」，与出包之后才存的名片无法区分——不判不一致，但如实计数（已知边界，写在文档里）
  writeFileSync(file, bytes.split('\n').filter((l) => !l.includes('"doi:10.1000/t.1"')).join('\n').replace(/,\n\]\}/, '\n]}'))
  assert.deepEqual([(await checkPackages(root)).problems.length, (await checkPackages(root)).newer], [0, 1])
  // 多了一篇仓里没有名片的 ⇒ 抓到
  writeFileSync(file, bytes.replace('"items":[\n', '"items":[\n{"work_id":"doi:10.1000/ghost","tags":[{"tag":"ADHD","confidence":0.9,"rationale":null}]},\n'))
  assert.ok((await problems()).some((w) => w.includes('differs from the package recomputed')))
  // 把拿掉的那一篇挪进 untagged 想藏住 ⇒ 重算会给它打出标签，照样抓到
  const hidden = bytes.split('\n').filter((l) => !l.includes('"doi:10.1000/t.1"')).join('\n').replace(/,\n\]\}/, '\n]}').replace('"untagged":["doi:10.1000/t.3"]', '"untagged":["doi:10.1000/t.1","doi:10.1000/t.3"]')
  writeFileSync(file, hidden)
  assert.ok((await problems()).some((w) => w.includes('differs from the package recomputed')))
  writeFileSync(file, bytes)
  // 别的文件冒用本模型的 id（版本随便写、标签手写；id 后面带个空格也算）⇒ 可复现检查抓到，入库也整包拒绝、什么都不写
  const forged = join(root, 'imports', 'someone.json')
  for (const fakeId of [TAGGER_ID, `${TAGGER_ID} `]) {
    writeFileSync(forged, JSON.stringify({ contract: '0.6.2', tagger: { id: fakeId, version: 'whatever' }, items: [{ work_id: 'doi:10.1000/t.9', tags: [{ tag: 'Spam', confidence: 1 }] }] }))
    assert.ok((await problems()).some((w) => w.includes('uses the model id')), fakeId)
    const refusedRun = await runImport({ root, now: () => new Date(AT), log: () => {} })
    assert.deepEqual([refusedRun.added, refusedRun.packages.find((p) => p.file === 'imports/someone.json')!.refused, loadAssertions(root).assertions.length], [0, 'reserved_model_id', 0])
  }
  rmSync(forged)
  // 放进子目录想躲开按文件名认包 ⇒ 检查与入库都不认
  mkdirSync(join(root, 'imports', 'zz'), { recursive: true })
  writeFileSync(join(root, 'imports', 'zz', packageName(first.run.tagger.version, 1)), bytes)
  assert.ok((await problems()).some((w) => w.includes('no subdirectories')))
  assert.equal((await runImport({ root, dry: true, now: () => new Date(AT), log: () => {} })).packages.find((p) => p.file.startsWith('imports/zz/'))!.refused, 'bad_file_name')
  rmSync(join(root, 'imports', 'zz'), { recursive: true })
  // 名字像本模型、但不是它生成的那种形状的文件：出包时不会被当成旧包删掉
  writeFileSync(join(root, 'imports', `${TAGGER_ID}-extra-001.json`), JSON.stringify({ contract: '0.6.2', tagger: { id: 'another-model', version: '1' }, items: [] }))
  assert.deepEqual((await runTag({ root, log: () => {} })).removed, [])
  rmSync(join(root, 'imports', `${TAGGER_ID}-extra-001.json`))
  const stale = join(root, 'imports', packageName('r1-000000000000', 1))
  writeFileSync(stale, bytes)
  assert.ok((await problems()).some((w) => w.includes('not a current package')))
  rmSync(stale)
  assert.deepEqual(await problems(), [])
  // 出包之后别的流程又存了新名片（存入时刻比包早也一样）：旧包照样对得上（重算只用包考虑过的作品），只提示有几张还没打
  appendWork({ ...loadWorks(root).get('doi:10.1000/t.2')!, work_id: 'doi:10.1000/t.late', aliases: [], snapshot_at: '2020-01-01T00:00:00.000Z' }, root)
  const later = await checkPackages(root)
  assert.deepEqual([later.problems.length, later.newer], [0, 1])

  // 入库：模型层、带版本、置信度与回答指纹；重跑幂等
  const imported = await runImport({ root, now: () => new Date(AT), log: () => {} })
  assert.equal(imported.added, first.run.suggestions)
  assert.equal((await runImport({ root, now: () => new Date('2026-11-24T00:00:00Z'), log: () => {} })).added, 0)
  const rows = loadAssertions(root).assertions
  assert.ok(rows.every((a) => a.by.kind === 'model' && a.by.tier === 'model' && a.by.id === TAGGER_ID && a.source.form === IMPORT_FORM && /;answer=[0-9a-f]{12}$/.test(a.note ?? '')))
  // 导出：作品分片里没有模型标签；旁路文件里有，条数与账本对得上
  const out = runExport({ root, out: 'export/v1', now: new Date(AT), sourceCommit: 'x', repository: '', maintainers: [] })
  assert.deepEqual(out.issues, [])
  assert.deepEqual(out.files.suggestions.index.counts, { works: 3, suggestions: first.run.suggestions, models: { [TAGGER_ID]: first.run.suggestions } })
  assert.deepEqual(checkExport(out.outDir, root), [])
  const row = [...out.files.suggestions.shards.values()].flat().find((r) => r.work_id === 'doi:10.1000/t.1')!
  assert.deepEqual([row.models[0]!.id, row.models[0]!.version, row.models[0]!.tags.find((t) => t.tag_key === 'methylphenidate')], [TAGGER_ID, first.run.tagger.version, { tag_key: 'methylphenidate', label: 'Methylphenidate', confidence: 0.7 }])

  // 词表一改就是新版本：旧包对不上了（要在同一个提交里重新出包）；重新出包后旧文件被换掉
  const vocabFile = join(root, 'vocab', 'tags.json')
  const original = readFileSync(vocabFile, 'utf8')
  const vocab = readJson<{ tags: Record<string, { label: string; aliases: string[] }> }>(vocabFile)
  delete vocab.tags['working memory']
  writeJson(vocabFile, vocab)
  assert.ok((await problems()).some((w) => w.includes('not a current package')))
  const third = await runTag({ root, log: () => {} })
  assert.notEqual(third.run.tagger.version, first.run.tagger.version)
  assert.deepEqual([third.removed, readdirSync(join(root, 'imports'))], [[packageName(first.run.tagger.version, 1)], [packageName(third.run.tagger.version, 1)]])
  assert.deepEqual(await problems(), [])
  // 新版本入库：只有回答变了的那些篇整组重写（Working memory 退场，账本里旧行还在）；回答没变的一行不写、版本标的还是原来那个
  const again = await runImport({ root, now: () => new Date('2026-12-02T00:00:00Z'), log: () => {} })
  assert.ok(again.added > 0 && again.added < third.run.suggestions, String(again.added))
  const of = (work: string) => currentModelTags(loadAssertions(root).assertions).get(work)!.get(TAGGER_ID)!
  const current = () => of('doi:10.1000/t.1')
  assert.deepEqual([current().version, current().tags.has('working memory'), current().tags.has('methylphenidate')], [third.run.tagger.version, false, true])
  assert.equal(of('doi:10.1000/t.2').version, first.run.tagger.version) // t.2 没有 Working memory，回答没变
  assert.equal(loadAssertions(root).assertions.length, first.run.suggestions + again.added)
  // 把词表改回原样（版本号也回到最初的那个）：这一组重新写进来、重新生效——不需要任何人记得改什么
  writeFileSync(vocabFile, original)
  const back = await runTag({ root, log: () => {} })
  assert.equal(back.run.tagger.version, first.run.tagger.version)
  const reverted = await runImport({ root, now: () => new Date('2026-12-03T00:00:00Z'), log: () => {} })
  assert.ok(reverted.added > 0)
  assert.deepEqual([current().version, current().tags.has('working memory')], [first.run.tagger.version, true])
  const ids = loadAssertions(root).assertions.map((a) => a.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal((await runImport({ root, now: () => new Date('2026-12-04T00:00:00Z'), log: () => {} })).added, 0)
  assert.deepEqual(checkRepo(root), [])
  assert.deepEqual(checkExport(runExport({ root, out: 'export/v1', now: new Date(AT), sourceCommit: 'x', repository: '', maintainers: [] }).outDir, root), [])
  rmSync(root, { recursive: true, force: true })
})

const model = (id: string, version: string, work: string, tag: string, at: string, form: string, note: string | null = null): EvidenceAnnotation => ({
  id: `a_${id}_${version}_${work}_${tag}`.replace(/[^a-z0-9_]/gi, ''), at, work_id: work, kind: 'tag', op: 'add', subject: `tag:${tag.toLowerCase()}`,
  by: { kind: 'model', id, tier: 'model', model_version: version }, payload: { kind: 'tag', tag }, source: { form }, note, supersedes: null,
})

test('④ 当前生效的模型建议：贡献包取最新版本那一组；样本逐键累积；别名并到同一篇；黑名单；旁路文件的改动与对账', () => {
  const rows = [
    model('pack', '1', 'doi:10.1/a', 'ADHD', '2026-11-01T00:00:00.000Z', IMPORT_FORM, 'import:p.json;confidence=0.9;answer=aaaaaaaaaaaa'),
    model('pack', '1', 'doi:10.1/a', 'Sleep', '2026-11-01T00:00:00.001Z', IMPORT_FORM, 'import:p.json;answer=aaaaaaaaaaaa'),
    model('pack', '2', 'openalex:W1', 'ADHD', '2026-11-05T00:00:00.000Z', IMPORT_FORM, 'import:q.json;confidence=0.75;answer=bbbbbbbbbbbb'), // 同一篇，用的是别名
    model('pack', '1', 'doi:10.1/b', 'Sleep', '2026-11-01T00:00:00.002Z', IMPORT_FORM, 'import:p.json;answer=cccccccccccc'), // 新包没提这一篇：旧的那组还在
    // 同一个版本、答案变了（比如名片更新过）：c 上先答 Old1+Old2，后来改答 New1——只有后写的那一组生效
    model('pack', '2', 'doi:10.1/c', 'Old1', '2026-11-05T00:00:00.001Z', IMPORT_FORM, 'import:q.json;answer=dddddddddddd'),
    model('pack', '2', 'doi:10.1/c', 'Old2', '2026-11-05T00:00:00.002Z', IMPORT_FORM, 'import:q.json;answer=dddddddddddd'),
    model('pack', '2', 'doi:10.1/c', 'New1', '2026-11-06T00:00:00.000Z', IMPORT_FORM, 'import:q.json;answer=eeeeeeeeeeee'),
    model('sampler', '2026-10-31', 'doi:10.1/a', 'Old', '2026-10-31T00:00:00.000Z', 'sample/1'),
    model('sampler', '2026-11-23', 'doi:10.1/a', 'New', '2026-11-23T00:00:00.000Z', 'sample/1'),
    model('blocked', '1', 'doi:10.1/a', 'Spam', '2026-11-02T00:00:00.000Z', IMPORT_FORM),
    { ...model('pack', '2', 'doi:10.1/a', 'Human', AT, IMPORT_FORM), by: { kind: 'person', id: 'gh:1', tier: 'contributor' } } as EvidenceAnnotation, // 不是模型层：不收
  ]
  const canon = (k: string) => (k === 'openalex:W1' ? 'doi:10.1/a' : k)
  const cur = currentModelTags(rows, { blocklist: ['blocked'], canon })
  assert.deepEqual([...cur.keys()].sort(), ['doi:10.1/a', 'doi:10.1/b', 'doi:10.1/c'])
  assert.deepEqual([...cur.get('doi:10.1/c')!.get('pack')!.tags.keys()], ['new1'])
  const a = cur.get('doi:10.1/a')!
  assert.deepEqual([...a.keys()].sort(), ['pack', 'sampler'])
  assert.deepEqual([a.get('pack')!.version, [...a.get('pack')!.tags.keys()]], ['2', ['adhd']]) // 版本 1 的 Sleep 退场
  assert.deepEqual([a.get('sampler')!.version, [...a.get('sampler')!.tags.keys()].sort()], ['2026-11-23', ['new', 'old']])
  assert.deepEqual([cur.get('doi:10.1/b')!.get('pack')!.version, [...cur.get('doi:10.1/b')!.get('pack')!.tags.keys()]], ['1', ['sleep']])

  assert.deepEqual([confidenceOfNote('import:p.json;confidence=0.9;answer=aaaaaaaaaaaa'), confidenceOfNote('import:p.json'), confidenceOfNote('confidence=7'), confidenceOfNote(null)], [0.9, null, null, null])
  assert.deepEqual([answerOfNote('import:p.json;confidence=0.9;answer=0123456789ab'), answerOfNote('import:p.json'), answerOfNote('answer=xyz')], ['0123456789ab', null, null])
  const files = buildSuggestions(rows, { blocklist: ['blocked'], canon })
  assert.deepEqual(files.index.counts, { works: 3, suggestions: 5, models: { pack: 3, sampler: 2 } })
  const all = [...files.shards.values()].flat()
  assert.deepEqual(all.find((r) => r.work_id === 'doi:10.1/a')!.models[0], { id: 'pack', version: '2', tags: [{ tag_key: 'adhd', label: 'ADHD', confidence: 0.75 }] })
  // 同一批断言换个顺序，字节一样（重放靠这个）
  assert.deepEqual(buildSuggestions([...rows].reverse(), { blocklist: ['blocked'], canon }).index, files.index)
})

test('④b 旁路文件的检查：缺索引、片被改、多出文件、与账本对不上，都报', async () => {
  const root = makeTempRepo()
  await runHarvest({ root, openalex: fakeOpenAlex('found', [paper(1), paper(2)]), perTopic: 10, now: () => new Date(AT), log: () => {} })
  await runTag({ root, log: () => {} })
  await runImport({ root, now: () => new Date(AT), log: () => {} })
  const out = runExport({ root, out: 'export/v1', now: new Date(AT), sourceCommit: 'x', repository: '', maintainers: [] })
  assert.deepEqual(checkSuggestions(out.outDir, root), [])
  const shard = join(out.outDir, out.files.suggestions.index.shards[0]!.path)
  const before = readFileSync(shard, 'utf8')
  writeFileSync(shard, before.replace('"label":"ADHD"', '"label":"Adhd"'))
  assert.ok(checkSuggestions(out.outDir, root).some((p) => p.what.includes('sha256')))
  writeFileSync(shard, before)
  writeFileSync(join(out.outDir, 'suggestions', 'zz.jsonl'), '')
  assert.ok(checkSuggestions(out.outDir, root).some((p) => p.what.includes('not listed')))
  rmSync(join(out.outDir, 'suggestions', 'zz.jsonl'))
  // 账本后来多了建议、导出没跟上 ⇒ 对账不平
  const more = await runHarvest({ root, openalex: fakeOpenAlex('found', [paper(7)]), perTopic: 10, now: () => new Date(AT), log: () => {} })
  assert.equal(more.added, 1)
  await runTag({ root, log: () => {} })
  await runImport({ root, now: () => new Date('2026-11-24T00:00:00Z'), log: () => {} })
  assert.ok(checkSuggestions(out.outDir, root).some((p) => p.what.includes('ledger has')))
  rmSync(join(out.outDir, 'suggestions.json'))
  assert.ok(checkSuggestions(out.outDir, root).some((p) => p.what.includes('missing')))
  rmSync(root, { recursive: true, force: true })
})

test('④c 同一个模型的两个包回答同一篇（一个用 DOI、一个用别名）⇒ 后一个包整包拒绝，什么都不写', async () => {
  const root = makeTempRepo()
  await runHarvest({ root, openalex: fakeOpenAlex('found', [paper(1)]), perTopic: 10, now: () => new Date(AT), log: () => {} })
  mkdirSync(join(root, 'imports'), { recursive: true })
  const pkg = (work: string) => JSON.stringify({ contract: '0.6.2', tagger: { id: 'some-model', version: '1' }, items: [{ work_id: work, tags: [{ tag: 'ADHD', confidence: 0.9 }] }] })
  writeFileSync(join(root, 'imports', 'a.json'), pkg('doi:10.1000/t.1'))
  writeFileSync(join(root, 'imports', 'b.json'), pkg('openalex:W9001')) // 名片的别名：同一篇
  const r = await runImport({ root, now: () => new Date(AT), log: () => {} })
  assert.deepEqual([r.added, r.packages.map((p) => p.refused), loadAssertions(root).assertions.length], [0, [null, 'overlapping_package'], 0])
  rmSync(join(root, 'imports', 'b.json'))
  assert.equal((await runImport({ root, now: () => new Date(AT), log: () => {} })).added, 1)
  rmSync(root, { recursive: true, force: true })
})

test('⑤ 社区裁决对标准答案：成立的标签当预测、研究设计取裁决值；还没有裁决的作品不算「社区说没有」', () => {
  const tag = (key: string, state: 'present' | 'absent' | 'disputed') => ({ tag_key: key, label: key, state, decided_by: 'contributor', support: {}, last_changed: AT, request_id: null }) as unknown as EvidenceCommunityWork['tags'][number]
  const work = (id: string, aliases: string[], tags: EvidenceCommunityWork['tags'], design: [string, string] | null): EvidenceCommunityWork => ({
    work_id: id, aliases, card: null, tags, pending: [], rows: [], unsure: 0, updated_at: AT,
    facets: design ? { design: { value: design[0], decision: { state: design[1] } as never, locators: [] } } : {},
  })
  const works = [
    work('doi:10.1/a', ['openalex:W1'], [tag('adhd', 'present'), tag('sleep', 'present'), tag('autism', 'absent')], ['rct', 'accepted']),
    work('doi:10.1/b', [], [tag('adhd', 'disputed')], ['cohort', 'pending']), // 只有争议、设计待定：都不算裁决
    work('doi:10.1/c', [], [tag('adhd', 'absent')], ['cohort', 'accepted']),
    work('doi:10.1/zz', [], [tag('adhd', 'present')], null), // 不在标准答案里
  ]
  const gold = [
    { work_id: 'openalex:W1', tags: ['ADHD', 'Children'], design: 'rct', by: 'gh:1', at: AT }, // 标准答案用的是别名
    { work_id: 'doi:10.1/b', tags: ['ADHD'], design: 'cohort', by: 'gh:1', at: AT },
    { work_id: 'doi:10.1/c', tags: [], design: 'rct', by: 'gh:2', at: AT },
  ]
  const q = evaluateQuality([], gold, works)
  const c = q.consensus!
  assert.equal(c.works, 2) // a 与 c 有裁决；b 只有争议
  // a：adhd 命中、sleep 多给、children 漏；b：没有裁决，adhd 算漏；c：标准答案为空、社区也没有成立的
  assert.deepEqual([c.tags.micro.tp, c.tags.micro.fp, c.tags.micro.fn], [1, 1, 2])
  assert.deepEqual(c.tags.works, { gold: 3, predicted: 2, with_predictions: 1 })
  assert.deepEqual([c.design.n, c.design.agreed], [2, 1]) // a：rct 对 rct；c：cohort 对 rct；b 待定不比
  // 没有标准答案：如实是 null
  const none = evaluateQuality([], [], works).consensus!
  assert.deepEqual([none.works, none.tags.micro.precision, none.tags.coverage, none.design.agreement], [0, null, null, null])
})

test('⑥ 模型参考标注：与标准答案分开存、分开评；人与模型互不混入；输出写明不是人标、不是准确率（中英文都是）', async () => {
  const root = makeTempRepo()
  await runHarvest({ root, openalex: fakeOpenAlex('found', [paper(1), paper(2, { title: 'A trial of atomoxetine in adults', keywords: [], mesh: ['Adult'] })]), perTopic: 10, now: () => new Date(AT), log: () => {} })
  await runTag({ root, log: () => {} })
  await runImport({ root, now: () => new Date(AT), log: () => {} })
  mkdirSync(join(root, 'data', 'model-reference'), { recursive: true })
  mkdirSync(join(root, 'data', 'gold'), { recursive: true })
  const ref = join(root, 'data', 'model-reference', 'r.jsonl')
  const row = (work: string, tags: string[], by = 'model:llm-reader', at = AT) => JSON.stringify({ work_id: work, tags, by, at })
  // t.1 的打标签器建议是 ADHD / Children / Methylphenidate / Working memory；参考标注者只同意前两个，另给了一个 Adolescents。
  // 同一篇再用别名写一行（更晚）：算同一篇；第二位标注者 second-reader 恰好与打标签器同名时不拿它和自己比
  writeFileSync(ref, [
    row('doi:10.1000/t.1', ['Sleep'], 'model:llm-reader', '2026-11-01T00:00:00Z'), row('doi:10.1000/t.1', ['ADHD', 'Children', 'Adolescents']),
    row('doi:10.1000/t.2', ['ADHD'], `model:${TAGGER_ID}`),
  ].join('\n') + '\n')
  assert.deepEqual(checkRepo(root), [])
  // 同一个标注者对同一篇取最新一行；每个标注者一节
  assert.deepEqual(loadReference(root).rows.map((r) => [r.by, r.work_id, r.tags.length]), [['model:llm-reader', 'doi:10.1000/t.1', 3], [`model:${TAGGER_ID}`, 'doi:10.1000/t.2', 1]])
  const out = runExport({ root, out: 'export/v1', now: new Date(AT), sourceCommit: 'x', repository: '', maintainers: [] })
  const quality = JSON.parse(readFileSync(join(out.outDir, 'quality.json'), 'utf8'))
  // 标准答案那边如实是「没有」：参考标注不算标准答案
  assert.deepEqual([quality.gold, quality.models[0].quality.micro.precision, quality.consensus.works], [{ works: 0, annotators: 0 }, null, 0])
  assert.deepEqual(quality.model_reference.map((r: { by: string; kind: string; not_human: boolean; works: number; models: unknown[] }) => [r.by, r.kind, r.not_human, r.works, r.models.length]),
    [['model:llm-reader', 'model', true, 1, 1], [`model:${TAGGER_ID}`, 'model', true, 1, 0]]) // 第二节里没有「自己比自己」
  const agreement = quality.model_reference[0].models.find((m: { id: string }) => m.id === TAGGER_ID).agreement
  assert.deepEqual([agreement.pairs, agreement.works], [{ both: 2, model_only: 2, reference_only: 1 }, { reference: 1, with_suggestions: 1 }])
  // 这一节的键名里没有 gold / tp / fp 之类会被读成「对标准答案的成绩」的字眼
  assert.ok(!/"(gold|tp|fp|fn|micro|support)"/.test(JSON.stringify(quality.model_reference)))
  // pnpm evaluate：标准答案一节照旧说没有；参考标注单列一节，写明不是人标、不是准确率——中英文都不借用标准答案那几句话
  const run = async (lang: string) => {
    const printed: string[] = []
    const realLog = console.log
    console.log = (...a: unknown[]) => { printed.push(a.join(' ')) }
    try { assert.equal(await evaluateMain(['--root', root, '--lang', lang]), 0) } finally { console.log = realLog }
    return printed.join('\n')
  }
  const zh = await run('zh')
  assert.match(zh, /标准答案：0 篇，0 位标注人/)
  const zhSection = zh.slice(zh.indexOf('模型参考标注（不是人标的；标注者 model:llm-reader，1 篇）'))
  assert.ok(zhSection.startsWith('模型参考标注（不是人标的') && zhSection.includes('不是准确率') && zhSection.includes('两边都给了 2 对 · 只有这个模型给了 2 · 只有参考标注者给了 1')
    && zhSection.includes('精确率 50% · 召回率 66.7% · F1 57.1%') && !zhSection.includes('标准答案') && !zhSection.includes('命中'), zhSection)
  const en = await run('en')
  const enSection = en.slice(en.indexOf('Model comparison labels (NOT human-labelled'))
  assert.ok(enSection.startsWith('Model comparison labels (NOT human-labelled') && enSection.includes('not accuracy') && enSection.includes('2 pairs given by both · 2 only by this model · 1 only by the comparison annotator')
    && !/reference labels|correct|missed|in the reference\b/i.test(enSection), enSection)
  // 别名：同一篇用别名再写一行，仍算一篇
  writeFileSync(ref, [row('doi:10.1000/t.1', ['ADHD']), row('openalex:W9001', ['ADHD', 'Children'], 'model:llm-reader', '2026-11-25T00:00:00Z')].join('\n') + '\n')
  const aliased = JSON.parse(readFileSync(join(runExport({ root, out: 'export/v1', now: new Date(AT), sourceCommit: 'x', repository: '', maintainers: [] }).outDir, 'quality.json'), 'utf8')).model_reference[0]
  assert.deepEqual([aliased.works, aliased.models[0].agreement.works.reference], [1, 1])
  // 互不混入：人的账号不许进参考标注，模型不许进标准答案；参考标注不带研究设计；标签必须在词表里
  writeFileSync(ref, row('doi:10.1000/t.1', ['ADHD'], 'gh:12345') + '\n')
  assert.ok(checkRepo(root).some((p) => p.what.includes('model-reference by must look like model:')))
  assert.deepEqual(loadReference(root).rows, []) // 读取时也不认
  writeFileSync(ref, JSON.stringify({ work_id: 'doi:10.1000/t.1', tags: ['ADHD'], by: 'model:llm-reader', at: AT, design: 'rct' }) + '\n')
  assert.ok(checkRepo(root).some((p) => p.what.includes('tags only')))
  writeFileSync(ref, row('doi:10.1000/t.1', ['Not In The Vocabulary']) + '\n')
  assert.ok(checkRepo(root).some((p) => p.what.includes('not in vocab/tags.json')))
  writeFileSync(ref, row('doi:10.1000/t.1', ['ADHD']) + '\n')
  writeFileSync(join(root, 'data', 'gold', 'g.jsonl'), row('doi:10.1000/t.1', ['ADHD']) + '\n')
  assert.ok(checkRepo(root).some((p) => p.what.includes('gold by must look like gh:')))
  assert.deepEqual(loadGold(root).rows, []) // 模型的行放进标准答案目录，读取时不认——不会被当成标准答案去评
  rmSync(root, { recursive: true, force: true })
})
