/**
 * 作品页 `#/w/<work_key>`：左名片（presentWorkCard）、右「这篇现在被说成什么」（presentCommunityWork）、
 * 模型建议区（灰底、不预选）、三个问题一屏 + 折叠数字卡 + 折叠人群 / 场景分面、实时验形（intakeOutcomeRows）、
 * 预览（describeLadderGap / previewFrameChange）、提交（预填 issue）、盲复录（matchReExtraction）。
 * 表单只建一次；派生面板（检查 / 预览 / 提交）按输入实时重算。草稿按作品键留在内存里，切语言不丢。
 */
import {
  DEFAULT_COMMUNITY_POLICY, EVIDENCE_DIRECTIONS, EVIDENCE_EFFECT_METRICS, buildSynthesisTable, describeLadderGap, matchReExtraction, normalizeTag,
  pickEvidenceView, presentCommunityWork, presentFrameChange, presentIntakeIssues, presentLadderGap, presentWorkCard, previewFrameChange, resolveConcepts,
  summarizeFrames, workRefOfKey,
  type CommunityDecisionView, type EvidenceCommunityWork, type EvidenceDirection, type EvidenceEffectMetric, type EvidenceIntakeIssueCode,
  type EvidenceRecord, type EvidenceWorkCard, type EvidenceWorkRef, type SynthesisContext,
} from 'scholar-meta'
import { type App, openalex } from '../app.js'
import { findWork, scopeByTags, tagKeysOf, tagKeysOfRecord, vocab, vocabConcepts } from '../data.js'
import { button, field, h, input, radios, select, set, textarea } from '../dom.js'
import {
  ROW_KINDS, buildItems, effectOf, emptyDraft, emptyReExtract, formIssues, issueLink, kindForMetric, nextRowId, previewRow, summaryOf,
  type Draft, type Item, type Vote,
} from '../draft.js'
import { fmt } from '../i18n.js'
import { rememberCard } from './home.js'

const drafts = new Map<string, Draft>()
const triedOpenAlex = new Set<string>()

export function workPage(app: App, key: string): HTMLElement {
  const { t, m, locale } = app
  const ref = workRefOfKey(key)
  if (!ref) return h('div', { class: 'page work' }, [h('p', { class: 'warn' }, [t.workNotFound]), h('p', {}, [h('a', { href: '#/' }, [t.backHome])])])
  const workRef: EvidenceWorkRef = ref
  const work = findWork(app.data, key)
  const workId = work?.work_id ?? key
  const card: EvidenceWorkCard | null = work?.card ?? app.cards.get(key) ?? null
  const cardSource = work?.card ? t.cardFromExport : card ? t.cardFromOpenAlex : null
  const draft = drafts.get(workId) ?? emptyDraft()
  drafts.set(workId, draft)
  const concepts = app.data?.concepts ?? vocabConcepts()
  const tolerance = app.data?.exp.manifest.policy.row.tolerance ?? DEFAULT_COMMUNITY_POLICY.row.tolerance
  const rowId = nextRowId(work)
  const po = { locale }
  const tr = t as unknown as Record<string, string>

  // ── 派生面板 ───────────────────────────────────────────────────────────────
  const issuesBox = h('div', { class: 'card issues', 'aria-live': 'polite' })
  const previewBox = h('div', { class: 'card preview', 'aria-live': 'polite' })
  const submitBox = h('div', { class: 'card submit' })

  function update() {
    const preview = previewRow(draft, workId, card, rowId, concepts)
    const issues = formIssues(draft, tr)
    // 引擎验形的问题：词典里有的走 presentIntakeIssues，其余三个是 intakeOutcomeRows 自己的码
    const engineCodes = preview?.codes ?? []
    const known = engineCodes.filter((c): c is EvidenceIntakeIssueCode => c in m.intake)
    const engineTexts = [
      ...presentIntakeIssues(known.map((code) => ({ code, field: `row:${rowId}`, action: 'flagged' as const })), po).map((i) => i.text),
      ...engineCodes.filter((c) => !(c in m.intake)).map((c) => tr[`issue_${c}`] ?? c),
    ]
    const conflict = preview?.derivedDirection && draft.direction && draft.direction !== preview.derivedDirection
      ? fmt(t.directionConflict, { derived: m.direction[preview.derivedDirection] }) : null
    const all = [...issues.map((i) => i.text), ...engineTexts, ...(conflict ? [conflict] : [])]
    issuesBox.replaceChildren(
      h('h3', {}, [t.issuesTitle]),
      all.length === 0 ? h('p', { class: 'ok' }, [t.noIssues]) : h('ul', { class: 'issue-list' }, all.map((x) => h('li', {}, [x]))),
    )
    renderPreview(preview?.record ?? null, preview?.context ?? null, preview?.conceptIds ?? {})
    renderSubmit(issues.length > 0)
  }

  function renderPreview(record: EvidenceRecord | null, context: SynthesisContext | null, conceptIds: Partial<Record<string, string>>) {
    const scopeKeys = [...tagKeysOf(work), ...draft.newTags.map((x) => normalizeTag(x)).filter((x): x is string => !!x)]
    const scope = app.data ? scopeByTags(app.data, scopeKeys) : { records: [] as EvidenceRecord[], contexts: [] as SynthesisContext[], scoped: false }
    const current = pickEvidenceView(scope.records)
    const gap = presentLadderGap(describeLadderGap(scope.records, record), { usable: current.usable, total: current.total }, po)
    const scopeText = scope.scoped ? fmt(t.ladderScopeTag, { tags: scopeKeys.join(', '), n: scope.records.length }) : fmt(t.ladderScopeAll, { n: scope.records.length })
    const frames: Node[] = []
    if (record && context) {
      const meta = { concepts, locale, tagsOf: (id: string) => (id === record.id ? scopeKeys : app.data ? tagKeysOfRecord(app.data, id) : []) }
      const before = summarizeFrames(buildSynthesisTable(scope.records, scope.contexts), meta)
      const after = summarizeFrames(buildSynthesisTable([...scope.records, record], [...scope.contexts, context]), meta)
      const changes = presentFrameChange(previewFrameChange(before, after), po).filter((c) => c.changed.length > 0)
      frames.push(changes.length === 0 ? h('p', { class: 'muted' }, [t.framesUnchanged]) : h('ul', { class: 'frames' }, changes.map((c) => h('li', {}, [c.text]))))
      const labels = Object.values(conceptIds).map((id) => { const c = concepts.find((x) => x.id === id); return c ? (c.label[locale] ?? c.label.en ?? id) : id })
      if (labels.length) frames.push(h('p', { class: 'muted' }, [fmt(t.conceptResolved, { list: labels.join(', ') })]))
    } else frames.push(h('p', { class: 'muted' }, [t.framesNone]))
    set(previewBox, [
      h('h3', {}, [t.previewTitle]),
      h('p', { class: 'pending-first' }, [h('strong', {}, [t.pendingFirst]), ' ', m.text.community_pending_hint]),
      h('p', {}, [gap.current_text]),
      gap.with_draft_text ? h('p', {}, [gap.with_draft_text]) : null,
      h('p', {}, [gap.next_text]),
      gap.pooling_text ? h('p', {}, [gap.pooling_text]) : null,
      h('small', { class: 'muted' }, [scopeText]),
      h('h4', {}, [t.framesTitle]),
      ...frames,
      h('p', { class: 'hint' }, [t.synthesisNote]),
    ])
  }

  function renderSubmit(blocked: boolean) {
    const items = buildItems(draft, work, rowId, tr)
    if (items.length === 0) { submitBox.replaceChildren(h('h3', {}, [t.submitTitle]), h('p', { class: 'muted' }, [t.submitEmpty])); return }
    const payload = { form: 'annotate/1' as const, work_id: workId, items }
    const summary = summaryOf(items, {
      design: (v) => m.studyDesign[v as keyof typeof m.studyDesign] ?? v,
      direction: (v) => m.direction[v as EvidenceDirection] ?? v,
      metric: (v) => m.metric[v as EvidenceEffectMetric] ?? v,
    })
    const link = issueLink(payload, card?.title ?? workId, summary)
    const status = h('p', { class: 'status', 'aria-live': 'polite' })
    const go = button(t.submitButton, async () => {
      if (link.tooLong) {
        try { await navigator.clipboard.writeText(link.json); status.textContent = t.copyFallback } catch { status.textContent = t.copyFailed }
      }
      window.open(link.url, '_blank', 'noopener')
    }, { class: 'primary', disabled: blocked })
    submitBox.replaceChildren(
      h('h3', {}, [t.submitTitle, ' ', h('small', { class: 'muted' }, [fmt(t.submitCount, { n: items.length })])]),
      h('p', {}, [go]),
      h('small', { class: 'hint' }, [t.submitNote]),
      status,
      h('details', {}, [h('summary', {}, [t.summaryLabel]), h('p', {}, [summary])]),
      h('details', {}, [h('summary', {}, [t.payloadLabel]), h('textarea', { readonly: true, rows: 8, class: 'json' }, [JSON.stringify(payload, null, 2)])]),
    )
  }

  // ── 投票（✓ / ✗ / ？）────────────────────────────────────────────────────────
  function voteGroup(subject: string): HTMLElement {
    const box = h('span', { class: 'votes', role: 'group' })
    const draw = () => {
      const cur: Vote | undefined = draft.votes[subject]
      const mk = (op: Vote['op'], label: string) => button(label, () => {
        if (cur?.op === op) delete draft.votes[subject]
        else draft.votes[subject] = { op, reason: cur?.reason ?? '' }
        draw(); update()
      }, { class: 'vote', 'aria-pressed': cur?.op === op ? 'true' : 'false' })
      box.replaceChildren(mk('endorse', t.voteEndorse), mk('dispute', t.voteDispute), mk('unsure', t.voteUnsure))
      if (cur?.op === 'dispute') {
        box.append(input(cur.reason, (v) => { cur.reason = v; update() }, { placeholder: t.disputeReason, 'aria-label': t.disputeReason, class: 'reason' }))
      }
    }
    draw()
    return box
  }

  // ── 名片 ─────────────────────────────────────────────────────────────────
  function cardSection(): HTMLElement {
    const head = h('h3', {}, [t.cardTitle, cardSource ? h('small', { class: 'muted' }, [' · ', cardSource]) : null])
    if (!card) {
      const status = h('p', { class: 'status', 'aria-live': 'polite' })
      const ask = button(t.askOpenAlex, async () => {
        ask.disabled = true
        status.textContent = t.openAlexSearching
        const r = await openalex().fetchWorkCard(workRef)
        triedOpenAlex.add(key)
        if (r.kind === 'found') { rememberCard(app, key, r.card); app.rerender(); return }
        ask.disabled = false
        status.textContent = r.kind === 'error' ? t.openAlexError : t.openAlexNotFound
      }, { class: 'primary' })
      return h('section', { class: 'card bib' }, [
        head, h('p', {}, [h('strong', {}, [t.cardNone]), ' ', h('code', {}, [workId])]), h('p', { class: 'hint' }, [t.cardNoneHint]),
        h('p', {}, [ask]), h('small', { class: 'hint privacy' }, [t.openAlexPrivacy]), status,
      ])
    }
    const v = presentWorkCard(card, po)
    return h('section', { class: 'card bib' }, [
      head,
      h('h2', { class: 'title' }, [v.title]),
      h('p', {}, [v.meta]),
      // 引擎 0.6.0 的 venue_with_type 模板占位符与 presentWorkCard 传的键不一致（{name} / venue）：这里兜底填上刊名
      v.venue ? h('p', { class: 'muted' }, [v.venue.replace('{name}', card.venue?.name ?? '')]) : null,
      v.type_text ? h('p', {}, [v.type_text, ' ', h('small', { class: 'muted' }, [v.type_hint])]) : null,
      v.cited_text ? h('p', { class: 'muted' }, [v.cited_text]) : null,
      v.retracted_text ? h('p', { class: 'warn' }, [v.retracted_text]) : null,
      h('p', { class: 'muted' }, [h('code', {}, [workId]), card.doi ? h('a', { href: `https://doi.org/${card.doi}`, rel: 'noopener' }, [' doi.org']) : null, v.oa_url ? h('a', { href: v.oa_url, rel: 'noopener' }, [' OA']) : null]),
      v.abstract ? h('details', {}, [h('summary', {}, [t.abstractTitle]), h('p', { class: 'abstract' }, [v.abstract])]) : null,
    ])
  }

  // ── 这篇现在被说成什么 ─────────────────────────────────────────────────────────
  const stateChip = (state: string, text: string) => h('span', { class: `chip ${state}` }, [text, ' ', h('small', { class: 'state' }, [`· ${(m.communityState as Record<string, string>)[state] ?? (m.workTagState as Record<string, string>)[state] ?? state}`])])
  const decisionLine = (d: CommunityDecisionView) => h('small', { class: 'muted block' }, [[d.text, d.quorum_text, d.verification_text, d.re_extractions_text, ...d.issues_text, d.reasons_text].filter(Boolean).join(' · ')])

  function statusSection(): HTMLElement {
    if (!work) return h('section', { class: 'card status-card' }, [h('h3', {}, [t.statusTitle]), h('p', { class: 'muted' }, [t.statusNone])])
    const cw = presentCommunityWork(work, po)
    const tagRows = cw.tags.map((x) => h('li', {}, [stateChip(x.state, x.label), h('small', { class: 'muted block' }, [[x.text, x.support_text, x.quorum_text].filter(Boolean).join(' · ')]), voteGroup(`tag:${x.tag_key}`)]))
    const pendingRows = cw.pending.map((d) => h('li', {}, [stateChip(d.state, d.value ?? d.subject), h('small', { class: 'muted block' }, [`${d.kind_text} · ${d.subject}`]), decisionLine(d), voteGroup(d.subject)]))
    const facetRows = cw.facets.map((f) => h('li', {}, [stateChip(f.decision.state, f.text), f.locators.length ? h('small', { class: 'muted block' }, [f.locators.join(' · ')]) : null, decisionLine(f.decision), voteGroup(`facet:${f.facet}`)]))
    const rowRows = cw.rows.map((r) => rowItem(work, r))
    const empty = tagRows.length + pendingRows.length + facetRows.length + rowRows.length === 0
    return h('section', { class: 'card status-card' }, [
      h('h3', {}, [t.statusTitle]),
      empty ? h('p', { class: 'muted' }, [t.statusNone]) : null,
      tagRows.length ? h('h4', {}, [t.tagsTitle]) : null, tagRows.length ? h('ul', { class: 'said' }, tagRows) : null,
      facetRows.length ? h('h4', {}, [t.facetsTitle]) : null, facetRows.length ? h('ul', { class: 'said' }, facetRows) : null,
      rowRows.length ? h('h4', {}, [t.rowsTitle]) : null, rowRows.length ? h('ul', { class: 'said' }, rowRows) : null,
      pendingRows.length ? h('h4', {}, [t.pendingTitle]) : null, pendingRows.length ? h('ul', { class: 'said' }, pendingRows) : null,
      cw.unsure > 0 ? h('p', { class: 'muted' }, [fmt(t.unsureCount, { n: cw.unsure })]) : null,
    ])
  }

  /** 一条结果行：裁决 + 「复录」（认可数字必须盲复录，所以这里不给裸的 ✓） */
  function rowItem(w: EvidenceCommunityWork, r: { row_id: string; text: string; decision: CommunityDecisionView }): HTMLElement {
    const original = w.rows.find((x) => x.row_id === r.row_id)!
    const panel = h('div', { class: 'reextract' })
    const drawPanel = () => {
      const re = draft.reExtract[r.row_id]
      if (!re) { panel.replaceChildren(); return }
      const metricOpts = [{ value: '', label: t.metricUnset }, ...EVIDENCE_EFFECT_METRICS.map((x) => ({ value: x, label: m.metric[x] }))]
      const numField = (k: 'value' | 'ci_low' | 'ci_high' | 'n' | 'p_value', label: string) => field(label, input(re[k], (v) => { re[k] = v; re.result = null; drawPanel() }, { inputmode: 'decimal' }))
      const compare = button(t.compare, () => {
        re.result = matchReExtraction({ effect: original.input.effect, direction: original.input.direction }, { effect: effectOf(re), direction: re.direction || null }, tolerance)
        drawPanel(); update()
      }, { class: 'primary' })
      const peek = button(re.showing ? t.hideOriginal : t.showOriginal, () => { re.showing = !re.showing; if (re.showing) re.peeked = true; drawPanel(); update() })
      const cancel = button(t.cancel, () => { delete draft.reExtract[r.row_id]; drawPanel(); update() })
      set(panel, [
        h('h4', {}, [fmt(t.reExtractTitle, { row: r.row_id })]),
        h('p', { class: 'hint' }, [t.reExtractHint]),
        re.showing ? h('p', { class: 'original' }, [r.text]) : null,
        re.peeked ? h('p', { class: 'warn' }, [t.peeked]) : null,
        h('div', { class: 'grid3' }, [
          field(t.metric, select(metricOpts, re.metric, (v) => { re.metric = v as EvidenceEffectMetric | ''; re.result = null; drawPanel() })),
          numField('value', t.value), numField('ci_low', t.ciLow), numField('ci_high', t.ciHigh), numField('n', t.n), numField('p_value', t.p),
          field(t.hib, select([{ value: '', label: t.hibUnset }, { value: 'true', label: t.hibTrue }, { value: 'false', label: t.hibFalse }], re.higher_is_better, (v) => { re.higher_is_better = v as 'true' | 'false' | ''; re.result = null; drawPanel() })),
          field(t.direction, select([{ value: '', label: '—' }, ...EVIDENCE_DIRECTIONS.map((d) => ({ value: d, label: m.direction[d] }))], re.direction, (v) => { re.direction = v as EvidenceDirection | ''; re.result = null; drawPanel() })),
        ]),
        h('p', { class: 'row' }, [compare, peek, cancel]),
        re.result ? h('p', { class: re.result.match ? 'ok' : 'warn' }, [re.result.match ? t.matchOk : fmt(t.matchDiff, { fields: re.result.diffs.join(', ') })]) : null,
      ])
    }
    const start = button(t.reExtract, () => { if (!draft.reExtract[r.row_id]) draft.reExtract[r.row_id] = emptyReExtract(); drawPanel() }, { class: 'vote' })
    const votes = h('span', { class: 'votes', role: 'group' })
    const drawVotes = () => {
      const cur = draft.votes[`row:${r.row_id}`]
      const mk = (op: 'dispute' | 'unsure', label: string) => button(label, () => {
        if (cur?.op === op) delete draft.votes[`row:${r.row_id}`]
        else draft.votes[`row:${r.row_id}`] = { op, reason: cur?.reason ?? '' }
        drawVotes(); update()
      }, { class: 'vote', 'aria-pressed': cur?.op === op ? 'true' : 'false' })
      votes.replaceChildren(start, mk('dispute', t.voteDispute), mk('unsure', t.voteUnsure))
      if (cur?.op === 'dispute') votes.append(input(cur.reason, (v) => { cur.reason = v; update() }, { placeholder: t.disputeReason, 'aria-label': t.disputeReason, class: 'reason' }))
    }
    drawVotes()
    drawPanel()
    return h('li', {}, [stateChip(r.decision.state, `${r.row_id} · ${r.text}`), decisionLine(r.decision), votes, panel])
  }

  // ── 模型建议（灰底、不预选）──────────────────────────────────────────────────
  let newTagBox: HTMLInputElement
  function modelSection(): HTMLElement {
    const items = card ? [...card.topics.map((x) => x.display_name), ...card.keywords, ...card.mesh] : []
    const seen = new Set<string>()
    const chips = items.filter((x) => { const k = normalizeTag(x); if (!k || seen.has(k)) return false; seen.add(k); return true })
      .map((x) => button(x, () => { newTagBox.value = x; newTagBox.dispatchEvent(new Event('input')); newTagBox.focus() }, { class: 'chip model' }))
    return h('section', { class: 'card model' }, [
      h('h3', {}, [t.modelTitle]), h('p', { class: 'hint' }, [t.modelHint]),
      chips.length ? h('p', { class: 'chips' }, chips) : h('p', { class: 'muted' }, [t.modelNone]),
    ])
  }

  // ── 三个问题 ───────────────────────────────────────────────────────────────
  function formSection(): HTMLElement {
    // Q1 标签
    const tagList = h('ul', { class: 'newtags' })
    const tagLive = h('small', { class: 'hint block', 'aria-live': 'polite' })
    const facetWords = new Set(Object.values(vocab.facets).flatMap((f) => f.values).map((v) => normalizeTag(v)).filter(Boolean))
    const drawTags = () => tagList.replaceChildren(...draft.newTags.map((raw, i) => h('li', {}, [
      h('span', { class: 'chip new' }, [raw, ' ', h('small', { class: 'state' }, [`· ${normalizeTag(raw) ?? '?'}`])]),
      button(t.remove, () => { draft.newTags.splice(i, 1); drawTags(); update() }, { class: 'vote' }),
    ])))
    const live = (raw: string) => {
      const key = normalizeTag(raw)
      if (!raw.trim()) { tagLive.replaceChildren(); return }
      if (!key) { tagLive.textContent = t.tagInvalid; return }
      const n = app.data?.tags.get(key)?.works.size ?? 0
      const parts = [fmt(t.normalisedAs, { key }), n > 0 ? fmt(t.sameKeyCount, { n }) : t.sameKeyNone]
      const words = key.split(' ').filter((w) => facetWords.has(w) || facetWords.has(w.replace(/-/g, '_')))
      if (facetWords.has(key) || facetWords.has(key.replace(/ /g, '_'))) parts.push(fmt(t.facetWord, { word: raw.trim() }))
      else if (words.length) parts.push(fmt(t.facetWord, { word: words[0]! }))
      tagLive.textContent = parts.join(' · ')
    }
    newTagBox = input('', live, { placeholder: t.newTagPlaceholder, 'aria-label': t.newTag, 'data-focus': 'newtag' })
    const add = () => {
      const raw = newTagBox.value.trim()
      const key = normalizeTag(raw)
      if (!key) return
      if (!draft.newTags.some((x) => normalizeTag(x) === key)) draft.newTags.push(raw)
      newTagBox.value = ''; live(''); drawTags(); update()
    }
    newTagBox.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add() } })
    drawTags()
    const q1 = h('fieldset', { class: 'q' }, [
      h('legend', {}, [t.q1]), h('p', { class: 'hint' }, [t.q1Hint]),
      tagList,
      h('div', { class: 'row' }, [newTagBox, button(t.addTag, add)]),
      tagLive,
    ])

    // Q2 研究设计（不预选）+ 出处
    const designValues = vocab.facets.design?.values ?? []
    const locatorBox = h('div', { class: 'locator' })
    const drawLocator = () => locatorBox.replaceChildren(...(draft.design ? [
      field(t.designLocator, input(draft.designLocator, (v) => { draft.designLocator = v; update() }, { placeholder: t.locatorPlaceholder, required: true })),
      button(t.voteClear, () => { draft.design = null; draft.designLocator = ''; drawDesign(); drawLocator(); update() }, { class: 'vote' }),
    ] : []))
    const designBox = h('div', {})
    const drawDesign = () => designBox.replaceChildren(radios('design', designValues.map((v) => ({
      value: v, label: m.studyDesign[v as keyof typeof m.studyDesign] ?? v, hint: m.studyDesignMeaning[v as keyof typeof m.studyDesignMeaning] ?? null,
    })), draft.design, (v) => { draft.design = v; drawLocator(); update() }))
    drawDesign(); drawLocator()
    const otherFacets = Object.entries(vocab.facets).filter(([k]) => k !== 'design').map(([k, f]) => field(
      f.label[locale] ?? f.label.en ?? k,
      select([{ value: '', label: t.facetUnset }, ...f.values.map((v) => ({ value: v, label: v.replace(/_/g, ' ') }))], draft.facets[k] ?? '', (v) => { draft.facets[k] = v || null; update() }),
    ))
    const q2 = h('fieldset', { class: 'q' }, [
      h('legend', {}, [t.q2]), h('p', { class: 'hint' }, [t.q2Hint]),
      designBox, locatorBox,
      h('details', { class: 'more' }, [h('summary', {}, [t.moreFacets]), h('div', { class: 'grid3' }, otherFacets)]),
    ])

    // Q3 主结局偏向哪边 + 数字卡
    const hibHint = h('small', { class: 'hint block' })
    const drawHibHint = () => {
      const ids = resolveConcepts({ outcome: draft.outcome }, concepts)
      const c = ids.outcome ? concepts.find((x) => x.id === ids.outcome) : null
      const def = c?.default_higher_is_better
      hibHint.textContent = def === true || def === false ? fmt(t.hibDefault, { v: def ? t.hibTrue : t.hibFalse }) : ''
      if (c?.default_kind && !draft.context.kind) { draft.context.kind = c.default_kind; kindSel.value = c.default_kind }
    }
    const outcomeBox = input(draft.outcome, (v) => { draft.outcome = v; drawHibHint(); update() }, { placeholder: t.outcomePlaceholder, required: true, 'data-focus': 'outcome' })
    const directionBox = radios('direction', EVIDENCE_DIRECTIONS.map((d) => ({ value: d, label: m.direction[d] })), draft.direction || null, (v) => { draft.direction = v as EvidenceDirection; update() })
    const locator = input(draft.locator, (v) => { draft.locator = v; update() }, { placeholder: t.locatorPlaceholder })
    const quote = textarea(draft.quote, (v) => { draft.quote = v.slice(0, 300); update() }, { maxlength: 300, rows: 2 })

    const metricSel = select([{ value: '', label: t.metricUnset }, ...EVIDENCE_EFFECT_METRICS.map((x) => ({ value: x, label: m.metric[x] }))], draft.effect.metric, (v) => {
      draft.effect.metric = v as EvidenceEffectMetric | ''
      const k = kindForMetric(draft.effect.metric)
      if (k) { draft.context.kind = k; kindSel.value = k }
      update()
    })
    const kindSel = select([{ value: '', label: '—' }, ...ROW_KINDS.map((k) => ({ value: k, label: k }))], draft.context.kind, (v) => { draft.context.kind = v as typeof draft.context.kind; update() })
    const numField = (k: 'value' | 'ci_low' | 'ci_high' | 'n' | 'p_value', label: string) => field(label, input(draft.effect[k], (v) => { draft.effect[k] = v; update() }, { inputmode: 'decimal' }))
    const ctxField = (k: 'comparison' | 'population' | 'timepoint' | 'unit' | 'analysis', label: string, placeholder?: string) =>
      field(label, input(draft.context[k], (v) => { draft.context[k] = v; update() }, { placeholder: placeholder ?? null }))
    const numbers = h('details', { class: 'more numbers', open: draft.numbers }, [
      h('summary', {}, [t.numbersToggle]),
      h('p', { class: 'hint' }, [t.numbersHint]),
      h('div', { class: 'grid3' }, [
        field(t.metric, metricSel), numField('value', t.value), numField('ci_low', t.ciLow), numField('ci_high', t.ciHigh), numField('n', t.n), numField('p_value', t.p),
      ]),
      field(t.hib, radios('hib', [{ value: 'true', label: t.hibTrue }, { value: 'false', label: t.hibFalse }], draft.effect.higher_is_better || null, (v) => { draft.effect.higher_is_better = v as 'true' | 'false'; update() })),
      hibHint,
      field(t.hibReason, input(draft.effect.hibReason, (v) => { draft.effect.hibReason = v; update() })),
      h('div', { class: 'grid3' }, [
        ctxField('comparison', t.comparison, t.comparisonPlaceholder), ctxField('population', t.population, t.populationPlaceholder), ctxField('timepoint', t.timepoint, t.timepointPlaceholder),
        ctxField('unit', t.unit), ctxField('analysis', t.analysis), field(t.kind, kindSel),
      ]),
    ])
    numbers.addEventListener('toggle', () => { draft.numbers = numbers.open; update() })
    drawHibHint()
    const q3 = h('fieldset', { class: 'q' }, [
      h('legend', {}, [t.q3]), h('p', { class: 'hint' }, [t.q3Hint]),
      field(t.outcome, outcomeBox),
      field(t.direction, directionBox),
      field(t.rowLocator, locator),
      field(t.quote, quote),
      numbers,
    ])
    return h('section', { class: 'card form' }, [h('h3', {}, [t.qTitle]), q1, q2, q3])
  }

  const page = h('div', { class: 'page work' }, [
    h('header', { class: 'page-head' }, [h('p', { class: 'muted' }, [h('a', { href: '#/' }, [t.backHome])])]),
    h('div', { class: 'two' }, [cardSection(), statusSection()]),
    modelSection(),
    formSection(),
    h('div', { class: 'two' }, [issuesBox, previewBox]),
    submitBox,
  ])
  update()
  return page
}

export type { Item }
