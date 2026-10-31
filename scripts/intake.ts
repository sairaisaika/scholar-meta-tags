/**
 * 入库 Action：扫全部待处理 issue（标签 `annotation`、open、没有 `ingested` / `rejected`）与触发它的那条评论，
 * 鉴权（仓库权限 → 层级）→ 校验（`lib/intake-core.ts`，纯函数）→ 名片（没有快照的作品问一次 OpenAlex）→ 追加 JSONL
 * → git 提交推送（失败退避重试，仍失败标 `retry`）→ 回评（裁决表）→ 标签与关闭。输出 `changed=true|false` 到 `$GITHUB_OUTPUT`。
 * 环境：`GH_TOKEN`、`GH_REPO`（owner/repo）、`OPENALEX_API_KEY`（可选）、`TRIGGER_ISSUE` / `TRIGGER_COMMENT`（事件给的）。
 * 本地试跑：`pnpm intake --dry`（不提交不推、不回评，只打印）。
 */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseWorkRef, resolveAnnotations } from 'scholar-meta'
import type { EvidenceAnnotation } from 'scholar-meta'
import { createGitHub } from './lib/github.js'
import type { GhComment, GhIssue, GitHub } from './lib/github.js'
import { createOpenAlex } from './lib/openalex.js'
import type { OpenAlex } from './lib/openalex.js'
import { commitAndPush, realGit } from './lib/git.js'
import type { GitRunner } from './lib/git.js'
import {
  COMMAND_FORM_ID, DEFERRED_TEXT, FORM_ID, HOLD_TEXT, NO_PAYLOAD_TEXT, RETRY_TEXT, commandToItems, parseCommand, parseIssueBody, renderReceipt, submissionWorkKey, tierFor, validateSubmission,
} from './lib/intake-core.js'
import type { Actor, IntakeResult, Submission } from './lib/intake-core.js'
import {
  REPO_ROOT, appendJsonl, appendWork, findWork, loadActors, loadAssertions, loadBlocklist, loadConfig, loadRoles, loadVocab, loadWorks, monthFile, paths, policyOf, rememberActor,
} from './lib/store.js'
import type { WorkSnapshot } from './lib/store.js'

export const LABELS = { annotation: 'annotation', ingested: 'ingested', rejected: 'rejected', held: 'held', deferred: 'deferred', retry: 'retry' } as const

export interface IntakeDeps {
  root?: string
  github: GitHub
  openalex: OpenAlex
  /** null ⇒ 不提交不推 */
  git: GitRunner | null
  now?: () => Date
  triggerIssue?: number | null
  triggerComment?: number | null
  /** 只打印，不回评、不改标签、不写文件 */
  dry?: boolean
  log?: (s: string) => void
  sleep?: (ms: number) => Promise<void>
}

export interface IntakeRun { changed: boolean; processed: number[]; skipped: Array<{ issue: number; reason: string }> }

const has = (issue: GhIssue, label: string) => issue.labels.some((l) => l.name === label)

export async function runIntake(deps: IntakeDeps): Promise<IntakeRun> {
  const root = deps.root ?? REPO_ROOT
  const log = deps.log ?? ((s: string) => console.log(s))
  const clock = deps.now ?? (() => new Date())
  // 入库时刻严格递增：处理顺序 ＝ `at` 顺序（同一人先后两条立场才分得出先后）
  let lastAt = 0
  const now = () => { const t = Math.max(clock().getTime(), lastAt + 1); lastAt = t; return new Date(t) }
  const gh = deps.github
  const config = loadConfig(root)
  const policy = policyOf(config)
  const roles = loadRoles(root)
  const blocklist = loadBlocklist(root)
  const vocab = loadVocab(root)
  const works = loadWorks(root)
  const actors = loadActors(root)
  const { assertions: all, bad } = loadAssertions(root)
  if (bad.length > 0) throw new Error(`断言文件有坏行：${bad.map((b) => `${b.file}:${b.line}`).join(', ')}`)
  const run: IntakeRun = { changed: false, processed: [], skipped: [] }

  // 待处理：open + annotation − ingested − rejected；外加触发这次运行的那条（可能已关闭：只处理评论命令）
  const open = (await gh.listIssues({ labels: LABELS.annotation, state: 'open' })).filter((i) => !has(i, LABELS.ingested) && !has(i, LABELS.rejected))
  const queue: Array<{ issue: GhIssue; commandsOnly: boolean }> = open.map((issue) => ({ issue, commandsOnly: false }))
  if (deps.triggerIssue && !open.some((i) => i.number === deps.triggerIssue)) {
    const t = await gh.getIssue(deps.triggerIssue)
    if (t && has(t, LABELS.annotation) && !t.pull_request) queue.push({ issue: t, commandsOnly: true })
  }

  const actorCache = new Map<string, Actor | null>()
  const resolveActor = async (login: string): Promise<Actor | null> => {
    if (actorCache.has(login)) return actorCache.get(login)!
    const user = await gh.getUser(login)
    if (!user) { actorCache.set(login, null); return null }
    const id = `gh:${user.id}`
    const permission = user.type.toLowerCase() === 'bot' ? 'none' : await gh.getPermission(login)
    const actor: Actor = { id, login: user.login, tier: tierFor(permission, roles, id), type: user.type, created_at: user.created_at }
    actorCache.set(login, actor)
    return actor
  }
  const say = async (n: number, body: string) => { if (deps.dry) log(`[dry] comment #${n}:\n${body}`); else await gh.comment(n, body) }
  const label = async (n: number, add: string[], remove: string[]) => {
    if (deps.dry) { log(`[dry] labels #${n}: +${add.join(',')} -${remove.join(',')}`); return }
    await gh.addLabels(n, add)
    for (const l of remove) await gh.removeLabel(n, l)
  }

  for (const { issue, commandsOnly } of queue) {
    const n = issue.number
    const t0 = now()
    const author = await resolveActor(issue.user.login)
    if (!author) { run.skipped.push({ issue: n, reason: 'author_not_found' }); continue }
    const parsed = parseIssueBody(issue.body)
    if (!parsed.ok) {
      if (!commandsOnly) { await say(n, NO_PAYLOAD_TEXT); await label(n, [LABELS.rejected], []); if (!deps.dry) await gh.close(n, 'not_planned') }
      run.skipped.push({ issue: n, reason: parsed.code })
      continue
    }
    const submission = parsed.raw as Submission
    const context = (source: { issue: number; comment?: number | null; form: string }, at: Date, work_id?: string | null) =>
      ({ config, facets: vocab.facets, existing: all, now: at, source, ...(work_id ? { work_id } : {}) })

    // ① 表单正文
    const results: Array<{ actor: Actor; result: IntakeResult }> = []
    let body: IntakeResult | null = null
    if (!commandsOnly) {
      body = validateSubmission(submission, author, context({ issue: n, form: FORM_ID }, t0))
      results.push({ actor: author, result: body })
      all.push(...body.accepted) // 评论命令要能评到正文刚提出的对象
    }
    const workId = body?.work_id ?? submissionWorkKey(submission)
    if (!workId) {
      if (!body) { run.skipped.push({ issue: n, reason: 'work_unresolved' }); continue }
      await say(n, renderReceipt({ result: body, decisions: [], actorLogin: author.login }))
      await label(n, [LABELS.rejected], [LABELS.held, LABELS.deferred, LABELS.retry])
      if (!deps.dry) await gh.close(n, 'not_planned')
      run.processed.push(n)
      continue
    }

    // ② 评论命令（commandsOnly 时只看触发的那条，免得每次运行重复回评）
    const comments = await gh.listComments(n)
    let approved = false
    const heldCommenters: string[] = []
    for (const c of comments as GhComment[]) {
      if (commandsOnly && deps.triggerComment && c.id !== deps.triggerComment) continue
      const cmd = parseCommand(c.body)
      if (!cmd) continue
      const commenter = await resolveActor(c.user.login)
      if (!commenter || commenter.type.toLowerCase() === 'bot') continue
      if (cmd.cmd === 'approve') { if (commenter.tier === 'maintainer') approved = true; continue }
      if ((cmd.cmd === 'accept' || cmd.cmd === 'reject' || cmd.cmd === 'bind') && commenter.tier === 'contributor') continue
      const items = commandToItems(cmd, submission)
      const at = now()
      const raw = items.ok ? { form: FORM_ID, work_id: workId, items: items.items } : { form: FORM_ID, work_id: workId, items: [{ kind: 'review', op: 'endorse', subject: '?', payload: {} }] }
      const r = validateSubmission(raw, commenter, context({ issue: n, comment: c.id, form: COMMAND_FORM_ID }, at, workId))
      if (r.held) { heldCommenters.push(commenter.login); continue }
      results.push({ actor: commenter, result: r })
      // 同一次运行里后面的命令要能看到前面的
      all.push(...r.accepted)
    }
    for (const r of results) for (const a of r.result.accepted) if (!all.includes(a)) all.push(a)

    // ③ 账号太新：搁置等 /approve
    if (body?.held && !approved) {
      if (!has(issue, LABELS.held)) { await say(n, HOLD_TEXT(config.abuse.min_account_age_days)); await label(n, [LABELS.held], []) }
      for (const r of results) removeAll(all, r.result.accepted)
      run.skipped.push({ issue: n, reason: 'held' })
      continue
    }

    const accepted: EvidenceAnnotation[] = results.flatMap((r) => r.result.accepted)
    const rejectedCount = results.reduce((s, r) => s + r.result.rejected.length, 0)
    const duplicates = results.reduce((s, r) => s + r.result.duplicates, 0)
    if (commandsOnly && accepted.length === 0 && rejectedCount === 0) { run.skipped.push({ issue: n, reason: 'nothing_new' }); continue }

    // ④ 名片：没有快照的作品问一次 OpenAlex；问不成 ⇒ deferred（外部源失败 ≠ 论文不存在）
    let snapshot: WorkSnapshot | null = null
    if (accepted.length > 0 && !findWork(works, workId)) {
      const ref = parseWorkRef(workId)!
      const card = await deps.openalex.fetchCard(ref)
      if (card.kind === 'error') {
        if (!has(issue, LABELS.deferred)) { await say(n, DEFERRED_TEXT); await label(n, [LABELS.deferred], []) }
        removeAll(all, accepted)
        run.skipped.push({ issue: n, reason: 'deferred' })
        continue
      }
      const c = card.kind === 'found' ? card.card : null
      const aliases = c ? [c.id, c.doi ? `doi:${c.doi}` : null, c.pmid ? `pmid:${c.pmid}` : null].filter((k): k is string => !!k && k !== workId) : []
      snapshot = { work_id: workId, aliases: [...new Set(aliases)].sort(), card: c, snapshot_at: t0.toISOString(), snapshot_source: 'openalex' }
    }

    // ⑤ 写入 + 提交推送
    const p = paths(root)
    const touched: string[] = []
    if (accepted.length > 0 && !deps.dry) {
      const file = join(p.assertions, monthFile(t0).rel)
      appendJsonl(file, accepted)
      touched.push(file)
      if (snapshot) { touched.push(appendWork(snapshot, root)); works.set(snapshot.work_id, snapshot) }
      for (const r of results) if (rememberActor(actors, r.actor.id, r.actor.login, t0.toISOString(), root)) touched.push(p.actors)
      if (deps.git) {
        try {
          const r = await commitAndPush({ git: deps.git, paths: [...new Set(touched)], message: `ingest: issue #${n}`, ...(deps.sleep ? { sleep: deps.sleep } : {}) })
          if (r.pushed) run.changed = true
        } catch (e) {
          log(`push failed for #${n}: ${e instanceof Error ? e.message : String(e)}`)
          if (!has(issue, LABELS.retry)) { await say(n, RETRY_TEXT); await label(n, [LABELS.retry], []) }
          run.skipped.push({ issue: n, reason: 'retry' })
          break // 推不上去，后面的也推不上去
        }
      } else {
        run.changed = true
      }
    } else if (accepted.length > 0) {
      log(`[dry] would append ${accepted.length} assertions for #${n}`)
      run.changed = true
    }

    // ⑥ 回执 + 标签 + 关闭
    const decisions = resolveAnnotations(all.filter((a) => a.work_id === workId), policy, { blocklist })
    const merged: IntakeResult = {
      work_id: workId, held: false, duplicates,
      accepted, rejected: results.flatMap((r) => r.result.rejected), ignored: results.flatMap((r) => r.result.ignored),
    }
    let receipt = renderReceipt({ result: merged, decisions, actorLogin: [...new Set(results.map((r) => r.actor.login))].join(' @') || author.login })
    if (heldCommenters.length > 0) receipt += `\n\n账号太新、这次没计入的评论者 / Commenters held (account too new)：${heldCommenters.map((l) => `@${l}`).join(' ')}`
    await say(n, receipt)
    if (!commandsOnly) {
      const ok = accepted.length > 0 || duplicates > 0
      await label(n, [ok ? LABELS.ingested : LABELS.rejected], [LABELS.held, LABELS.deferred, LABELS.retry].filter((l) => has(issue, l)))
      if (!deps.dry) await gh.close(n, ok ? 'completed' : 'not_planned')
    }
    run.processed.push(n)
  }
  return run
}

const removeAll = (all: EvidenceAnnotation[], items: readonly EvidenceAnnotation[]) => { for (const a of items) { const i = all.indexOf(a); if (i >= 0) all.splice(i, 1) } }

export async function main(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const dry = argv.includes('--dry')
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN
  const repo = env.GH_REPO ?? env.GITHUB_REPOSITORY
  if (!token || !repo) { console.error('需要 GH_TOKEN 与 GH_REPO（owner/repo）'); return 2 }
  const run = await runIntake({
    github: createGitHub({ token, repo }),
    openalex: createOpenAlex({ apiKey: env.OPENALEX_API_KEY, log: (m, d) => console.error(m, d) }),
    git: dry ? null : realGit(REPO_ROOT),
    triggerIssue: env.TRIGGER_ISSUE ? Number(env.TRIGGER_ISSUE) : null,
    triggerComment: env.TRIGGER_COMMENT ? Number(env.TRIGGER_COMMENT) : null,
    dry,
  })
  console.log(`processed: ${run.processed.join(', ') || '—'}；skipped: ${run.skipped.map((s) => `#${s.issue}(${s.reason})`).join(', ') || '—'}；changed=${run.changed}`)
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `changed=${run.changed ? 'true' : 'false'}\n`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code }, (e) => { console.error(e); process.exitCode = 1 })
}
