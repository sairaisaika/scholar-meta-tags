/**
 * 入库的纯函数部分：解析 issue 正文与评论命令、鉴权到层级、校验并生成断言、渲染回执。零 IO，重点测试。
 * ─────────────────────────────────────────────────────────────────────────────
 * 规则与形状只调引擎：作品键 `parseWorkRef` / `workKeyOf`，标签 `normalizeTag`，行验形 `intakeOutcomeRows`
 * （问题用 `presentIntakeIssues` 回人话），裁决 `resolveAnnotations`，回执 `presentCommunityDecision`。
 * 这里只加平台自己的事：谁能提什么（层级门槛）、防滥用（账号龄、日上限、单 issue / 单篇上限、自己认可自己）、
 * 贡献者的行语境剥掉 `reviewed` / `independence_verified` / `dependence_id`（记 `field_ignored`）、不存 quote。
 */
import {
  EVIDENCE_ANNOTATION_KINDS, EVIDENCE_DIRECTIONS, EVIDENCE_INTAKE_ISSUES, EVIDENCE_MESSAGES, EVIDENCE_ROB_JUDGEMENTS, EVIDENCE_ROB_TOOLS, EVIDENCE_TRUST_TIERS,
  intakeOutcomeRows, normalizeTag, parseWorkRef, presentCommunityDecision, presentIntakeIssues, workKeyOf,
} from 'scholar-meta'
import type {
  EvidenceAnnotation, EvidenceAnnotationKind, EvidenceAnnotationOp, EvidenceAnnotationPayload, EvidenceCommunityDecision, EvidenceDirection,
  EvidenceIntakeIssueCode, EvidenceRowContextInput, EvidenceRowEffectInput, EvidenceTrustTier,
} from 'scholar-meta'
import { annotationId } from './store.js'
import type { SmtConfig, FacetVocab } from './store.js'
import type { Permission } from './github.js'

// ── 解析 ────────────────────────────────────────────────────────────────────────

export const FORM_ID = 'annotate/1'
export const COMMAND_FORM_ID = 'command/1'

export interface SubmissionItem { kind: string; op: string; subject?: string | null; payload: unknown; note?: string | null }
export interface Submission { form: string; work_id: string; items: SubmissionItem[] }

/** 正文的 `### 机器读的部分…` 标题下的 ```json 块（表单渲染格式）；找不到标题时退回任何含 `"form"` 的 json 块。 */
export function parseIssueBody(body: string | null | undefined): { ok: true; raw: unknown } | { ok: false; code: 'no_payload' | 'bad_json' } {
  if (typeof body !== 'string' || !body.trim()) return { ok: false, code: 'no_payload' }
  const text = body.replace(/\r\n/g, '\n')
  const heading = text.indexOf('### 机器读的部分')
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/g
  let candidate: string | null = null
  if (heading >= 0) {
    fence.lastIndex = heading
    const m = fence.exec(text)
    if (m) candidate = m[1]!
  }
  if (candidate === null) {
    fence.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = fence.exec(text))) { if (m[1]!.includes('"form"')) { candidate = m[1]!; break } }
  }
  if (candidate === null) return { ok: false, code: 'no_payload' }
  try { return { ok: true, raw: JSON.parse(candidate.trim()) } } catch { return { ok: false, code: 'bad_json' } }
}

export type Command =
  | { cmd: 'agree' | 'unsure'; subject: string }
  | { cmd: 'disagree'; subject: string; reason: string }
  | { cmd: 'accept'; items: 'all' | number[] }
  | { cmd: 'reject'; items: number[]; reason: string }
  | { cmd: 'bind'; tag_key: string; topic: { id: string; display_name: string } | null }
  | { cmd: 'approve' }

const TOPIC_ID = /^[a-z][a-z0-9_-]*:[A-Za-z0-9_.-]+$/

/** 评论命令：只认第一行以 `/` 开头的；其余评论忽略（不回复）。 */
export function parseCommand(body: string | null | undefined): Command | null {
  if (typeof body !== 'string') return null
  const line = body.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  if (!line || !line.startsWith('/')) return null
  const [head, ...rest] = line.split(/\s+/)
  const cmd = head!.slice(1).toLowerCase()
  const arg = rest[0] ?? ''
  const tail = rest.slice(1).join(' ').trim()
  switch (cmd) {
    case 'agree': case 'unsure': return arg ? { cmd, subject: arg } : null
    case 'disagree': return arg ? { cmd, subject: arg, reason: tail } : null
    case 'accept': {
      if (arg.toLowerCase() === 'all') return { cmd, items: 'all' }
      const items = parseItemNumbers(arg)
      return items.length > 0 ? { cmd, items } : null
    }
    case 'reject': {
      const items = parseItemNumbers(arg)
      return items.length > 0 ? { cmd, items, reason: tail } : null
    }
    case 'bind': {
      const key = normalizeTag(arg)
      if (!key) return null
      const target = rest[1] ?? ''
      if (/^(none|rejected|null|-)$/i.test(target)) return { cmd, tag_key: key, topic: null }
      if (!TOPIC_ID.test(target)) return null
      const name = rest.slice(2).join(' ').trim()
      return { cmd, tag_key: key, topic: { id: target, display_name: name || target } }
    }
    case 'approve': return { cmd }
    default: return null
  }
}

const parseItemNumbers = (s: string): number[] =>
  [...new Set(s.split(',').map((x) => Number(x.replace(/^#/, ''))).filter((n) => Number.isInteger(n) && n >= 1))]

/** 命令 → 与表单同形的条目（`item#` 从 1 数，指 issue 表单里的第几条）。 */
export function commandToItems(cmd: Command, issue: Submission | null): { ok: true; items: SubmissionItem[] } | { ok: false; code: RejectCode } {
  switch (cmd.cmd) {
    case 'agree': return { ok: true, items: [{ kind: 'review', op: 'endorse', subject: cmd.subject, payload: { kind: 'review', reason: null } }] }
    case 'unsure': return { ok: true, items: [{ kind: 'review', op: 'unsure', subject: cmd.subject, payload: { kind: 'review', reason: null } }] }
    case 'disagree': return { ok: true, items: [{ kind: 'review', op: 'dispute', subject: cmd.subject, payload: { kind: 'review', reason: cmd.reason } }] }
    case 'accept': case 'reject': {
      if (!issue) return { ok: false, code: 'subject_unknown' }
      const proposals = issue.items.map((it, i) => ({ it, n: i + 1 })).filter(({ it }) => it.kind !== 'review' && it.kind !== 'independence')
      const picked = cmd.items === 'all' ? proposals : proposals.filter(({ n }) => (cmd.items as number[]).includes(n))
      if (picked.length === 0) return { ok: false, code: 'subject_unknown' }
      return {
        ok: true,
        items: picked.map(({ it }) => ({
          kind: 'review', op: cmd.cmd === 'accept' ? 'endorse' : 'dispute', subject: it.subject ?? null,
          payload: { kind: 'review', reason: cmd.cmd === 'reject' ? cmd.reason : null },
        })),
      }
    }
    case 'bind': return { ok: true, items: [{ kind: 'binding', op: 'add', subject: `binding:${cmd.tag_key}`, payload: { kind: 'binding', topic: cmd.topic } }] }
    case 'approve': return { ok: true, items: [] }
  }
}

// ── 鉴权 ────────────────────────────────────────────────────────────────────────

const tierRank = (t: EvidenceTrustTier) => EVIDENCE_TRUST_TIERS.indexOf(t)

/** 仓库权限 → 层级；`roles.json` 只能升不能降 */
export function tierFor(permission: Permission, roles: Record<string, 'editor' | 'maintainer'>, actorId: string): EvidenceTrustTier {
  const base: EvidenceTrustTier = permission === 'admin' || permission === 'maintain' ? 'maintainer' : permission === 'write' ? 'editor' : 'contributor'
  const extra = roles[actorId]
  return extra && tierRank(extra) < tierRank(base) ? extra : base
}

export interface Actor {
  /** `gh:<数字 id>` */
  id: string
  login: string
  tier: EvidenceTrustTier
  type: string
  created_at: string | null
}

export const accountAgeDays = (createdAt: string | null, now: Date): number | null => {
  if (!createdAt) return null
  const t = Date.parse(createdAt)
  return Number.isFinite(t) ? (now.getTime() - t) / 86_400_000 : null
}

// ── 校验 ────────────────────────────────────────────────────────────────────────

export type RejectCode =
  | 'bad_form' | 'bad_item' | 'work_unresolved' | 'bots_not_allowed' | 'insufficient_tier' | 'tag_invalid' | 'facet_unknown' | 'facet_value_unknown'
  | 'row_invalid' | 'subject_mismatch' | 'subject_unknown' | 'self_endorse' | 'dispute_reason_too_short' | 'row_endorse_needs_re_extraction'
  | 'daily_limit' | 'issue_limit' | 'rows_per_work_limit' | 'op_invalid' | 'binding_invalid' | 'appraisal_invalid' | 'independence_invalid' | 'review_invalid'

export const REJECT_TEXT: Record<RejectCode, { zh: string; en: string }> = {
  bad_form: { zh: '机器读的部分不是 annotate/1 表单的形状', en: 'The machine-readable part is not an annotate/1 payload' },
  bad_item: { zh: '这一条不是 {kind, op, subject, payload} 的形状', en: 'This item is not shaped like {kind, op, subject, payload}' },
  work_unresolved: { zh: '作品键认不出：只收 doi:…、openalex:W…、pmid:…（链接与标题请先在页面上查成一篇确定的论文）', en: 'Work not resolved: only doi:…, openalex:W… or pmid:… are accepted (resolve links and titles on the page first)' },
  bots_not_allowed: { zh: '机器人账号的提交不收', en: 'Submissions from bot accounts are not accepted' },
  insufficient_tier: { zh: '这类断言（绑定 / 独立性 / 偏倚评估）只收编辑及以上', en: 'This kind (binding / independence / appraisal) is accepted from editors and above only' },
  tag_invalid: { zh: '标签为空或太长', en: 'Tag is empty or too long' },
  facet_unknown: { zh: '没有这个分面', en: 'Unknown facet' },
  facet_value_unknown: { zh: '分面取值不在词表里', en: 'Facet value is not in the vocabulary' },
  row_invalid: { zh: '结果行没过验形', en: 'Result row failed validation' },
  subject_mismatch: { zh: 'subject 与 payload 对不上', en: 'subject does not match payload' },
  subject_unknown: { zh: '要评议的对象在这篇作品上还不存在', en: 'The subject under review does not exist on this work yet' },
  self_endorse: { zh: '不能认可自己提出的条目', en: 'You cannot endorse your own proposal' },
  dispute_reason_too_short: { zh: '不认可要写 ≥ 10 字的理由', en: 'A dispute needs a reason of at least 10 characters' },
  row_endorse_needs_re_extraction: { zh: '认可数字要带整行盲复录：请到页面点「复录」', en: 'Endorsing numbers requires a blind re-extraction of the whole row: use "re-extract" on the page' },
  daily_limit: { zh: '今天的提交已到上限，明天再来', en: 'Daily submission limit reached; try again tomorrow' },
  issue_limit: { zh: '单条 issue 的断言数超过上限', en: 'Too many assertions in one issue' },
  rows_per_work_limit: { zh: '这篇作品的结果行已到上限', en: 'This work already has the maximum number of result rows' },
  op_invalid: { zh: 'op 与 kind 不配', en: 'op does not fit kind' },
  binding_invalid: { zh: '绑定的主题 id 形状不对（如 openalex:T10537）', en: 'Binding topic id is malformed (e.g. openalex:T10537)' },
  appraisal_invalid: { zh: '偏倚评估要有 tool / overall / source', en: 'Appraisal needs tool / overall / source' },
  independence_invalid: { zh: '独立性断言要有 study_id / dependence_id / independence_verified', en: 'Independence needs study_id / dependence_id / independence_verified' },
  review_invalid: { zh: '评议的 payload 形状不对', en: 'Review payload is malformed' },
}

/** 引擎没有词条的行验形问题 */
const ROW_ISSUE_TEXT: Record<string, { zh: string; en: string }> = {
  missing_or_invalid_context: { zh: '语境不全：outcome / comparison / population / timepoint / unit / analysis / kind / locator 都要填，kind 要在词表里', en: 'Context incomplete: outcome / comparison / population / timepoint / unit / analysis / kind / locator are all required' },
  invalid_or_duplicate_outcome_id: { zh: 'row_id 只能用字母、数字、_、-（≤ 64），且同一次提交里不能重复', en: 'row_id must be [A-Za-z0-9_-]{1,64} and unique in one submission' },
  too_many_outcomes: { zh: '结果行太多', en: 'Too many result rows' },
}

export interface IntakeContext {
  config: SmtConfig
  facets: FacetVocab
  /** 当月与上月的断言：幂等、日上限、subject 是否存在、自己认可自己 */
  existing: readonly EvidenceAnnotation[]
  now: Date
  source: { issue: number; comment?: number | null; form: string }
  /** 评论命令时：这条 issue 表单声明的作品键（命令只能评这篇） */
  work_id?: string | null
}

export interface IntakeRejection { index: number; subject: string | null; code: RejectCode; text: string }
export interface IntakeResult {
  work_id: string | null
  accepted: EvidenceAnnotation[]
  rejected: IntakeRejection[]
  /** 剥掉的字段（`field_ignored`） */
  ignored: Array<{ index: number; subject: string; field: string }>
  /** 已经入过库的条目（同 id），幂等跳过 */
  duplicates: number
  /** 账号太新：整条 issue 搁置等维护者 `/approve` */
  held: boolean
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

/** 表单声明的作品键（不校验其余部分）；认不出 ⇒ null */
export function submissionWorkKey(raw: unknown): string | null {
  return isRecord(raw) && raw.form === FORM_ID ? workKeyOf(parseWorkRef(raw.work_id)) : null
}
const OPS: Record<EvidenceAnnotationKind, readonly EvidenceAnnotationOp[]> = {
  tag: ['add', 'remove'], facet: ['add', 'remove'], row: ['add', 'remove'], review: ['endorse', 'dispute', 'unsure'],
  binding: ['add', 'remove'], independence: ['set'], appraisal: ['add', 'remove'],
}
const ROW_CONTEXT_KEYS = ['row_id', 'outcome', 'comparison', 'population', 'timepoint', 'unit', 'analysis', 'kind', 'locator', 'study_id', 'timepoint_raw'] as const
const ROW_ID = /^[A-Za-z0-9_-]{1,64}$/
const MIN_DISPUTE_REASON = 10

const rejectText = (code: RejectCode, detail?: string) => `${REJECT_TEXT[code].zh} / ${REJECT_TEXT[code].en}${detail ? `：${detail}` : ''}`

/** 一次提交（表单正文或一条命令）→ 断言与拒绝清单。 */
export function validateSubmission(raw: unknown, actor: Actor, ctx: IntakeContext): IntakeResult {
  const out: IntakeResult = { work_id: null, accepted: [], rejected: [], ignored: [], duplicates: 0, held: false }
  const reject = (index: number, subject: string | null, code: RejectCode, detail?: string) => out.rejected.push({ index, subject, code, text: rejectText(code, detail) })
  if (actor.type.toLowerCase() === 'bot') { reject(-1, null, 'bots_not_allowed'); return out }
  if (!isRecord(raw) || raw.form !== FORM_ID || !Array.isArray(raw.items)) { reject(-1, null, 'bad_form'); return out }
  const ref = parseWorkRef(raw.work_id)
  const workId = workKeyOf(ref)
  if (!workId) { reject(-1, null, 'work_unresolved'); return out }
  if (ctx.work_id && ctx.work_id !== workId) { reject(-1, null, 'work_unresolved', '命令只能评这条 issue 声明的那篇'); return out }
  out.work_id = workId
  const items = raw.items as unknown[]
  const contributor = actor.tier === 'contributor'
  const at = ctx.now.toISOString()
  const by: EvidenceAnnotation['by'] = { kind: 'person', id: actor.id, tier: actor.tier }
  const existingIds = new Set(ctx.existing.map((a) => a.id))
  const forWork = ctx.existing.filter((a) => a.work_id === workId)

  // 防滥用：账号龄（只搁置，不拒）；日上限
  if (contributor) {
    const age = accountAgeDays(actor.created_at, ctx.now)
    if (age !== null && age < ctx.config.abuse.min_account_age_days) out.held = true
    const today = at.slice(0, 10)
    const mine = ctx.existing.filter((a) => a.by.id === actor.id && a.at.slice(0, 10) === today)
    const issues = new Set(mine.map((a) => a.source.issue).filter((n): n is number => typeof n === 'number'))
    if (!issues.has(ctx.source.issue) && issues.size >= ctx.config.abuse.daily_issue_limit) { reject(-1, null, 'daily_limit'); return out }
    if (mine.length >= ctx.config.abuse.daily_assertion_limit) { reject(-1, null, 'daily_limit'); return out }
  }

  const fromIssue = ctx.existing.filter((a) => a.source.issue === ctx.source.issue).length
  const rowsOnWork = new Set(forWork.filter((a) => a.kind === 'row' && a.op === 'add').map((a) => a.subject))
  const proposed = new Map<string, EvidenceAnnotation>() // subject → 最新 add（已有 + 本次）
  for (const a of forWork) if (a.op === 'add' && a.kind !== 'review') { const p = proposed.get(a.subject); if (!p || a.at > p.at) proposed.set(a.subject, a) }
  let seen = 0

  items.forEach((rawItem, index) => {
    if (!isRecord(rawItem) || !text(rawItem.kind) || !text(rawItem.op) || !isRecord(rawItem.payload)) { reject(index, null, 'bad_item'); return }
    const kind = rawItem.kind as EvidenceAnnotationKind
    const op = rawItem.op as EvidenceAnnotationOp
    const subjectIn = typeof rawItem.subject === 'string' ? rawItem.subject.trim() : null
    if (!(EVIDENCE_ANNOTATION_KINDS as readonly string[]).includes(kind)) { reject(index, subjectIn, 'bad_item'); return }
    if (!OPS[kind].includes(op)) { reject(index, subjectIn, 'op_invalid'); return }
    const minTier = ctx.config.min_tier[kind as 'binding' | 'independence' | 'appraisal']
    if (minTier && tierRank(actor.tier) > tierRank(minTier)) { reject(index, subjectIn, 'insufficient_tier'); return }
    if (seen + fromIssue >= ctx.config.abuse.max_assertions_per_issue) { reject(index, subjectIn, 'issue_limit'); return }

    const built = buildItem(kind, op, subjectIn, rawItem.payload, { actor, ctx, workId, index, proposed, rowsOnWork, ignored: out.ignored })
    if (!built.ok) { reject(index, subjectIn, built.code, built.detail); return }
    const { subject, payload } = built
    const note = typeof rawItem.note === 'string' && rawItem.note.trim() ? rawItem.note.trim().slice(0, 500) : null
    const base = { work_id: workId, kind, op, subject, by, payload, source: { issue: ctx.source.issue, comment: ctx.source.comment ?? null, form: ctx.source.form } }
    const id = annotationId(base)
    seen++
    if (existingIds.has(id) || out.accepted.some((a) => a.id === id)) { out.duplicates++; return }
    const annotation: EvidenceAnnotation = { id, at, ...base, note, supersedes: supersededBy(forWork, actor.id, subject, kind) }
    out.accepted.push(annotation)
    if (op === 'add' && kind !== 'review') proposed.set(subject, annotation)
    if (kind === 'row' && op === 'add') rowsOnWork.add(subject)
  })
  if (contributor) {
    // 日上限：加上这次不能超过
    const today = at.slice(0, 10)
    const mine = ctx.existing.filter((a) => a.by.id === actor.id && a.at.slice(0, 10) === today).length
    const room = ctx.config.abuse.daily_assertion_limit - mine
    if (out.accepted.length > room) {
      const over = out.accepted.splice(Math.max(room, 0))
      for (const a of over) reject(-1, a.subject, 'daily_limit')
    }
  }
  return out
}

/** 同一人在同一 subject 上的上一条（审计链） */
function supersededBy(forWork: readonly EvidenceAnnotation[], actorId: string, subject: string, kind: EvidenceAnnotationKind): string | null {
  const mine = forWork.filter((a) => a.by.id === actorId && a.subject === subject && (kind === 'review' ? a.kind === 'review' : a.kind === kind)).sort((x, y) => (x.at < y.at ? 1 : -1))
  return mine[0]?.id ?? null
}

interface BuildCtx {
  actor: Actor; ctx: IntakeContext; workId: string; index: number
  proposed: Map<string, EvidenceAnnotation>; rowsOnWork: Set<string>
  ignored: IntakeResult['ignored']
}
type Built = { ok: true; subject: string; payload: EvidenceAnnotationPayload } | { ok: false; code: RejectCode; detail?: string }

function buildItem(kind: EvidenceAnnotationKind, op: EvidenceAnnotationOp, subjectIn: string | null, p: Record<string, unknown>, b: BuildCtx): Built {
  const { ctx, actor, workId } = b
  const contributor = actor.tier === 'contributor'
  switch (kind) {
    case 'tag': {
      const key = normalizeTag(p.tag)
      if (!key || typeof p.tag !== 'string') return { ok: false, code: 'tag_invalid' }
      const subject = `tag:${key}`
      if (subjectIn && normalizeSubject(subjectIn) !== subject) return { ok: false, code: 'subject_mismatch' }
      return { ok: true, subject, payload: { kind: 'tag', tag: p.tag.trim() } }
    }
    case 'facet': {
      if (!text(p.facet)) return { ok: false, code: 'facet_unknown' }
      const spec = ctx.facets.facets[p.facet]
      if (!spec) return { ok: false, code: 'facet_unknown', detail: p.facet }
      if (!text(p.value) || !spec.values.includes(p.value)) return { ok: false, code: 'facet_value_unknown', detail: `${p.facet} ∌ ${String(p.value)}` }
      const subject = `facet:${p.facet}`
      if (subjectIn && subjectIn !== subject) return { ok: false, code: 'subject_mismatch' }
      stripQuote(p, b, subject)
      const locator = text(p.locator) ? p.locator.trim().slice(0, 200) : null
      return { ok: true, subject, payload: { kind: 'facet', facet: p.facet, value: p.value, locator } }
    }
    case 'row': {
      if (!isRecord(p.context) || !text(p.context.row_id) || !ROW_ID.test(p.context.row_id)) return { ok: false, code: 'row_invalid', detail: ROW_ISSUE_TEXT.invalid_or_duplicate_outcome_id!.zh }
      const subject = `row:${p.context.row_id}`
      if (subjectIn && subjectIn !== subject) return { ok: false, code: 'subject_mismatch' }
      if (op === 'add' && !b.rowsOnWork.has(subject) && b.rowsOnWork.size >= ctx.config.abuse.max_rows_per_work) return { ok: false, code: 'rows_per_work_limit' }
      // 剥掉不属于输入的字段：审核事实由编辑层的 independence 断言给；quote 只留 issue
      const context: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(p.context)) {
        if ((ROW_CONTEXT_KEYS as readonly string[]).includes(k)) { if (v !== undefined && v !== null && v !== '') context[k] = v; continue }
        b.ignored.push({ index: b.index, subject, field: `context.${k}` })
      }
      stripQuote(p, b, subject)
      const direction = p.direction === null || p.direction === undefined ? null : (EVIDENCE_DIRECTIONS as readonly string[]).includes(p.direction as string) ? (p.direction as EvidenceDirection) : undefined
      if (direction === undefined) return { ok: false, code: 'row_invalid', detail: 'direction' }
      const checked = checkRow(workId, p.context.row_id, p.effect ?? null, direction, context)
      if (!checked.ok) return { ok: false, code: 'row_invalid', detail: checked.detail }
      const payload: Extract<EvidenceAnnotationPayload, { kind: 'row' }> = {
        kind: 'row', context: checked.context, effect: checked.effect, direction,
        ...(text(p.higher_is_better_reason) ? { higher_is_better_reason: p.higher_is_better_reason.trim().slice(0, 300) } : {}),
      }
      return { ok: true, subject, payload }
    }
    case 'review': {
      if (!subjectIn) return { ok: false, code: 'subject_unknown' }
      const subject = normalizeSubject(subjectIn)
      const target = b.proposed.get(subject)
      if (!target) return { ok: false, code: 'subject_unknown', detail: subject }
      if (op === 'endorse' && target.by.id === actor.id) return { ok: false, code: 'self_endorse' }
      const reason = text(p.reason) ? p.reason.trim().slice(0, 1000) : null
      if (op === 'dispute' && (!reason || reason.length < MIN_DISPUTE_REASON)) return { ok: false, code: 'dispute_reason_too_short' }
      let re: NonNullable<Extract<EvidenceAnnotationPayload, { kind: 'review' }>['re_extraction']> | null = null
      if (p.re_extraction !== undefined && p.re_extraction !== null) {
        if (!isRecord(p.re_extraction)) return { ok: false, code: 'review_invalid' }
        const d = p.re_extraction.direction
        const direction = d === null || d === undefined ? null : (EVIDENCE_DIRECTIONS as readonly string[]).includes(d as string) ? (d as EvidenceDirection) : undefined
        if (direction === undefined) return { ok: false, code: 'review_invalid', detail: 'direction' }
        const checked = checkRow(workId, 'x', p.re_extraction.effect ?? null, direction, PROBE_CONTEXT)
        if (!checked.ok) return { ok: false, code: 'review_invalid', detail: checked.detail }
        re = { effect: checked.effect, direction }
      }
      if (op === 'endorse' && subject.startsWith('row:') && !re && contributor) return { ok: false, code: 'row_endorse_needs_re_extraction' }
      const payload: Extract<EvidenceAnnotationPayload, { kind: 'review' }> = { kind: 'review', reason, ...(re ? { re_extraction: re, peeked: p.peeked === true } : {}) }
      return { ok: true, subject, payload }
    }
    case 'binding': {
      if (!subjectIn) return { ok: false, code: 'subject_mismatch' }
      const key = normalizeTag(subjectIn.replace(/^binding:/, ''))
      if (!key) return { ok: false, code: 'tag_invalid' }
      const topic = p.topic
      if (topic !== null && (!isRecord(topic) || !text(topic.id) || !TOPIC_ID.test(topic.id) || !text(topic.display_name))) return { ok: false, code: 'binding_invalid' }
      return { ok: true, subject: `binding:${key}`, payload: { kind: 'binding', topic: topic === null ? null : { id: (topic as { id: string }).id, display_name: (topic as { display_name: string }).display_name.trim().slice(0, 200) } } }
    }
    case 'independence': {
      if (!subjectIn || !subjectIn.startsWith('row:')) return { ok: false, code: 'subject_unknown' }
      if (!b.proposed.has(subjectIn)) return { ok: false, code: 'subject_unknown', detail: subjectIn }
      if (!text(p.study_id) || !text(p.dependence_id) || typeof p.independence_verified !== 'boolean') return { ok: false, code: 'independence_invalid' }
      return { ok: true, subject: subjectIn, payload: { kind: 'independence', study_id: p.study_id.trim(), dependence_id: p.dependence_id.trim(), independence_verified: p.independence_verified, note: text(p.note) ? p.note.trim().slice(0, 500) : null } }
    }
    case 'appraisal': {
      if (!text(p.tool) || !(EVIDENCE_ROB_TOOLS as readonly string[]).includes(p.tool) || !text(p.overall) || !(EVIDENCE_ROB_JUDGEMENTS as readonly string[]).includes(p.overall) || !text(p.source)) return { ok: false, code: 'appraisal_invalid' }
      const subject = `appraisal:${p.tool}`
      if (subjectIn && subjectIn !== subject) return { ok: false, code: 'subject_mismatch' }
      return { ok: true, subject, payload: { kind: 'appraisal', tool: p.tool as never, overall: p.overall as never, source: p.source.trim().slice(0, 300) } }
    }
  }
}

/** `tag:` 的 subject 归一后比较（用户可能写 `tag:ADHD`） */
export function normalizeSubject(s: string): string {
  const t = s.trim()
  if (t.startsWith('tag:')) { const k = normalizeTag(t.slice(4)); return k ? `tag:${k}` : t }
  if (t.startsWith('binding:')) { const k = normalizeTag(t.slice(8)); return k ? `binding:${k}` : t }
  return t
}

function stripQuote(p: Record<string, unknown>, b: BuildCtx, subject: string): void {
  if ('quote' in p) { b.ignored.push({ index: b.index, subject, field: 'quote' }); delete p.quote }
  if (isRecord(p.context) && 'quote' in p.context) { b.ignored.push({ index: b.index, subject, field: 'context.quote' }); delete p.context.quote }
}

const PROBE_CONTEXT = { row_id: 'x', outcome: 'x', comparison: 'x', population: 'x', timepoint: 'x', unit: 'x', analysis: 'x', kind: 'continuous', locator: 'x' }

/**
 * 行走引擎验形：`intakeOutcomeRows({ id: work_id, title: 'x' }, [{ id, effect, direction, context }])`；
 * 任何问题都拒（抄的数字有一处对不上就不该入库）。数字按引擎归一后的值存（字符串数字转成数字）。
 */
function checkRow(workId: string, rowId: string, effect: unknown, direction: EvidenceDirection | null, context: Record<string, unknown>):
  { ok: true; context: EvidenceRowContextInput; effect: EvidenceRowEffectInput | null } | { ok: false; detail: string } {
  const full = { ...context, study_id: text(context.study_id) ? context.study_id : workId, dependence_id: workId, reviewed: false, independence_verified: false }
  const r = intakeOutcomeRows({ id: workId, title: 'x' }, [{ id: rowId, effect, direction, context: full }], { retrieved_at: '2000-01-01T00:00:00Z' })
  const codes = r.issues.flatMap((i) => i.codes)
  if (codes.length > 0) {
    const known = codes.filter((c): c is EvidenceIntakeIssueCode => (EVIDENCE_INTAKE_ISSUES as readonly string[]).includes(c))
    const texts = [
      ...presentIntakeIssues(known.map((code) => ({ code, field: '', action: 'flagged' as const })), { locale: 'zh' }).map((i) => i.text),
      ...codes.filter((c) => !known.includes(c as EvidenceIntakeIssueCode)).map((c) => ROW_ISSUE_TEXT[c]?.zh ?? c),
    ]
    return { ok: false, detail: texts.join('；') }
  }
  const rec = r.records[0]
  if (!rec) return { ok: false, detail: ROW_ISSUE_TEXT.missing_or_invalid_context!.zh }
  const e = rec.effect
  const normalized: EvidenceRowEffectInput | null = e ? { metric: e.metric, value: e.value, ci_low: e.ci_low, ci_high: e.ci_high, n: e.n, p_value: e.p_value ?? null, higher_is_better: e.higher_is_better } : null
  if (effect && !normalized) return { ok: false, detail: 'effect' }
  const c = context
  const ctxOut: EvidenceRowContextInput = {
    row_id: rowId, outcome: String(c.outcome).trim(), comparison: String(c.comparison).trim(), population: String(c.population).trim(), timepoint: String(c.timepoint).trim(),
    unit: String(c.unit).trim(), analysis: String(c.analysis).trim(), kind: c.kind as EvidenceRowContextInput['kind'], locator: String(c.locator).trim(),
    ...(text(c.study_id) ? { study_id: c.study_id.trim() } : {}),
    ...(text(c.timepoint_raw) ? { timepoint_raw: c.timepoint_raw.trim() } : {}),
  }
  return { ok: true, context: ctxOut, effect: normalized }
}

// ── 回执 ────────────────────────────────────────────────────────────────────────

export interface ReceiptInput {
  result: IntakeResult
  /** 这篇作品入库后的全部裁决（`resolveAnnotations`） */
  decisions: readonly EvidenceCommunityDecision[]
  actorLogin: string
}

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')

/** 回评（中英）：表（subject · 值 · 状态 · 区间 · 核验 · 原因）+ 拒收清单 + 剥掉的字段 + 待定提示。 */
export function renderReceipt({ result, decisions, actorLogin }: ReceiptInput): string {
  const zh = EVIDENCE_MESSAGES.zh.text
  const en = EVIDENCE_MESSAGES.en.text
  const lines: string[] = []
  lines.push(`@${actorLogin} 入库完成 / Ingested：收 **${result.accepted.length}** 条，拒 **${result.rejected.length}** 条${result.duplicates > 0 ? `，${result.duplicates} 条此前已入库（幂等跳过）` : ''}。`)
  lines.push('')
  if (decisions.length > 0) {
    lines.push('| subject | 值 / value | 状态 / state | 区间 / interval | 核验 / verification | 原因 / issues |')
    lines.push('|---|---|---|---|---|---|')
    for (const d of decisions) {
      const v = presentCommunityDecision(d, { locale: 'zh' })
      const e = presentCommunityDecision(d, { locale: 'en' })
      const issues = [...v.issues_text, ...(v.reasons_text ? [v.reasons_text] : [])].join('；')
      lines.push(`| \`${esc(d.subject)}\` | ${esc(d.value ?? '—')} | ${esc(v.state_text)} / ${esc(e.state_text)} | ${esc(v.quorum_text ?? '—')} | ${esc(v.verification_text ?? '—')} | ${esc(issues || '—')} |`)
    }
    lines.push('')
  }
  if (result.rejected.length > 0) {
    lines.push('**拒收 / Rejected**')
    for (const r of result.rejected) lines.push(`- ${r.index >= 0 ? `#${r.index + 1} ` : ''}${r.subject ? `\`${r.subject}\` ` : ''}${r.text}`)
    lines.push('')
  }
  if (result.ignored.length > 0) {
    lines.push('**剥掉的字段 / Fields ignored**（`field_ignored`：审核事实由编辑层另行判定；引文不入库 / review facts are set by editors; quotes are not stored）')
    for (const i of result.ignored) lines.push(`- #${i.index + 1} \`${i.subject}\` · \`${i.field}\``)
    lines.push('')
  }
  if (result.accepted.length > 0) {
    lines.push(`> ${zh.community_pending_hint}`)
    lines.push(`> ${en.community_pending_hint}`)
    lines.push('>')
    lines.push('> 导出将在下一次构建更新 / The export updates on the next build.')
  }
  return lines.join('\n')
}

export const HOLD_TEXT = (days: number) =>
  `账号注册不满 ${days} 天：这条先搁置，等维护者评论 \`/approve\` 放行。/ Account younger than ${days} days: held until a maintainer comments \`/approve\`.`
export const DEFERRED_TEXT = '向 OpenAlex 取名片时没问成（不是「没有这篇」）：保持打开，下次运行重试。/ Could not reach OpenAlex for the work card (this is not "no such work"); left open for retry.'
export const NO_PAYLOAD_TEXT = '正文里没找到机器读的部分（请用标注页面生成的表单提交）。/ No machine-readable payload found; please submit through the annotation page.'
export const RETRY_TEXT = '写入仓库失败，稍后自动重试。/ Repository write failed; will retry automatically.'
