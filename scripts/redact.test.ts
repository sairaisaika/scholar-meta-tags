/**
 * 抹名：by.id 换成盐哈希（同一人同一键，裁决不变）；actors 删行；REDACTIONS.md 记条数不记登录名；没有盐 / 坏 id 拒。
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveAnnotations } from 'scholar-meta'
import { FORM_ID, validateSubmission } from './lib/intake-core.js'
import type { Actor } from './lib/intake-core.js'
import { appendJsonl, loadActors, loadAssertions, loadConfig, loadVocab, monthFile, policyOf } from './lib/store.js'
import { W, makeTempRepo, rowItem } from './lib/test-fixtures.js'
import { redact, redactedId } from './redact.js'
import { checkRepo } from './check.js'

test('redact：替换、删行、记录、裁决不变', () => {
  const root = makeTempRepo()
  const config = loadConfig(root)
  const vocab = loadVocab(root)
  const actor = (id: number): Actor => ({ id: `gh:${id}`, login: `u${id}`, tier: 'contributor', type: 'User', created_at: '2020-01-01T00:00:00Z' })
  const now = new Date('2026-10-31T00:00:00Z')
  const a = validateSubmission({ form: FORM_ID, work_id: W, items: [{ kind: 'tag', op: 'add', payload: { kind: 'tag', tag: 'ADHD' } }, rowItem('o1', -0.42)] }, actor(1), { config, facets: vocab.facets, existing: [], now, source: { issue: 1, form: FORM_ID } })
  const b = validateSubmission({ form: FORM_ID, work_id: W, items: [{ kind: 'review', op: 'endorse', subject: 'tag:adhd', payload: { kind: 'review', reason: null } }] }, actor(2), { config, facets: vocab.facets, existing: a.accepted, now: new Date(now.getTime() + 1000), source: { issue: 2, form: FORM_ID } })
  appendJsonl(join(root, 'data', 'assertions', monthFile(now).rel), [...a.accepted, ...b.accepted])
  writeFileSync(join(root, 'data', 'actors.jsonl'), [{ id: 'gh:1', login: 'alice', seen_at: '' }, { id: 'gh:2', login: 'bob', seen_at: '' }].map((x) => JSON.stringify(x)).join('\n') + '\n')
  const before = resolveAnnotations(loadAssertions(root).assertions, policyOf(config))

  const r = redact('gh:1', 'salt', root, now)
  assert.equal(r.replaced, 2)
  assert.equal(r.actorRowsRemoved, 1)
  assert.equal(r.to, redactedId('gh:1', 'salt'))
  assert.match(r.to, /^redacted:[0-9a-f]{12}$/)
  const after = loadAssertions(root).assertions
  assert.ok(!after.some((x) => x.by.id === 'gh:1'))
  assert.equal(after.filter((x) => x.by.id === r.to).length, 2)
  assert.deepEqual([...loadActors(root).keys()], ['gh:2'])
  const md = readFileSync(join(root, 'data', 'REDACTIONS.md'), 'utf8')
  assert.match(md, /2026-10-31：2 条断言、1 行登录名快照/)
  assert.ok(!md.includes('alice'))
  // 裁决不变（同一人仍是同一键）
  const strip = (d: ReturnType<typeof resolveAnnotations>) => d.map((x) => ({ subject: x.subject, state: x.state, support: x.support, quorum: x.quorum }))
  assert.deepEqual(strip(resolveAnnotations(after, policyOf(config))), strip(before))
  assert.deepEqual(checkRepo(root), [])
  assert.throws(() => redact('alice', 'salt', root), /gh:/)
  assert.throws(() => redact('gh:1', '', root), /REDACT_SALT/)
})
