/**
 * 入库：正文解析、评论命令、层级、校验（纯函数）、GitHub 封装（假 fetch）、整条流程（假 GitHub / OpenAlex / git）。不出网。
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { EvidenceAnnotation } from 'scholar-meta'
import { createGitHub } from './lib/github.js'
import {
  FORM_ID, commandToItems, parseCommand, parseIssueBody, renderReceipt, tierFor, validateSubmission,
} from './lib/intake-core.js'
import type { Actor, IntakeContext } from './lib/intake-core.js'
import { loadConfig, loadVocab, monthFile, readJsonl, annotationId } from './lib/store.js'
import { W, comment, fakeGit, fakeGitHub, fakeOpenAlex, issue, makeTempRepo, reExtractItem, renderIssueBody, rowItem, user } from './lib/test-fixtures.js'
import { runIntake } from './intake.js'

const root = makeTempRepo()
const config = loadConfig(root)
const vocab = loadVocab(root)
const now = new Date('2026-10-31T09:00:00Z')
const actor = (id: number, tier: Actor['tier'] = 'contributor', ageDays = 400): Actor =>
  ({ id: `gh:${id}`, login: `u${id}`, tier, type: 'User', created_at: new Date(now.getTime() - ageDays * 86_400_000).toISOString() })
const ctx = (existing: EvidenceAnnotation[] = [], issueNo = 1, over: Partial<IntakeContext> = {}): IntakeContext =>
  ({ config, facets: vocab.facets, existing, now, source: { issue: issueNo, form: FORM_ID }, ...over })
const payload = (items: unknown[], work = W) => ({ form: FORM_ID, work_id: work, items })

test('正文解析：表单渲染格式下的 json 块；没有 ⇒ no_payload；坏 JSON ⇒ bad_json', () => {
  const p = payload([{ kind: 'tag', op: 'add', subject: 'tag:adhd', payload: { kind: 'tag', tag: 'ADHD' } }])
  const r = parseIssueBody(renderIssueBody(p))
  assert.ok(r.ok)
  assert.deepEqual(r.raw, p)
  assert.deepEqual(parseIssueBody('hello'), { ok: false, code: 'no_payload' })
  assert.deepEqual(parseIssueBody('### 机器读的部分（请勿手改）\n\n```json\n{oops\n```'), { ok: false, code: 'bad_json' })
  // 没有标题也认带 "form" 的 json 块；CRLF 也行
  const loose = parseIssueBody('```json\r\n{"form":"annotate/1","work_id":"x","items":[]}\r\n```')
  assert.ok(loose.ok && (loose.raw as { form: string }).form === FORM_ID)
})

test('评论命令：/agree /disagree /unsure /accept /reject /bind /approve；非命令忽略', () => {
  assert.deepEqual(parseCommand('/agree tag:ADHD'), { cmd: 'agree', subject: 'tag:ADHD' })
  assert.deepEqual(parseCommand('  /disagree facet:design Methods says open label, not randomised'), { cmd: 'disagree', subject: 'facet:design', reason: 'Methods says open label, not randomised' })
  assert.deepEqual(parseCommand('/unsure row:o1'), { cmd: 'unsure', subject: 'row:o1' })
  assert.deepEqual(parseCommand('/accept all'), { cmd: 'accept', items: 'all' })
  assert.deepEqual(parseCommand('/accept 1,3'), { cmd: 'accept', items: [1, 3] })
  assert.deepEqual(parseCommand('/reject #2 wrong table'), { cmd: 'reject', items: [2], reason: 'wrong table' })
  assert.deepEqual(parseCommand('/bind ADHD openalex:T10537 Attention Deficit Hyperactivity Disorder'), { cmd: 'bind', tag_key: 'adhd', topic: { id: 'openalex:T10537', display_name: 'Attention Deficit Hyperactivity Disorder' } })
  assert.deepEqual(parseCommand('/bind adhd none'), { cmd: 'bind', tag_key: 'adhd', topic: null })
  assert.equal(parseCommand('/bind adhd not-a-topic'), null)
  assert.deepEqual(parseCommand('/approve'), { cmd: 'approve' })
  assert.equal(parseCommand('thanks!'), null)
  assert.equal(parseCommand('/unknown x'), null)
  const sub = { form: FORM_ID, work_id: W, items: [{ kind: 'tag', op: 'add', subject: 'tag:adhd', payload: {} }, { kind: 'row', op: 'add', subject: 'row:o1', payload: {} }] }
  const acc = commandToItems({ cmd: 'accept', items: 'all' }, sub)
  assert.ok(acc.ok && acc.items.length === 2 && acc.items.every((i) => i.op === 'endorse'))
  const rej = commandToItems({ cmd: 'reject', items: [2], reason: 'no' }, sub)
  assert.ok(rej.ok && rej.items[0]!.subject === 'row:o1' && rej.items[0]!.op === 'dispute')
  assert.deepEqual(commandToItems({ cmd: 'accept', items: [9] }, sub), { ok: false, code: 'subject_unknown' })
})

test('层级：admin / maintain → maintainer，write → editor，其余 contributor；roles.json 只能升', () => {
  assert.equal(tierFor('admin', {}, 'gh:1'), 'maintainer')
  assert.equal(tierFor('maintain', {}, 'gh:1'), 'maintainer')
  assert.equal(tierFor('write', {}, 'gh:1'), 'editor')
  assert.equal(tierFor('triage', {}, 'gh:1'), 'contributor')
  assert.equal(tierFor('none', {}, 'gh:1'), 'contributor')
  assert.equal(tierFor('none', { 'gh:1': 'editor' }, 'gh:1'), 'editor')
  assert.equal(tierFor('admin', { 'gh:1': 'editor' }, 'gh:1'), 'maintainer')
})

test('校验：标签归一；分面词表；作品键认不出；机器人；坏形状', () => {
  const ok = validateSubmission(payload([
    { kind: 'tag', op: 'add', subject: 'tag:ADHD', payload: { kind: 'tag', tag: ' #ADHD ' } },
    { kind: 'facet', op: 'add', payload: { kind: 'facet', facet: 'design', value: 'rct', locator: 'Methods', quote: 'randomly assigned' } },
    { kind: 'facet', op: 'add', payload: { kind: 'facet', facet: 'design', value: 'rct-ish' } },
    { kind: 'facet', op: 'add', payload: { kind: 'facet', facet: 'colour', value: 'red' } },
    { kind: 'tag', op: 'add', payload: { kind: 'tag', tag: '   ' } },
    { kind: 'tag', op: 'endorse', payload: { kind: 'tag', tag: 'x' } },
    'nope',
  ]), actor(1), ctx())
  assert.equal(ok.work_id, W)
  assert.equal(ok.accepted.length, 2)
  assert.equal(ok.accepted[0]!.subject, 'tag:adhd')
  assert.deepEqual(ok.accepted[0]!.payload, { kind: 'tag', tag: '#ADHD' })
  assert.deepEqual(ok.accepted[0]!.by, { kind: 'person', id: 'gh:1', tier: 'contributor' })
  assert.deepEqual(ok.accepted[0]!.source, { issue: 1, comment: null, form: FORM_ID })
  assert.match(ok.accepted[0]!.id, /^a_[0-9a-f]{20}$/)
  assert.deepEqual(ok.ignored, [{ index: 1, subject: 'facet:design', field: 'quote' }])
  assert.deepEqual(ok.rejected.map((r) => r.code), ['facet_value_unknown', 'facet_unknown', 'tag_invalid', 'op_invalid', 'bad_item'])
  assert.deepEqual(validateSubmission(payload([], 'https://example.org/paper'), actor(1), ctx()).rejected.map((r) => r.code), ['work_unresolved'])
  assert.deepEqual(validateSubmission(payload([], 'A title of a paper'), actor(1), ctx()).rejected.map((r) => r.code), ['work_unresolved'])
  assert.deepEqual(validateSubmission(payload([]), { ...actor(1), type: 'Bot' }, ctx()).rejected.map((r) => r.code), ['bots_not_allowed'])
  assert.deepEqual(validateSubmission({ form: 'other/1' }, actor(1), ctx()).rejected.map((r) => r.code), ['bad_form'])
  // 同一 DOI 的不同写法 ⇒ 同一作品键
  assert.equal(validateSubmission(payload([], 'https://doi.org/10.1016/J.JAD.2020.01.001'), actor(1), ctx()).work_id, W)
  assert.equal(validateSubmission(payload([], 'https://openalex.org/W3001234567'), actor(1), ctx()).work_id, 'openalex:W3001234567')
})

test('校验：结果行走引擎验形；贡献者的 reviewed / independence_verified / dependence_id 剥掉并记 field_ignored；坏区间拒并回人话', () => {
  const r = validateSubmission(payload([
    rowItem('o1', -0.42, { reviewed: true, independence_verified: true, dependence_id: 'nct:1', study_id: 'nct:1' }),
    { kind: 'row', op: 'add', subject: 'row:o2', payload: { kind: 'row', context: { ...rowItem('o2', 0).payload.context }, effect: { metric: 'smd', value: 0.2, ci_low: 0.5, ci_high: 0.9, n: 10, p_value: null, higher_is_better: false }, direction: null } },
    { kind: 'row', op: 'add', subject: 'row:o3', payload: { kind: 'row', context: { row_id: 'o3', outcome: 'x' }, effect: null, direction: 'favours' } },
    { kind: 'row', op: 'add', subject: 'row:bad id', payload: { kind: 'row', context: { row_id: 'bad id' }, effect: null, direction: null } },
    { kind: 'row', op: 'add', subject: 'row:o1', payload: { kind: 'row', context: rowItem('o5', 0).payload.context, effect: null, direction: null } },
  ]), actor(1), ctx())
  assert.equal(r.accepted.length, 1)
  const row = r.accepted[0]!.payload as Extract<EvidenceAnnotation['payload'], { kind: 'row' }>
  assert.deepEqual(Object.keys(row.context).sort(), ['analysis', 'comparison', 'kind', 'locator', 'outcome', 'population', 'row_id', 'study_id', 'timepoint', 'unit'])
  assert.equal(row.context.study_id, 'nct:1')
  assert.deepEqual(r.ignored.map((i) => i.field).sort(), ['context.dependence_id', 'context.independence_verified', 'context.reviewed'])
  assert.deepEqual(r.rejected.map((x) => x.code), ['row_invalid', 'row_invalid', 'row_invalid', 'subject_mismatch'])
  assert.match(r.rejected[0]!.text, /区间/) // ci_excludes_estimate 的人话
  assert.match(r.rejected[1]!.text, /语境不全/)
  // 字符串数字按引擎归一后存成数字
  const s = validateSubmission(payload([{ kind: 'row', op: 'add', subject: 'row:o9', payload: { kind: 'row', context: rowItem('o9', 0).payload.context, effect: { metric: 'smd', value: '-0.42', ci_low: '-0.7', ci_high: '-0.1', n: '100', p_value: null, higher_is_better: false }, direction: null } }]), actor(1), ctx())
  assert.deepEqual((s.accepted[0]!.payload as { effect: unknown }).effect, { metric: 'smd', value: -0.42, ci_low: -0.7, ci_high: -0.1, n: 100, p_value: null, higher_is_better: false })
})

test('校验：评议要有对象；自己不能认可自己；不认可要 ≥ 10 字理由；贡献者认可行要带复录；编辑不用', () => {
  const base = validateSubmission(payload([{ kind: 'tag', op: 'add', payload: { kind: 'tag', tag: 'ADHD' } }, rowItem('o1', -0.42)]), actor(1), ctx())
  const existing = base.accepted
  const r = validateSubmission(payload([
    { kind: 'review', op: 'endorse', subject: 'tag:ADHD', payload: { kind: 'review', reason: null } },
    { kind: 'review', op: 'endorse', subject: 'tag:nothing', payload: { kind: 'review', reason: null } },
    { kind: 'review', op: 'dispute', subject: 'tag:adhd', payload: { kind: 'review', reason: 'short' } },
    { kind: 'review', op: 'endorse', subject: 'row:o1', payload: { kind: 'review', reason: null } },
    reExtractItem('o1', -0.42),
    { kind: 'review', op: 'unsure', subject: 'row:o1', payload: { kind: 'review', reason: null } },
  ]), actor(2), ctx(existing, 2))
  assert.deepEqual(r.rejected.map((x) => x.code), ['subject_unknown', 'dispute_reason_too_short', 'row_endorse_needs_re_extraction'])
  assert.equal(r.accepted.length, 3)
  assert.equal(r.accepted[0]!.subject, 'tag:adhd')
  assert.deepEqual(r.accepted[1]!.payload, { kind: 'review', reason: null, re_extraction: { effect: { metric: 'smd', value: -0.42, ci_low: -0.72, ci_high: -0.12, n: 212, p_value: 0.004, higher_is_better: false }, direction: null }, peeked: false })
  const self = validateSubmission(payload([{ kind: 'review', op: 'endorse', subject: 'tag:adhd', payload: { kind: 'review', reason: null } }]), actor(1), ctx(existing, 3))
  assert.deepEqual(self.rejected.map((x) => x.code), ['self_endorse'])
  const ed = validateSubmission(payload([{ kind: 'review', op: 'endorse', subject: 'row:o1', payload: { kind: 'review', reason: null } }]), actor(9, 'editor'), ctx(existing, 4))
  assert.equal(ed.accepted.length, 1)
  // 同一人在同一对象上的上一条进 supersedes
  const again = validateSubmission(payload([{ kind: 'review', op: 'dispute', subject: 'tag:adhd', payload: { kind: 'review', reason: 'changed my mind, not about ADHD' } }]), actor(2), ctx([...existing, ...r.accepted], 5))
  assert.equal(again.accepted[0]!.supersedes, r.accepted[0]!.id)
})

test('校验：绑定 / 独立性 / 偏倚评估只收编辑及以上；形状不对拒', () => {
  const row = validateSubmission(payload([rowItem('o1', -0.42)]), actor(1), ctx()).accepted
  const items = [
    { kind: 'binding', op: 'add', subject: 'binding:ADHD', payload: { kind: 'binding', topic: { id: 'openalex:T10537', display_name: 'ADHD' } } },
    { kind: 'independence', op: 'set', subject: 'row:o1', payload: { kind: 'independence', study_id: 'nct:1', dependence_id: 'nct:1', independence_verified: true, note: null } },
    { kind: 'appraisal', op: 'add', payload: { kind: 'appraisal', tool: 'rob2', overall: 'low', source: 'Cochrane review 2021' } },
  ]
  const low = validateSubmission(payload(items), actor(1), ctx(row))
  assert.deepEqual(low.rejected.map((x) => x.code), ['insufficient_tier', 'insufficient_tier', 'insufficient_tier'])
  const ed = validateSubmission(payload(items), actor(9, 'editor'), ctx(row))
  assert.deepEqual(ed.accepted.map((a) => a.subject), ['binding:adhd', 'row:o1', 'appraisal:rob2'])
  const bad = validateSubmission(payload([
    { kind: 'binding', op: 'add', subject: 'binding:adhd', payload: { kind: 'binding', topic: { id: 'T10537', display_name: 'ADHD' } } },
    { kind: 'independence', op: 'set', subject: 'row:none', payload: { kind: 'independence', study_id: 'x', dependence_id: 'x', independence_verified: true, note: null } },
    { kind: 'appraisal', op: 'add', payload: { kind: 'appraisal', tool: 'rob9', overall: 'low', source: 'x' } },
  ]), actor(9, 'editor'), ctx(row))
  assert.deepEqual(bad.rejected.map((x) => x.code), ['binding_invalid', 'subject_unknown', 'appraisal_invalid'])
})

test('防滥用：账号太新 ⇒ held；日上限；单 issue 上限；单篇行上限；幂等（同 id 不重收）', () => {
  const young = validateSubmission(payload([{ kind: 'tag', op: 'add', payload: { kind: 'tag', tag: 'ADHD' } }]), actor(1, 'contributor', 2), ctx())
  assert.equal(young.held, true)
  assert.equal(young.accepted.length, 1) // 搁置由调用方决定写不写
  assert.equal(validateSubmission(payload([{ kind: 'tag', op: 'add', payload: { kind: 'tag', tag: 'ADHD' } }]), actor(9, 'editor', 2), ctx()).held, false)
  const today = now.toISOString()
  const many: EvidenceAnnotation[] = Array.from({ length: config.abuse.daily_issue_limit }, (_, i) => ({
    id: `a_${String(i).padStart(20, '0')}`, at: today, work_id: `doi:10.1/${i}`, kind: 'tag', op: 'add', subject: 'tag:x', by: { kind: 'person', id: 'gh:1', tier: 'contributor' },
    payload: { kind: 'tag', tag: 'x' }, note: null, source: { issue: 100 + i, form: FORM_ID }, supersedes: null,
  }))
  assert.deepEqual(validateSubmission(payload([{ kind: 'tag', op: 'add', payload: { kind: 'tag', tag: 'ADHD' } }]), actor(1), ctx(many, 999)).rejected.map((x) => x.code), ['daily_limit'])
  const tooMany = validateSubmission(payload(Array.from({ length: config.abuse.max_assertions_per_issue + 2 }, (_, i) => ({ kind: 'tag', op: 'add', payload: { kind: 'tag', tag: `t${i}` } }))), actor(1), ctx())
  assert.equal(tooMany.accepted.length, config.abuse.max_assertions_per_issue)
  assert.deepEqual([...new Set(tooMany.rejected.map((x) => x.code))], ['issue_limit'])
  const rows = validateSubmission(payload(Array.from({ length: config.abuse.max_rows_per_work + 1 }, (_, i) => rowItem(`r${i}`, -0.1))), actor(1), ctx())
  assert.equal(rows.accepted.length, config.abuse.max_rows_per_work)
  assert.deepEqual(rows.rejected.map((x) => x.code), ['rows_per_work_limit'])
  const first = validateSubmission(payload([{ kind: 'tag', op: 'add', payload: { kind: 'tag', tag: 'ADHD' } }]), actor(1), ctx())
  const rerun = validateSubmission(payload([{ kind: 'tag', op: 'add', payload: { kind: 'tag', tag: 'ADHD' } }]), actor(1), ctx(first.accepted))
  assert.equal(rerun.accepted.length, 0)
  assert.equal(rerun.duplicates, 1)
  assert.equal(annotationId(first.accepted[0]!), first.accepted[0]!.id)
})

test('回执：表 + 拒收 + 剥掉的字段 + 待定提示（中英）', () => {
  const r = validateSubmission(payload([{ kind: 'tag', op: 'add', payload: { kind: 'tag', tag: 'ADHD' } }, rowItem('o1', -0.42, { reviewed: true }), { kind: 'tag', op: 'add', payload: { kind: 'tag', tag: '' } }]), actor(1), ctx())
  const text = renderReceipt({ result: r, decisions: [], actorLogin: 'u1' })
  assert.match(text, /@u1 入库完成/)
  assert.match(text, /收 \*\*2\*\* 条，拒 \*\*1\*\* 条/)
  assert.match(text, /field_ignored/)
  assert.match(text, /context\.reviewed/)
  assert.match(text, /待定/)
  assert.match(text, /pending/)
  assert.match(text, /导出将在下一次构建更新/)
})

test('GitHub 封装：分页跟 Link；权限 404 ⇒ none；评论 / 标签 / 关闭走对的路径', async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = []
  const f: typeof fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null })
    const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } })
    if (url.includes('/issues?') && !url.includes('page=2')) return json([{ number: 1, labels: [], pull_request: {} }, { number: 2, labels: [] }], 200, { link: '<https://api.github.com/repos/o/r/issues?page=2>; rel="next"' })
    if (url.includes('page=2')) return json([{ number: 3, labels: [] }])
    if (url.includes('/collaborators/nobody/permission')) return new Response('not found', { status: 404 })
    if (url.includes('/collaborators/ed/permission')) return json({ permission: 'write', role_name: 'write' })
    if (url.includes('/users/ghost')) return new Response('', { status: 404 })
    if (url.includes('/users/ed')) return json({ id: 9, login: 'ed', type: 'User', created_at: '2020-01-01T00:00:00Z', email: 'should-not-be-read' })
    if (url.endsWith('/comments') && init?.method === 'POST') return json({ id: 55 })
    if (url.includes('/labels/held') && init?.method === 'DELETE') return new Response('', { status: 404 })
    return json({})
  }
  const gh = createGitHub({ token: 't', repo: 'o/r', fetch: f })
  const issues = await gh.listIssues({ labels: 'annotation' })
  assert.deepEqual(issues.map((i) => i.number), [2, 3])
  assert.equal(await gh.getPermission('nobody'), 'none')
  assert.equal(await gh.getPermission('ed'), 'write')
  assert.equal(await gh.getUser('ghost'), null)
  assert.deepEqual(await gh.getUser('ed'), { id: 9, login: 'ed', type: 'User', created_at: '2020-01-01T00:00:00Z' })
  assert.equal(await gh.comment(2, 'hi'), 55)
  await gh.addLabels(2, ['ingested'])
  await gh.removeLabel(2, 'held')
  await gh.close(2, 'completed')
  assert.ok(calls.some((c) => c.method === 'PATCH' && c.url.endsWith('/issues/2') && JSON.stringify(c.body) === JSON.stringify({ state: 'closed', state_reason: 'completed' })))
  assert.ok(calls.every((c) => c.url.startsWith('https://api.github.com/')))
  assert.throws(() => createGitHub({ token: 't', repo: 'bad' }))
})

test('整条流程：扫 issue → 校验 → 名片 → 追加 JSONL → 提交推送 → 回评 → 关闭；held / deferred / retry；评论命令', async () => {
  const repo = makeTempRepo()
  const users = [user(1, 'alice'), user(2, 'bob'), user(3, 'carol', 'none', 1), user(9, 'ed', 'write'), user(11, 'root', 'admin')]
  const body1 = renderIssueBody(payload([{ kind: 'tag', op: 'add', payload: { kind: 'tag', tag: 'ADHD' } }, rowItem('o1', -0.42, { reviewed: true })]))
  const body2 = renderIssueBody(payload([{ kind: 'review', op: 'endorse', subject: 'tag:adhd', payload: { kind: 'review', reason: null } }, reExtractItem('o1', -0.421)]))
  const body3 = renderIssueBody(payload([{ kind: 'tag', op: 'add', payload: { kind: 'tag', tag: 'Sleep' } }]))
  const fake = fakeGitHub({
    issues: [issue(1, 'alice', 1, body1), issue(2, 'bob', 2, body2), issue(3, 'carol', 3, body3), issue(4, 'bob', 2, 'no payload here'), issue(5, 'alice', 1, body1, ['other'])],
    comments: { 1: [comment(100, 'bob', 2, '/disagree tag:adhd this paper is about insomnia, not ADHD'), comment(101, 'alice', 1, '/agree tag:adhd'), comment(102, 'bob', 2, 'just chatting')] },
    users,
  })
  const git = fakeGit()
  const run = await runIntake({ root: repo, github: fake.gh, openalex: fakeOpenAlex('found'), git: git.git, now: () => now, log: () => {}, sleep: async () => {} })
  assert.deepEqual(run.processed, [1, 2])
  assert.deepEqual(run.skipped, [{ issue: 3, reason: 'held' }, { issue: 4, reason: 'no_payload' }])
  assert.equal(run.changed, true)
  // 写入：当月片、名片（摘要为空）、登录名快照
  const file = join(repo, 'data', 'assertions', monthFile(now).rel)
  const rows = readJsonl<EvidenceAnnotation>(file).rows.map((r) => r.value)
  assert.deepEqual(rows.map((a) => [a.subject, a.op, a.by.id]), [['tag:adhd', 'add', 'gh:1'], ['row:o1', 'add', 'gh:1'], ['tag:adhd', 'dispute', 'gh:2'], ['tag:adhd', 'endorse', 'gh:2'], ['row:o1', 'endorse', 'gh:2']])
  assert.equal(rows[2]!.source.comment, 100)
  assert.equal(rows[2]!.source.form, 'command/1')
  assert.ok(rows[3]!.at > rows[2]!.at) // 表单后的评论命令时间更晚（同一人最新立场 ⇒ 认可）
  const worksDir = join(repo, 'data', 'works')
  const snap = readJsonl<{ work_id: string; aliases: string[]; card: { abstract: unknown } }>(join(worksDir, `${(await import('./lib/store.js')).workShard(W)}.jsonl`)).rows[0]!.value
  assert.equal(snap.work_id, W)
  assert.equal(snap.card.abstract, null)
  assert.deepEqual(snap.aliases, ['openalex:W3001234567', 'pmid:31900000'])
  assert.deepEqual(readJsonl<{ login: string }>(join(repo, 'data', 'actors.jsonl')).rows.map((r) => r.value.login), ['alice', 'bob'])
  assert.ok(!readFileSync(join(repo, 'data', 'actors.jsonl'), 'utf8').includes('@'))
  // git：add → diff → commit → pull --rebase → push，每条 issue 一次
  const commits = git.calls.filter((c) => c[0] === 'commit').map((c) => c.at(-1))
  assert.deepEqual(commits, ['ingest: issue #1', 'ingest: issue #2'])
  assert.ok(git.calls.some((c) => c[0] === 'pull' && c.includes('--rebase')))
  // 回评与标签：#1 ingested + completed，#2 ingested，#3 held，#4 rejected + not_planned
  const ops = (n: number) => fake.log.filter((l) => l.issue === n).map((l) => `${l.op}:${Array.isArray(l.args) ? l.args.join(',') : typeof l.args === 'string' && l.op !== 'comment' ? l.args : ''}`)
  assert.deepEqual(ops(1), ['comment:', 'addLabels:ingested', 'close:completed'])
  assert.deepEqual(ops(3), ['comment:', 'addLabels:held'])
  assert.deepEqual(ops(4), ['comment:', 'addLabels:rejected', 'close:not_planned'])
  const receipt1 = fake.log.find((l) => l.op === 'comment' && l.issue === 1)!.args as string
  assert.match(receipt1, /tag:adhd/)
  assert.match(receipt1, /context\.reviewed/)
  assert.match(receipt1, /自己提出的/) // alice /agree 自己的标签 ⇒ self_endorse
  const receipt2 = fake.log.find((l) => l.op === 'comment' && l.issue === 2)!.args as string
  assert.match(receipt2, /两人独立一致|double/) // 盲复录一致 ⇒ double
  // 第二次运行：全部幂等，没有新东西
  const again = await runIntake({ root: repo, github: fake.gh, openalex: fakeOpenAlex('found'), git: git.git, now: () => new Date(now.getTime() + 60_000), log: () => {}, sleep: async () => {} })
  assert.equal(again.changed, false)
  assert.equal(readJsonl(file).rows.length, 5)
  // held 的 issue 被维护者 /approve 后放行
  fake.issues.find((i) => i.number === 3)!.labels.push({ name: 'held' })
  const held = fakeGitHub({ issues: [fake.issues.find((i) => i.number === 3)!], comments: { 3: [comment(300, 'root', 11, '/approve')] }, users })
  const released = await runIntake({ root: repo, github: held.gh, openalex: fakeOpenAlex('found'), git: git.git, now: () => now, log: () => {}, sleep: async () => {} })
  assert.deepEqual(released.processed, [3])
  assert.ok(held.log.some((l) => l.op === 'removeLabel' && l.args === 'held'))
  assert.equal(readJsonl(file).rows.length, 6)
})

test('整条流程：OpenAlex 没问成 ⇒ deferred 保持 open、不写；not_found ⇒ 照收、名片为 null；推送失败 ⇒ retry', async () => {
  const body = renderIssueBody(payload([{ kind: 'tag', op: 'add', payload: { kind: 'tag', tag: 'ADHD' } }], 'doi:10.9999/unknown'), 'doi:10.9999/unknown')
  const users = [user(1, 'alice')]
  const repo = makeTempRepo()
  const deferred = fakeGitHub({ issues: [issue(1, 'alice', 1, body)], users })
  const d = await runIntake({ root: repo, github: deferred.gh, openalex: fakeOpenAlex('error'), git: null, now: () => now, log: () => {} })
  assert.deepEqual(d.skipped, [{ issue: 1, reason: 'deferred' }])
  assert.ok(deferred.log.some((l) => l.op === 'addLabels' && (l.args as string[]).includes('deferred')))
  assert.ok(!existsSync(join(repo, 'data', 'assertions', monthFile(now).rel)))
  const notFound = fakeGitHub({ issues: [issue(1, 'alice', 1, body)], users })
  const nf = await runIntake({ root: repo, github: notFound.gh, openalex: fakeOpenAlex('not_found'), git: null, now: () => now, log: () => {} })
  assert.deepEqual(nf.processed, [1])
  const snaps = readJsonl<{ card: unknown }>(join(repo, 'data', 'works', `${(await import('./lib/store.js')).workShard('doi:10.9999/unknown')}.jsonl`)).rows
  assert.equal(snaps[0]!.value.card, null)
  const repo2 = makeTempRepo()
  const retry = fakeGitHub({ issues: [issue(1, 'alice', 1, body)], users })
  const git = fakeGit(99)
  const r = await runIntake({ root: repo2, github: retry.gh, openalex: fakeOpenAlex('found'), git: git.git, now: () => now, log: () => {}, sleep: async () => {} })
  assert.deepEqual(r.skipped, [{ issue: 1, reason: 'retry' }])
  assert.equal(r.changed, false)
  assert.equal(git.calls.filter((c) => c[0] === 'push').length, 4) // 1 + 3 次重试
  assert.ok(retry.log.some((l) => l.op === 'addLabels' && (l.args as string[]).includes('retry')))
})
