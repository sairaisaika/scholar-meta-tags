/**
 * 表单草稿 → 断言条目（`{kind, op, subject, payload, note?}`，形状同引擎 `EvidenceAnnotation` 的对应字段）→ issue 预填链接。
 * 验形只调引擎（`intakeOutcomeRows`）；这里只做「必填没填」这类表单层的提示。
 */
import {
  EVIDENCE_EFFECT_METRICS, directionFromEffect, intakeOutcomeRows, normalizeTag, resolveConcepts,
  type EvidenceAnnotationKind, type EvidenceAnnotationOp, type EvidenceAnnotationPayload, type EvidenceCommunityWork, type EvidenceConcept,
  type EvidenceDirection, type EvidenceEffectMetric, type EvidenceFacetId, type EvidenceRecord, type EvidenceRowEffectInput, type EvidenceWorkCard,
  type SynthesisContext,
} from 'scholar-meta'
import { config } from './data.js'

export type RowKind = 'continuous' | 'binary' | 'ordinal' | 'rate' | 'survival' | 'correlation' | 'qualitative' | 'composite' | 'metadata'
export const ROW_KINDS: readonly RowKind[] = ['continuous', 'binary', 'ordinal', 'rate', 'survival', 'correlation', 'qualitative', 'composite', 'metadata']

export interface Vote { op: 'endorse' | 'dispute' | 'unsure'; reason: string }

export interface ReExtractDraft {
  metric: EvidenceEffectMetric | ''
  value: string; ci_low: string; ci_high: string; n: string; p_value: string
  higher_is_better: 'true' | 'false' | ''
  direction: EvidenceDirection | ''
  peeked: boolean
  showing: boolean
  /** 比对结果（点过「比对」才有） */
  result: { match: boolean; diffs: string[] } | null
}

export interface Draft {
  newTags: string[]
  /** subject（`tag:…` / `facet:…` / `row:…`）→ 立场 */
  votes: Record<string, Vote>
  design: string | null
  designLocator: string
  facets: Record<string, string | null>
  outcome: string
  direction: EvidenceDirection | ''
  locator: string
  quote: string
  numbers: boolean
  effect: { metric: EvidenceEffectMetric | ''; value: string; ci_low: string; ci_high: string; n: string; p_value: string; higher_is_better: 'true' | 'false' | ''; hibReason: string }
  context: { comparison: string; population: string; timepoint: string; unit: string; analysis: string; kind: RowKind | '' }
  reExtract: Record<string, ReExtractDraft>
}

export function emptyDraft(): Draft {
  return {
    newTags: [], votes: {}, design: null, designLocator: '', facets: {},
    outcome: '', direction: '', locator: '', quote: '', numbers: false,
    effect: { metric: '', value: '', ci_low: '', ci_high: '', n: '', p_value: '', higher_is_better: '', hibReason: '' },
    context: { comparison: '', population: '', timepoint: '', unit: 'participant', analysis: 'as_reported', kind: '' },
    reExtract: {},
  }
}

export function emptyReExtract(): ReExtractDraft {
  return { metric: '', value: '', ci_low: '', ci_high: '', n: '', p_value: '', higher_is_better: '', direction: '', peeked: false, showing: false, result: null }
}

export interface Item {
  kind: EvidenceAnnotationKind
  op: EvidenceAnnotationOp
  subject: string
  payload: EvidenceAnnotationPayload
  note?: string
}

export interface Payload { form: 'annotate/1'; work_id: string; items: Item[] }

const num = (s: string): number | null => {
  const t = s.trim().replace(/[−–]/g, '-')
  if (!t) return null
  const v = Number(t)
  return Number.isFinite(v) ? v : NaN
}
const isMetric = (m: string): m is EvidenceEffectMetric => (EVIDENCE_EFFECT_METRICS as readonly string[]).includes(m)

/** 度量 → 数据类型缺省（与 `buildSynthesisTable` 的 kind ↔ metric 表一致） */
export function kindForMetric(m: EvidenceEffectMetric | ''): RowKind | '' {
  switch (m) {
    case 'md': case 'smd': case 'hedges_g': case 'cohens_d': return 'continuous'
    case 'or': case 'rr': return 'binary'
    case 'hr': return 'survival'
    case 'r': return 'correlation'
    case 'prevalence': return 'rate'
    default: return ''
  }
}

export function effectOf(e: { metric: EvidenceEffectMetric | ''; value: string; ci_low: string; ci_high: string; n: string; p_value: string; higher_is_better: 'true' | 'false' | '' }): EvidenceRowEffectInput | null {
  if (!e.metric || !isMetric(e.metric)) return null
  const filled = [e.value, e.ci_low, e.ci_high, e.n, e.p_value].some((s) => s.trim() !== '')
  if (!filled) return null
  return {
    metric: e.metric,
    value: num(e.value), ci_low: num(e.ci_low), ci_high: num(e.ci_high), n: num(e.n), p_value: num(e.p_value),
    higher_is_better: e.higher_is_better === '' ? null : e.higher_is_better === 'true',
  }
}

/** 这篇作品上还没用过的行号：o1、o2… */
export function nextRowId(work: EvidenceCommunityWork | null): string {
  const used = new Set(work?.rows.map((r) => r.row_id) ?? [])
  for (const p of work?.pending ?? []) if (p.subject.startsWith('row:')) used.add(p.subject.slice(4))
  let i = 1
  while (used.has(`o${i}`)) i++
  return `o${i}`
}

export interface FormIssue { field: string; text: string }

export interface RowPreview {
  /** 引擎验形后的记录（草稿行合法时） */
  record: EvidenceRecord | null
  context: SynthesisContext | null
  /** 引擎的问题码（`intakeOutcomeRows`） */
  codes: string[]
  conceptIds: Partial<Record<EvidenceFacetId, string>>
  /** 数字推出的方向（与所选方向不同时页面提示） */
  derivedDirection: EvidenceDirection | null
}

/** 草稿里的结果行走一遍引擎验形（表单实时调用） */
export function previewRow(d: Draft, workId: string, card: EvidenceWorkCard | null, rowId: string, concepts: readonly EvidenceConcept[]): RowPreview | null {
  const effect = d.numbers ? effectOf(d.effect) : null
  const direction = d.direction || null
  if (!d.outcome.trim() && !effect && !direction) return null
  const context = {
    row_id: rowId, outcome: d.outcome.trim(), comparison: d.context.comparison.trim() || 'unspecified', population: d.context.population.trim() || 'unspecified',
    timepoint: d.context.timepoint.trim() || 'unspecified', unit: d.context.unit.trim() || 'participant', analysis: d.context.analysis.trim() || 'as_reported',
    kind: (d.context.kind || (effect ? kindForMetric(effect.metric) : '') || 'qualitative') as RowKind, locator: d.locator.trim(),
  }
  const conceptIds = resolveConcepts(context, concepts)
  const article = { id: workId, title: card?.title ?? workId, study_design: d.design, year: card?.year ?? null, doi: card?.doi ?? null, is_retracted: card?.is_retracted ?? false }
  const out = intakeOutcomeRows(article, [{
    id: rowId, effect, direction,
    context: { ...context, study_id: workId, dependence_id: workId, reviewed: false, independence_verified: false, ...(Object.keys(conceptIds).length ? { concept_ids: conceptIds } : {}) },
  }])
  const derived = effect && effect.value !== null && Number.isFinite(effect.value) && effect.higher_is_better !== null
    ? directionFromEffect({ metric: effect.metric, value: effect.value, higher_is_better: effect.higher_is_better }) : null
  return {
    record: out.records.find((r) => r.id.endsWith(`/${rowId}`)) ?? null,
    context: out.contexts[0] ?? null,
    codes: out.issues.flatMap((i) => i.codes),
    conceptIds,
    derivedDirection: derived,
  }
}

/** 表单层的必填检查（引擎验形之外） */
export function formIssues(d: Draft, t: Record<string, string>): FormIssue[] {
  const out: FormIssue[] = []
  const effect = d.numbers ? effectOf(d.effect) : null
  const rowStarted = d.outcome.trim() || effect || d.direction
  if (d.design && !d.designLocator.trim()) out.push({ field: 'designLocator', text: t.locatorRequired! })
  if (rowStarted) {
    if (!d.outcome.trim()) out.push({ field: 'outcome', text: t.outcomeRequired! })
    if (!effect && !d.direction) out.push({ field: 'direction', text: t.directionRequired! })
    if (d.numbers && effect) {
      if (d.effect.higher_is_better === '') out.push({ field: 'hib', text: t.hibRequired! })
      if (!d.context.comparison.trim() || !d.context.timepoint.trim()) out.push({ field: 'context', text: t.contextRequired! })
    }
    if (!d.locator.trim()) out.push({ field: 'locator', text: t.locatorRequired! })
  }
  for (const [subject, v] of Object.entries(d.votes)) {
    if (v.op === 'dispute' && v.reason.trim().length < 10) out.push({ field: `vote:${subject}`, text: t.disputeReason! })
  }
  return out
}

/** 草稿 → 断言条目 */
export function buildItems(d: Draft, work: EvidenceCommunityWork | null, rowId: string, t: Record<string, string>): Item[] {
  const items: Item[] = []
  for (const raw of d.newTags) {
    const key = normalizeTag(raw)
    if (key) items.push({ kind: 'tag', op: 'add', subject: `tag:${key}`, payload: { kind: 'tag', tag: raw.trim() } })
  }
  for (const [subject, v] of Object.entries(d.votes)) {
    items.push({ kind: 'review', op: v.op, subject, payload: { kind: 'review', reason: v.reason.trim() || null } })
  }
  if (d.design) items.push({ kind: 'facet', op: 'add', subject: 'facet:design', payload: { kind: 'facet', facet: 'design', value: d.design, locator: d.designLocator.trim() || null } })
  for (const [facet, value] of Object.entries(d.facets)) {
    if (value) items.push({ kind: 'facet', op: 'add', subject: `facet:${facet}`, payload: { kind: 'facet', facet, value } })
  }
  const effect = d.numbers ? effectOf(d.effect) : null
  if (d.outcome.trim() && (effect || d.direction)) {
    const item: Item = {
      kind: 'row', op: 'add', subject: `row:${rowId}`,
      payload: {
        kind: 'row',
        context: {
          row_id: rowId, outcome: d.outcome.trim(), comparison: d.context.comparison.trim() || 'unspecified', population: d.context.population.trim() || 'unspecified',
          timepoint: d.context.timepoint.trim() || 'unspecified', unit: d.context.unit.trim() || 'participant', analysis: d.context.analysis.trim() || 'as_reported',
          kind: (d.context.kind || (effect ? kindForMetric(effect.metric) : '') || 'qualitative') as RowKind, locator: d.locator.trim(),
        },
        effect,
        direction: d.direction || null,
        ...(d.effect.hibReason.trim() ? { higher_is_better_reason: d.effect.hibReason.trim() } : {}),
      },
    }
    if (d.quote.trim()) item.note = d.quote.trim().slice(0, 300)
    items.push(item)
  }
  for (const [id, re] of Object.entries(d.reExtract)) {
    if (!re.result) continue
    const re_extraction = { effect: effectOf(re), direction: re.direction || null }
    if (re.result.match) {
      items.push({ kind: 'review', op: 'endorse', subject: `row:${id}`, payload: { kind: 'review', reason: null, re_extraction, peeked: re.peeked } })
    } else {
      const fields = re.result.diffs.join(', ')
      items.push({ kind: 'review', op: 'dispute', subject: `row:${id}`, payload: { kind: 'review', reason: (t.reExtractReason ?? 'differs: {fields}').replace('{fields}', fields), re_extraction, peeked: re.peeked } })
    }
  }
  void work
  return items
}

/** 给审阅者看的一句人话 */
export function summaryOf(items: readonly Item[], labels: { design: (v: string) => string; direction: (v: string) => string; metric: (v: string) => string }): string {
  const parts: string[] = []
  for (const it of items) {
    const p = it.payload
    if (p.kind === 'tag') parts.push(`#${p.tag}`)
    else if (p.kind === 'facet') parts.push(p.facet === 'design' ? `${labels.design(p.value)}${p.locator ? ` (${p.locator})` : ''}` : `${p.facet}=${p.value}`)
    else if (p.kind === 'row') {
      const e = p.effect
      const eff = e ? `${labels.metric(e.metric)} ${e.value ?? '—'}${e.ci_low !== null && e.ci_high !== null ? ` [${e.ci_low}, ${e.ci_high}]` : ''}${e.n !== null ? `, n=${e.n}` : ''}${e.p_value !== null ? `, p=${e.p_value}` : ''}` : ''
      parts.push(`${p.context.outcome} · ${p.context.comparison} · ${p.context.timepoint}: ${[p.direction ? labels.direction(p.direction) : '', eff].filter(Boolean).join(' · ')} (${p.context.locator})`)
    } else if (p.kind === 'review') parts.push(`${it.op} ${it.subject}${p.re_extraction ? ' (re-extraction)' : ''}${p.peeked ? ' peeked' : ''}`)
  }
  return parts.join(' | ').slice(0, 900)
}

export interface IssueLink { url: string; tooLong: boolean; json: string }

/** issue 新建链接（字段 id 预填）；URL 太长时去掉 payload，由页面复制 JSON */
export function issueLink(payload: Payload, title: string, summary: string): IssueLink {
  const json = JSON.stringify(payload)
  const base = `https://github.com/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/issues/new`
  const q = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
  const full = `${base}?${q({ template: config.issueTemplate, title: `[annotate] ${title}`.slice(0, 200), work: payload.work_id, summary, payload: json })}`
  const bytes = new TextEncoder().encode(full).length
  if (bytes <= config.maxIssueUrlBytes) return { url: full, tooLong: false, json }
  return { url: `${base}?${q({ template: config.issueTemplate, title: `[annotate] ${title}`.slice(0, 200), work: payload.work_id, summary: summary.slice(0, 500) })}`, tooLong: true, json }
}
