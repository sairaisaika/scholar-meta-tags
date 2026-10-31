/**
 * 端到端：issue 正文（表单渲染格式）→ intake 纯函数解析校验 → 断言 JSONL → export → 引擎 `readCommunityExport` 零问题。
 * 覆盖：标签 2:0 accepted；1 人反对只算挑战；行一人抄 pending；盲复录一致 accepted/double；复录不一致 extraction_conflict；
 * 设计缺 locator 封顶 pending；贡献者 row context 的 reviewed / independence_verified 被剥掉并记 field_ignored；空数据导出合法。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { readCommunityExport, createCommunityPorts } from 'scholar-meta'
import type { EvidenceAnnotation, EvidenceCommunityWork } from 'scholar-meta'
import { FORM_ID, parseIssueBody, validateSubmission } from './lib/intake-core.js'
import type { Actor, IntakeResult } from './lib/intake-core.js'
import { appendJsonl, appendWork, loadConfig, loadVocab, monthFile, readJsonl, sha256, workShard } from './lib/store.js'
import { W, card, makeTempRepo, reExtractItem, renderIssueBody, rowItem } from './lib/test-fixtures.js'
import { runExport, selfCheck } from './export.js'
import { shardPath } from './lib/export-core.js'
import { checkExport } from './check.js'

const W2 = 'doi:10.1000/second'
const now = new Date('2026-10-31T09:00:00Z')

test('空数据导出合法：0 作品、清单齐全、读回零问题、check --export 通过', () => {
  const root = makeTempRepo()
  const { files, outDir, issues } = runExport({ root, out: 'export/v1', now, sourceCommit: 'test', repository: 'https://example.org/r', maintainers: ['someone'] })
  assert.deepEqual(issues, [])
  assert.equal(files.manifest.counts.works, 0)
  assert.equal(files.manifest.shards.length, 0)
  for (const f of ['manifest.json', 'frames.json', 'bindings.json', 'concepts.json', 'queues.json']) assert.ok(existsSync(join(outDir, f)), f)
  const m = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
  assert.equal(m.license, 'CC0-1.0')
  assert.equal(m.export_version, 1)
  assert.deepEqual(m.maintainers, ['someone'])
  assert.ok(Object.keys(m.facet_vocab).includes('design'))
  assert.deepEqual(checkExport(outDir), [])
})

test('端到端：正文 → 断言 → 导出 → 读回', () => {
  const root = makeTempRepo()
  const config = loadConfig(root)
  const vocab = loadVocab(root)
  const all: EvidenceAnnotation[] = []
  let tick = 0
  const actor = (id: number, tier: Actor['tier'] = 'contributor'): Actor => ({ id: `gh:${id}`, login: `u${id}`, tier, type: 'User', created_at: '2020-01-01T00:00:00Z' })
  /** 一条 issue：渲染正文 → 解析 → 校验 → 写入月片 */
  const ingest = (issue: number, by: Actor, items: unknown[], work = W): IntakeResult => {
    const body = renderIssueBody({ form: FORM_ID, work_id: work, items }, work)
    const parsed = parseIssueBody(body)
    assert.ok(parsed.ok)
    const at = new Date(now.getTime() + ++tick * 60_000)
    const r = validateSubmission(parsed.raw, by, { config, facets: vocab.facets, existing: all, now: at, source: { issue, form: FORM_ID } })
    assert.equal(r.held, false)
    appendJsonl(join(root, 'data', 'assertions', monthFile(at).rel), r.accepted)
    all.push(...r.accepted)
    return r
  }
  appendWork({ work_id: W, aliases: ['openalex:W3001234567', 'pmid:31900000'], card: { ...card, abstract: null }, snapshot_at: now.toISOString(), snapshot_source: 'openalex' }, root)

  // #1 c1：标签 ADHD、标签 Sleep、design=rct 带出处、行 o1（贡献者多写了审核字段）
  const r1 = ingest(1, actor(1), [
    { kind: 'tag', op: 'add', subject: 'tag:adhd', payload: { kind: 'tag', tag: 'ADHD' } },
    { kind: 'tag', op: 'add', subject: 'tag:sleep', payload: { kind: 'tag', tag: 'Sleep' } },
    { kind: 'facet', op: 'add', subject: 'facet:design', payload: { kind: 'facet', facet: 'design', value: 'rct', locator: 'Abstract-Methods' } },
    rowItem('o1', -0.42, { reviewed: true, independence_verified: true, dependence_id: 'nct:1' }),
  ])
  assert.equal(r1.accepted.length, 4)
  assert.deepEqual(r1.rejected, [])
  assert.deepEqual(r1.ignored.map((i) => i.field).sort(), ['context.dependence_id', 'context.independence_verified', 'context.reviewed'])
  const storedRow = r1.accepted[3]!.payload as Extract<EvidenceAnnotation['payload'], { kind: 'row' }>
  assert.ok(!('reviewed' in storedRow.context) && !('independence_verified' in storedRow.context) && !('dependence_id' in storedRow.context))
  // #2 c2：认可 ADHD（2:0）；反对 Sleep（1 人 ⇒ 只算挑战）；盲复录 o1 一致
  const r2 = ingest(2, actor(2), [
    { kind: 'review', op: 'endorse', subject: 'tag:adhd', payload: { kind: 'review', reason: null } },
    { kind: 'review', op: 'dispute', subject: 'tag:sleep', payload: { kind: 'review', reason: 'the paper does not measure sleep at all' } },
    reExtractItem('o1', -0.421),
  ])
  assert.equal(r2.accepted.length, 3)
  // #3 c3：行 o2 一人抄；#4 c4：复录 o2 不一致
  ingest(3, actor(3), [rowItem('o2', -0.1)])
  ingest(4, actor(4), [reExtractItem('o2', -0.3)])
  // W2：#5 c3 design=rct 没写出处；#6 c4 认可 ⇒ 2:0 但封顶 pending
  ingest(5, actor(3), [{ kind: 'facet', op: 'add', subject: 'facet:design', payload: { kind: 'facet', facet: 'design', value: 'rct' } }], W2)
  ingest(6, actor(4), [{ kind: 'review', op: 'endorse', subject: 'facet:design', payload: { kind: 'review', reason: null } }], W2)
  // 编辑绑定 adhd → 主题
  ingest(7, actor(9, 'editor'), [{ kind: 'binding', op: 'add', subject: 'binding:adhd', payload: { kind: 'binding', topic: { id: 'openalex:T10537', display_name: 'Attention Deficit Hyperactivity Disorder' } } }])

  const { files, outDir, issues } = runExport({ root, out: 'export/v1', now, sourceCommit: 'abc', repository: 'https://example.org/r', maintainers: ['m'] })
  assert.deepEqual(issues, [])
  assert.equal(files.manifest.counts.works, 2)
  assert.equal(files.manifest.counts.assertions, all.length)
  assert.equal(files.manifest.counts.contributors, 5)

  // 读回：用写出的字节
  const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
  const shards = manifest.shards.map((s: { path: string; sha256: string; bytes: number }) => {
    const bytes = readFileSync(join(outDir, s.path))
    assert.equal(sha256(bytes), s.sha256)
    assert.equal(bytes.length, s.bytes)
    return readJsonl(join(outDir, s.path)).rows.map((r) => r.value)
  })
  const read = readCommunityExport(manifest, shards, {
    bindings: JSON.parse(readFileSync(join(outDir, 'bindings.json'), 'utf8')), concepts: JSON.parse(readFileSync(join(outDir, 'concepts.json'), 'utf8')), frames: JSON.parse(readFileSync(join(outDir, 'frames.json'), 'utf8')),
  })
  assert.ok(read.ok)
  assert.deepEqual(read.issues, [])
  assert.deepEqual(checkExport(outDir), [])
  const w = read.value.works.find((x) => x.work_id === W)!
  const w2 = read.value.works.find((x) => x.work_id === W2)!
  assert.equal(w.card?.abstract, null)
  assert.equal(w.card?.title, card.title)
  assert.deepEqual(w.aliases, ['openalex:W3001234567', 'pmid:31900000'])
  assert.equal(manifest.shards.some((s: { path: string }) => s.path === shardPath(W)), true)
  assert.equal(shardPath(W), `works/${workShard(W)}.jsonl`)

  // 标签 2:0 ⇒ accepted ⇒ present，带 quorum
  const adhd = w.tags.find((t) => t.tag_key === 'adhd')!
  assert.equal(adhd.state, 'present')
  assert.equal(adhd.label, 'ADHD')
  assert.equal(adhd.decided_by, 'contributor')
  assert.deepEqual([adhd.quorum?.n, adhd.quorum?.add, adhd.quorum?.remove], [2, 2, 0])
  assert.ok((adhd.quorum?.ci_low ?? 0) > 0.5)
  // 1 人反对只算挑战：Sleep 仍 pending（不在 tags 里），challenged
  assert.ok(!w.tags.some((t) => t.tag_key === 'sleep'))
  const sleep = w.pending.find((p) => p.subject === 'tag:sleep')!
  assert.equal(sleep.decision.state, 'pending')
  assert.deepEqual([sleep.decision.quorum?.challenged, sleep.decision.quorum?.challengers, sleep.decision.quorum?.n], [true, 1, 1])
  assert.deepEqual(sleep.decision.reasons, ['the paper does not measure sleep at all'])
  // design 带出处 ⇒ accepted（1 人提出是 pending；这里只有 c1 ⇒ pending）
  assert.equal(w.facets.design?.value, 'rct')
  assert.deepEqual(w.facets.design?.locators, ['Abstract-Methods'])
  assert.equal(w.facets.design?.decision.state, 'pending')
  // 行 o1：盲复录一致 ⇒ accepted / double；行 o2：复录不一致 ⇒ disputed + extraction_conflict
  const o1 = w.rows.find((r) => r.row_id === 'o1')!
  assert.equal(o1.decision.state, 'accepted')
  assert.equal(o1.decision.verification, 'double')
  assert.equal(o1.decision.re_extractions, 1)
  assert.deepEqual(o1.decision.issues, [])
  assert.deepEqual(o1.concept_ids, { outcome: 'c:outcome/adhd-symptoms', population: 'c:population/adults', timepoint: 'c:timepoint/8-weeks' })
  assert.ok(!('reviewed' in o1.input.context))
  const o2 = w.rows.find((r) => r.row_id === 'o2')!
  assert.equal(o2.decision.state, 'disputed')
  assert.ok(o2.decision.issues.includes('extraction_conflict'))
  // 一人抄 ⇒ pending / needs_re_extraction：再提一篇单抄的行验证
  // （o2 在复录前就是这个状态；这里直接用引擎在 o3 上验证）
  // W2：design 2:0 但缺 locator ⇒ 封顶 pending + missing_locator
  assert.equal(w2.facets.design?.decision.state, 'pending')
  assert.ok(w2.facets.design?.decision.issues.includes('missing_locator'))
  assert.equal(w2.facets.design?.decision.quorum?.n, 2)
  assert.deepEqual(w2.facets.design?.locators, [])
  // 绑定：编辑一人 ⇒ confirmed ⇒ curated
  assert.deepEqual(read.value.bindings.map((b) => [b.tag_key, b.kind, b.topic_id]), [['adhd', 'curated', 'openalex:T10537']])
  // frames：o1 够 double ⇒ 一条记录一个 frame；未审核 ⇒ blockers 里有 unreviewed
  assert.equal(read.value.frames.length, 1)
  assert.equal(read.value.frames[0]!.facets.outcome, 'c:outcome/adhd-symptoms')
  assert.ok(read.value.frames[0]!.blockers.includes('unreviewed'))
  assert.deepEqual(read.value.frames[0]!.tag_keys, ['adhd'])
  assert.deepEqual(read.value.frames[0]!.topic_ids, ['openalex:T10537'])
  assert.equal(files.manifest.counts.frames, 1)
  // 宿主端口：只有 o1 进记录，reviewed=false
  const ports = createCommunityPorts(read.value)
  const rec = ports.records()
  // W 的 o1 一条带效应的记录；W2 没有够格的行 ⇒ 引擎给一条没有效应的作品记录（只计篇数）
  assert.equal(rec.records.length, 2)
  assert.deepEqual(rec.records.filter((r) => r.effect).map((r) => r.id), [`community:${W}/o1`])
  assert.equal(rec.contexts.length, 1)
  assert.equal(rec.contexts[0]!.reviewed, false)
  // 队列
  const queues = JSON.parse(readFileSync(join(outDir, 'queues.json'), 'utf8'))
  assert.deepEqual(queues.disputed.map((d: { subject: string }) => d.subject), ['row:o2'])
  // 复录不一致的那个人也是「不够人数的反对者」⇒ 行 o2 同时进挑战队列
  assert.deepEqual(queues.challenged.map((d: { subject: string }) => d.subject), ['row:o2', 'tag:sleep'])
  assert.deepEqual(queues.unlisted_values[0], { facet: 'comparison', value: 'methylphenidate vs placebo', rows: 2 })

  // 行一人抄 ⇒ pending（needs_re_extraction）：再加一条 o3 单抄（换一个结局，不然与 o1 同槽位不同值 ⇒ competing_value），重导出
  ingest(8, actor(5), [rowItem('o3', -0.5, { outcome: 'Sleep quality' })])
  const second = runExport({ root, out: 'export/v1', now, sourceCommit: 'abc', repository: 'https://example.org/r', maintainers: ['m'] })
  const w1b = second.files.export.works.find((x) => x.work_id === W)!
  const o3 = w1b.rows.find((r) => r.row_id === 'o3')!
  assert.equal(o3.decision.state, 'pending')
  assert.equal(o3.decision.verification, 'single')
  assert.deepEqual(o3.decision.issues, ['needs_re_extraction'])
  assert.deepEqual(second.files.queues.needs_re_extraction, [{ work_id: W, row_id: 'o3', locator: 'Table 2 · row 1' }])
  assert.deepEqual(selfCheck(second.files), [])
  // 确定性：同一批断言 + 同一 generated_at ⇒ 同一批字节
  const third = runExport({ root, out: 'export/v1-b', now, sourceCommit: 'abc', repository: 'https://example.org/r', maintainers: ['m'] })
  assert.deepEqual(third.files.manifest.shards, second.files.manifest.shards)
  assert.equal(readFileSync(join(third.outDir, 'frames.json'), 'utf8'), readFileSync(join(second.outDir, 'frames.json'), 'utf8'))
})

test('黑名单：留档不计；导出的 pending 只放标签', () => {
  const root = makeTempRepo()
  const config = loadConfig(root)
  const vocab = loadVocab(root)
  const actor = (id: number): Actor => ({ id: `gh:${id}`, login: `u${id}`, tier: 'contributor', type: 'User', created_at: '2020-01-01T00:00:00Z' })
  const r = validateSubmission({ form: FORM_ID, work_id: W, items: [{ kind: 'tag', op: 'add', payload: { kind: 'tag', tag: 'ADHD' } }] }, actor(1), { config, facets: vocab.facets, existing: [], now, source: { issue: 1, form: FORM_ID } })
  appendJsonl(join(root, 'data', 'assertions', monthFile(now).rel), r.accepted)
  const before = runExport({ root, now, sourceCommit: null, repository: '', maintainers: [] })
  assert.equal(before.files.manifest.counts.works, 1)
  assert.equal((before.files.export.works[0] as EvidenceCommunityWork).pending.length, 1)
  writeFileSync(join(root, 'config', 'blocklist.json'), JSON.stringify({ blocked: ['gh:1'] }))
  const after = runExport({ root, now, sourceCommit: null, repository: '', maintainers: [] })
  assert.equal(after.files.manifest.counts.works, 0)
  assert.equal(after.files.manifest.counts.assertions, 1)
  assert.equal(after.files.manifest.counts.contributors, 0)
})
