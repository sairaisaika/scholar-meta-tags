/**
 * 检测基本盘：
 *   ① 分片：超过上限开下一片；读取合并排序与分片位置无关；「近两月」读到全部分片；
 *   ② 账本摘要：内容不变摘要不变，改一个字节摘要就变；
 *   ③ 只追加闸：追加通过；改一行、删一行、删文件都被抓到；声明过的抹名通过、没声明的不通过；没有基准如实说没比；基准不在历史里判失败；
 *   ④ 贡献包入库：验形、幂等、坏包整包拒绝、坏条目逐条报、dry-run 不写、名片问不成先不存；导出读回零问题；
 *   ⑤ 质量评估：模型建议对标准答案；没有标准答案如实为 null；标准答案行的验形。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildTagContribution } from 'scholar-meta'
import type { EvidenceAnnotation } from 'scholar-meta'
import { checkAppendOnly, checkGoldRow, checkRepo, findEmail, isRedactionOf, main as checkMain } from './check.js'
import { redact } from './redact.js'
import { evaluateModels } from './evaluate.js'
import { runExport } from './export.js'
import { runImport } from './import.js'
import { makeTempRepo } from './lib/test-fixtures.js'
import { annotationId, appendAssertions, ledgerOf, loadAssertions, loadGold, loadRecentAssertions, monthParts } from './lib/store.js'

const AT = '2026-11-23T00:00:00.000Z'
const person = (n: number, work: string, tag: string, at = AT): EvidenceAnnotation => {
  const base = { work_id: work, kind: 'tag' as const, op: 'add' as const, subject: `tag:${tag.toLowerCase()}`, by: { kind: 'person' as const, id: `gh:${1000 + n}`, tier: 'contributor' as const }, payload: { kind: 'tag' as const, tag }, source: { issue: n, form: 'annotate/1' } }
  return { id: annotationId(base), at, ...base, note: null, supersedes: null }
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@users.noreply.github.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

test('① 分片：超过上限开下一片；合并读取与分片无关；近两月读到全部分片', () => {
  const root = makeTempRepo()
  // 每行等长（编号都是三位），这样「一片 10 行」是确定的
  const rows = Array.from({ length: 30 }, (_, i) => person(100 + i, `doi:10.1000/s.${100 + i}`, 'ADHD', new Date(Date.parse(AT) + (100 + i) * 1000).toISOString()))
  const lineBytes = Buffer.byteLength(`${JSON.stringify(rows[0])}\n`)
  const cap = lineBytes * 10 + 5 // 一片装 10 行
  for (let i = 0; i < rows.length; i += 5) appendAssertions(rows.slice(i, i + 5), AT, root, cap)
  const parts = monthParts(AT, root)
  assert.deepEqual(parts.map((p) => p.split('/').pop()), ['11.jsonl', '11-002.jsonl', '11-003.jsonl'])
  assert.deepEqual(readdirSync(join(root, 'data', 'assertions', '2026')).sort(), ['11-002.jsonl', '11-003.jsonl', '11.jsonl'])
  const all = loadAssertions(root)
  assert.equal(all.bad.length, 0)
  assert.deepEqual(all.assertions.map((a) => a.id), rows.map((a) => a.id)) // 按 at 排序 ＝ 原顺序
  assert.equal(loadRecentAssertions(new Date(AT), root).length, 30)
  assert.equal(appendAssertions([], AT, root, cap), null)
  // 一批本身就超过上限：仍然整批写进同一片（不拆行），下一批再开新片
  const big = makeTempRepo()
  appendAssertions(rows, AT, big, cap)
  assert.equal(monthParts(AT, big).length, 1)
  appendAssertions([person(99, 'doi:10.1000/s.99', 'x')], AT, big, cap)
  assert.equal(monthParts(AT, big).length, 2)
})

test('② 账本摘要：稳定；改一个字节就变', () => {
  const root = makeTempRepo()
  appendAssertions([person(1, 'doi:10.1000/l.1', 'ADHD'), person(2, 'doi:10.1000/l.1', 'ADHD')], AT, root)
  const a = ledgerOf(root)
  assert.deepEqual([a.files.length, a.assertions, a.files[0]!.path, a.files[0]!.lines], [1, 2, 'data/assertions/2026/11.jsonl', 2])
  assert.deepEqual(ledgerOf(root), a)
  const file = join(root, a.files[0]!.path)
  writeFileSync(file, readFileSync(file, 'utf8').replace('ADHD', 'ADHd'))
  assert.notEqual(ledgerOf(root).digest, a.digest)
  const out = runExport({ root, out: 'export/v1', now: new Date(AT), sourceCommit: 'x', repository: '', maintainers: [] })
  assert.deepEqual(JSON.parse(readFileSync(join(out.outDir, 'ledger.json'), 'utf8')), ledgerOf(root))
})

test('③ 只追加闸', () => {
  const root = makeTempRepo()
  git(root, 'init', '-q', '-b', 'main')
  appendAssertions([person(1, 'doi:10.1000/a.1', 'ADHD'), person(2, 'doi:10.1000/a.1', 'ADHD'), person(3, 'doi:10.1000/a.2', 'Sleep')], AT, root)
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'base')
  const base = git(root, 'rev-parse', 'HEAD')
  const file = join(root, 'data', 'assertions', '2026', '11.jsonl')
  const original = readFileSync(file, 'utf8')

  // 追加：通过
  appendAssertions([person(4, 'doi:10.1000/a.3', 'CBT')], AT, root)
  assert.deepEqual(checkAppendOnly(root, base), { compared: true, files: 1, problems: [] })

  // 改一行
  writeFileSync(file, original.replace('"ADHD"', '"adhd!"'))
  assert.ok(checkAppendOnly(root, base).problems.some((p) => /11\.jsonl:1$/.test(p.where) && /existing line was changed/.test(p.what)))
  // 删一行
  writeFileSync(file, original.split('\n').slice(1).join('\n'))
  assert.ok(checkAppendOnly(root, base).problems.some((p) => /lines were removed \(3 → 2\)/.test(p.what)))
  // 删文件
  rmSync(file)
  assert.ok(checkAppendOnly(root, base).problems.some((p) => /was deleted/.test(p.what)))

  // 抹名：by.id 换成 redacted:<12 hex>
  const redacted = original.split('"gh:1001"').join('"redacted:0123456789ab"')
  writeFileSync(file, redacted)
  assert.ok(isRedactionOf(original.split('\n')[0]!, redacted.split('\n')[0]!))
  assert.ok(checkAppendOnly(root, base).problems.length > 0) // 没在 REDACTIONS.md 里声明 ⇒ 不通过
  writeFileSync(join(root, 'data', 'REDACTIONS.md'), `${readFileSync(join(root, 'data', 'REDACTIONS.md'), 'utf8')}- 2026-11-23：1 条\n`)
  assert.deepEqual(checkAppendOnly(root, base).problems, [])
  // 声明了抹名也不能顺手改别的字段
  writeFileSync(file, redacted.replace('"ADHD"', '"adhd!"'))
  assert.ok(checkAppendOnly(root, base).problems.some((p) => /beyond a redaction/.test(p.what)))
  assert.equal(isRedactionOf('{"by":{"id":"gh:1"},"x":1}', '{"by":{"id":"redacted:0123456789ab"},"x":2}'), false)
  assert.equal(isRedactionOf('{"by":{"id":"gh:1"}}', '{"by":{"id":"gh:2"}}'), false)

  // 中间插空行也是改写（文件不再是字节前缀）
  writeFileSync(file, original.replace('\n', '\n\n'))
  assert.ok(checkAppendOnly(root, base).problems.length > 0)
  // 抹名必须整体自洽：REDACTIONS.md 只加空白不算声明
  writeFileSync(join(root, 'data', 'REDACTIONS.md'), '# 抹名记录\n\n \n')
  writeFileSync(file, redacted)
  assert.ok(checkAppendOnly(root, base).problems.length > 0)
  writeFileSync(join(root, 'data', 'REDACTIONS.md'), '# 抹名记录\n\n- 2026-11-23：1 条\n')
  // 把两个账号并成一个新 id（会少一票）
  writeFileSync(file, original.split('"gh:1001"').join('"redacted:0123456789ab"').split('"gh:1002"').join('"redacted:0123456789ab"'))
  assert.ok(checkAppendOnly(root, base).problems.some((p) => /inconsistent redaction/.test(p.what)))
  // 把一个账号的两行换成两个新 id（会多一票）：先让 gh:1001 有两行
  const twoLines = `${original}${JSON.stringify(person(1, 'doi:10.1000/a.9', 'Sleep'))}\n`
  writeFileSync(file, twoLines); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'second line'); const base2 = git(root, 'rev-parse', 'HEAD')
  const firstOnly = twoLines.replace('"gh:1001"', '"redacted:0123456789ab"')
  writeFileSync(join(root, 'data', 'REDACTIONS.md'), '# 抹名记录\n\n- 2026-11-23：1 条\n- 2026-11-24：1 条\n') // 相对 base2 新增一行 ＝ 声明
  writeFileSync(file, firstOnly)
  assert.ok(checkAppendOnly(root, base2).problems.some((p) => /partial redaction/.test(p.what)))
  writeFileSync(file, firstOnly.replace('"gh:1001"', '"redacted:ba9876543210"'))
  assert.ok(checkAppendOnly(root, base2).problems.some((p) => /inconsistent redaction/.test(p.what)))
  // 换成一个此前已经在用的 redacted id（并进别人）
  writeFileSync(file, twoLines.split('"gh:1002"').join('"redacted:0123456789ab"')); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'earlier redaction'); const base3 = git(root, 'rev-parse', 'HEAD')
  writeFileSync(join(root, 'data', 'REDACTIONS.md'), '# 抹名记录\n\n- 2026-11-23：1 条\n- 2026-11-24：1 条\n- 2026-11-25：2 条\n')
  writeFileSync(file, readFileSync(file, 'utf8').split('"gh:1001"').join('"redacted:0123456789ab"'))
  assert.ok(checkAppendOnly(root, base3).problems.some((p) => /already in use/.test(p.what)))
  // 真的抹名脚本产出的改动通过（全部行、一个新 id）
  git(root, 'checkout', '-q', '--', '.')
  const r = redact('gh:1001', 'salt', root, new Date(AT))
  assert.equal(r.replaced, 2)
  assert.deepEqual(checkAppendOnly(root, base3).problems, [])

  // 没有基准：如实说没比；基准不在历史里：判失败
  git(root, 'checkout', '-q', '--', '.')
  assert.deepEqual(checkAppendOnly(root, '0000000000000000000000000000000000000000'), { compared: false, files: 0, problems: [] })
  assert.deepEqual(checkAppendOnly(root, ''), { compared: false, files: 0, problems: [] })
  const gone = checkAppendOnly(root, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
  assert.equal(gone.compared, false)
  assert.ok(gone.problems.some((p) => /not in this history/.test(p.what)))
})

test('③c 断言目录里名字不合规的文件被结构闸指出；邮箱扫描在长文件上也快', () => {
  const root = makeTempRepo()
  mkdirSync(join(root, 'data', 'assertions', '2026'), { recursive: true })
  writeFileSync(join(root, 'data', 'assertions', '2026', '11-补.jsonl'), '')
  writeFileSync(join(root, 'data', 'assertions', '2026', '13.jsonl'), '')
  const odd = checkRepo(root).filter((p) => /unexpected file under data\/assertions/.test(p.what)).map((p) => p.where.split('/').pop()).sort()
  assert.deepEqual(odd, ['11-补.jsonl', '13.jsonl'])
  assert.equal(findEmail('contact a.b+c@d-e.org now'), 'a.b+c@d-e.org')
  assert.equal(findEmail('@ handle @x and a@b'), null)
  const t0 = Date.now()
  assert.equal(findEmail('a'.repeat(400_000)), null)
  assert.equal(findEmail(`${'a'.repeat(400_000)}@`), null)
  assert.ok(Date.now() - t0 < 2000)
})

test('③b 结构闸命令：--append-only 的退出码', async () => {
  const root = makeTempRepo()
  git(root, 'init', '-q', '-b', 'main')
  appendAssertions([person(1, 'doi:10.1000/c.1', 'ADHD')], AT, root)
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'base')
  const base = git(root, 'rev-parse', 'HEAD')
  assert.equal(await checkMain(['--root', root, '--append-only', base]), 0)
  const file = join(root, 'data', 'assertions', '2026', '11.jsonl')
  writeFileSync(file, readFileSync(file, 'utf8').replace('"ADHD"', '"other"'))
  assert.equal(await checkMain(['--root', root, '--append-only', base]), 1)
})

test('④ 贡献包入库：验形、幂等、整包拒绝、逐条问题、dry-run、名片', async () => {
  const root = makeTempRepo()
  mkdirSync(join(root, 'imports'), { recursive: true })
  const pkg = buildTagContribution({ id: 'my-llm', version: '2026-11' }, [
    { work_id: 'doi:10.1000/i.1', suggestions: [{ tag_key: 'adhd', label: 'ADHD', confidence: 0.9, rationale: null }, { tag_key: 'sleep', label: 'Sleep', confidence: null, rationale: null }] },
    { work_id: 'https://doi.org/10.1000/I.2', suggestions: [{ tag_key: 'cbt', label: 'CBT', confidence: 0.2, rationale: null }, { tag_key: 'insomnia', label: 'Insomnia', confidence: 0.8, rationale: null }] },
  ])
  writeFileSync(join(root, 'imports', 'a-good.json'), JSON.stringify({ ...pkg, items: [...pkg.items, { work_id: 'not a work', tags: [{ tag: 'x', confidence: 1 }] }] }))
  writeFileSync(join(root, 'imports', 'b-broken.json'), '{not json')
  writeFileSync(join(root, 'imports', 'c-bad-id.json'), JSON.stringify({ ...pkg, tagger: { id: 'Someone/Model', version: '1' } }))
  writeFileSync(join(root, 'imports', 'd-no-tagger.json'), JSON.stringify({ items: [] }))

  writeFileSync(join(root, 'imports', 'e@x.co.json'), JSON.stringify(pkg))
  writeFileSync(join(root, 'imports', 'f-ctrl.json'), JSON.stringify({ ...pkg, tagger: { id: 'my-llm', version: '1\n::error::x' } }))
  // 仓里已有的样本模型 id 不许被贡献包冒用
  const sampleBase = { work_id: 'doi:10.1000/i.0', kind: 'tag' as const, op: 'add' as const, subject: 'tag:x', by: { kind: 'model' as const, id: 'smt-vocab-keywords', tier: 'model' as const, model_version: '1' }, payload: { kind: 'tag' as const, tag: 'x' }, source: { sample: 'openalex:T1', form: 'sample/1' } }
  appendAssertions([{ id: annotationId(sampleBase), at: '2026-10-31T00:00:00.000Z', ...sampleBase, note: null, supersedes: null }], '2026-10-31T00:00:00Z', root)
  writeFileSync(join(root, 'imports', 'g-reserved.json'), JSON.stringify({ ...pkg, tagger: { id: 'smt-vocab-keywords', version: '9' } }))

  const dry = await runImport({ root, dry: true, now: () => new Date(AT), log: () => {} })
  assert.equal(loadAssertions(root).assertions.length, 1) // dry-run 不写（只有上面那条样本断言）
  assert.deepEqual(dry.packages.map((p) => [p.file, p.refused]), [
    ['imports/a-good.json', null], ['imports/b-broken.json', 'not_json'], ['imports/c-bad-id.json', 'bad_model_id'], ['imports/d-no-tagger.json', 'bad_tagger'],
    ['imports/e@x.co.json', 'bad_file_name'], ['imports/f-ctrl.json', 'bad_tagger'], ['imports/g-reserved.json', 'reserved_model_id'],
  ])
  for (const f of ['e@x.co.json', 'f-ctrl.json', 'g-reserved.json']) rmSync(join(root, 'imports', f))
  const good = dry.packages[0]!
  // 低于门槛（0.2 < 0.5）的那条被丢；坏作品键逐条报
  assert.deepEqual([good.works, good.suggestions, good.added, good.existing, good.dropped.below_threshold], [2, 3, 3, 0, 1])
  assert.ok(good.issues.some((i) => i.code === 'bad_work_id' && i.index === 2))

  const asked: string[] = []
  const openalex = { async fetchCard(ref: { kind: string; value: string }) { asked.push(ref.value); return ref.value.endsWith('i.1') ? { kind: 'error' as const } : { kind: 'not_found' as const } }, async listCards() { return [] } }
  const first = await runImport({ root, now: () => new Date(AT), cards: 10, openalex: openalex as never, log: () => {} })
  assert.equal(first.added, 3)
  const stored = loadAssertions(root).assertions.filter((a) => a.source.form === 'import/1')
  assert.equal(stored.length, 3)
  assert.ok(stored.every((a) => a.by.kind === 'model' && a.by.tier === 'model' && a.by.id === 'my-llm' && a.by.model_version === '2026-11' && a.source.form === 'import/1'))
  assert.deepEqual(stored.map((a) => a.work_id).sort(), ['doi:10.1000/i.1', 'doi:10.1000/i.1', 'doi:10.1000/i.2'])
  assert.ok(stored.some((a) => a.note === 'import:a-good.json;confidence=0.9') && stored.some((a) => a.note === 'import:a-good.json'))
  assert.equal(new Set(stored.map((a) => a.at)).size, 3) // 时间严格递增
  // 名片：问不成的先不存（外部源失败 ≠ 没有这篇），查无的存一张空名片
  assert.equal(asked.length, 2)
  assert.equal(first.cards, 1)
  assert.equal(checkRepo(root).length, 0)
  // 上次没问成的那篇，下次运行接着补（即使这次没有新断言）
  asked.length = 0
  const retry = await runImport({ root, now: () => new Date(AT), cards: 10, openalex: { async fetchCard(ref: { value: string }) { asked.push(ref.value); return { kind: 'not_found' as const } }, async listCards() { return [] } } as never, log: () => {} })
  assert.deepEqual([retry.added, retry.cards, asked.length], [0, 1, 1])

  // 幂等：重跑不多写；同一模型换版本重报同一标签也不多写
  const again = await runImport({ root, now: () => new Date('2026-11-24T00:00:00Z'), log: () => {} })
  assert.deepEqual([again.added, again.packages[0]!.existing], [0, 3])
  writeFileSync(join(root, 'imports', 'a-good.json'), JSON.stringify({ ...pkg, tagger: { id: 'my-llm', version: '2026-12' } }))
  assert.equal((await runImport({ root, now: () => new Date('2026-12-01T00:00:00Z'), log: () => {} })).added, 0)
  // 换大小写写法重报也不多写（按标签键判，不按写法）
  const lower = { ...pkg, items: pkg.items.map((it) => ({ ...it, tags: it.tags.map((t) => ({ ...t, tag: t.tag.toLowerCase() })) })) }
  writeFileSync(join(root, 'imports', 'a-good.json'), JSON.stringify(lower))
  assert.equal((await runImport({ root, now: () => new Date('2026-12-02T00:00:00Z'), log: () => {} })).added, 0)
  assert.equal(loadAssertions(root).assertions.filter((a) => a.source.form === 'import/1').length, 3)

  // 导出：模型层不计票；读回零问题
  const out = runExport({ root, out: 'export/v1', now: new Date(AT), sourceCommit: 'x', repository: '', maintainers: [] })
  assert.deepEqual(out.issues, [])
  assert.equal(out.files.manifest.counts.accepted, 0)
})

test('⑤ 质量评估：模型建议对标准答案；没有标准答案为 null；标准答案行验形', async () => {
  const root = makeTempRepo()
  mkdirSync(join(root, 'imports'), { recursive: true })
  mkdirSync(join(root, 'data', 'gold'), { recursive: true })
  const sug = (tag: string) => ({ tag_key: tag.toLowerCase(), label: tag, confidence: 0.9, rationale: null })
  writeFileSync(join(root, 'imports', 'm.json'), JSON.stringify(buildTagContribution({ id: 'model-a', version: '1' }, [
    { work_id: 'doi:10.1000/g.1', suggestions: [sug('ADHD'), sug('Sleep')] },
    { work_id: 'doi:10.1000/g.2', suggestions: [sug('CBT')] },
    { work_id: 'doi:10.1000/g.9', suggestions: [sug('Outside')] },
  ])))
  await runImport({ root, now: () => new Date(AT), log: () => {} })
  const none = evaluateModels(loadAssertions(root).assertions, loadGold(root).rows)
  assert.deepEqual(none.gold, { works: 0, annotators: 0 })
  assert.deepEqual([none.models[0]!.id, none.models[0]!.quality.micro.precision, none.models[0]!.quality.coverage], ['model-a', null, null])

  const gold = [
    { work_id: 'doi:10.1000/g.1', tags: ['ADHD'], by: 'gh:1', at: '2026-11-01T00:00:00Z' },
    { work_id: 'doi:10.1000/g.1', tags: ['ADHD', 'Children'], design: 'rct', by: 'gh:1', at: '2026-11-20T00:00:00Z' }, // 同一篇最新一行生效
    { work_id: 'doi:10.1000/g.2', tags: ['Wrong'], by: 'gh:2', at: '2026-11-20T03:00:00Z' },
    { work_id: 'doi:10.1000/g.2', tags: [], by: 'gh:2', at: '2026-11-20T12:00:00+08:00' }, // 04:00Z，比上一行晚：按时刻比，不按字符串比
  ]
  writeFileSync(join(root, 'data', 'gold', 'adhd.jsonl'), gold.map((g) => JSON.stringify(g)).join('\n') + '\n')
  assert.equal(checkRepo(root).length, 0)
  const q = evaluateModels(loadAssertions(root).assertions, loadGold(root).rows)
  assert.deepEqual(q.gold, { works: 2, annotators: 2 })
  const m = q.models[0]!.quality
  // g.1：ADHD 命中、Sleep 多给、Children 漏掉；g.2：标准答案为空，CBT 多给；g.9 不在标准答案里，不算
  assert.deepEqual([m.micro.tp, m.micro.fp, m.micro.fn], [1, 2, 1])
  assert.deepEqual(m.works, { gold: 2, predicted: 3, with_predictions: 2 })
  const out = runExport({ root, out: 'export/v1', now: new Date(AT), sourceCommit: 'x', repository: '', maintainers: [] })
  assert.ok(existsSync(join(out.outDir, 'quality.json')))
  assert.deepEqual(JSON.parse(readFileSync(join(out.outDir, 'quality.json'), 'utf8')), JSON.parse(JSON.stringify(q)))

  // 抹名也换掉标准答案里的标注人
  redact('gh:2', 'salt', root, new Date(AT))
  assert.ok(loadGold(root).rows.every((g) => g.by !== 'gh:2'))
  assert.ok(loadGold(root).rows.some((g) => /^redacted:[0-9a-f]{12}$/.test(g.by)))
  assert.equal(checkRepo(root).length, 0)

  assert.deepEqual(checkGoldRow({ work_id: 'doi:10.1/x', tags: ['a'], by: 'gh:1', at: AT }, 'g'), [])
  assert.ok(checkGoldRow({ work_id: 'nope', tags: [], by: 'gh:1', at: AT }, 'g').length > 0)
  const bad = checkGoldRow({ work_id: 'doi:10.1/x', tags: [''], design: 'made_up', by: 'someone', at: 'yesterday' }, 'g').map((p) => p.what).join(' | ')
  assert.match(bad, /valid tags/); assert.match(bad, /engine vocabulary/); assert.match(bad, /gh:<digits>/); assert.match(bad, /ISO time/)
})

test('⑥ 规模冒烟：三千篇、四万五千条断言，导出读回零问题', () => {
  const root = makeTempRepo()
  const rows: EvidenceAnnotation[] = []
  for (let i = 0; i < 3000; i++) for (let t = 0; t < 5; t++) for (let k = 0; k < 3; k++) rows.push(person((i * 3 + t + k * 997) % 3000, `doi:10.5555/scale.${i}`, `Topic ${(i * 7 + t * 13) % 400}`, new Date(Date.parse(AT) + rows.length).toISOString()))
  // 同一人对同一篇同一标签重复的去掉（id 相同）
  const unique = [...new Map(rows.map((r) => [r.id, r])).values()]
  for (let i = 0; i < unique.length; i += 5000) appendAssertions(unique.slice(i, i + 5000), AT, root, 4 * 1024 * 1024)
  assert.ok(monthParts(AT, root).length >= 3)
  const t0 = Date.now()
  const out = runExport({ root, out: 'export/v1', now: new Date(AT), sourceCommit: 'x', repository: '', maintainers: [] })
  assert.deepEqual(out.issues, [])
  assert.equal(out.files.manifest.counts.works, 3000)
  assert.ok(Date.now() - t0 < 60_000)
})
