/**
 * 入口：输入框（parseWorkRef）、本地 PDF、打样书架。
 * DOI / W 编号 / PMID 先查本站导出；没有 ⇒ 用户点「向 OpenAlex 查询」才出网。链接 / 标题 ⇒ 用户点「搜候选」才出网。
 */
import { parseWorkRef, workKeyOf, presentWorkCard, type EvidenceWorkRef, type EvidenceWorkCard } from 'scholar-meta'
import type { OpenAlexWorkHit } from 'scholar-meta/openalex'
import { type App, openalex, routeTag, routeWork } from '../app.js'
import { findWork } from '../data.js'
import { button, h, input } from '../dom.js'
import { fmt } from '../i18n.js'
import { scanPdf } from '../pdf.js'

export function homePage(app: App): HTMLElement {
  const { t } = app
  const result = h('div', { class: 'panel result', 'aria-live': 'polite' })
  let value = ''

  const box = input('', (v) => { value = v }, { placeholder: t.inputPlaceholder, 'aria-label': t.inputLabel, autocomplete: 'off', spellcheck: 'false', 'data-focus': 'entry' })
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); lookup(value) } })

  const file = h('input', { type: 'file', accept: 'application/pdf,.pdf', class: 'visually-hidden', id: 'pdf-file' })
  file.addEventListener('change', async () => {
    const f = file.files?.[0]
    if (!f) return
    result.replaceChildren(h('p', {}, [t.pdfReading]))
    const r = await scanPdf(f)
    file.value = ''
    if (r.kind === 'error') { result.replaceChildren(h('p', { class: 'warn' }, [t.pdfError])); return }
    if (r.kind === 'doi') {
      box.value = r.doi; value = r.doi
      lookup(r.doi, h('p', { class: 'ok' }, [fmt(t.pdfFoundDoi, { doi: r.doi })]))
    } else {
      box.value = r.line; value = r.line
      lookup(r.line, h('p', {}, [fmt(t.pdfNoDoi, { line: r.line })]))
    }
  })

  function lookup(raw: string, lead?: HTMLElement) {
    const ref = parseWorkRef(raw)
    const out: Node[] = lead ? [lead] : []
    if (!ref) { out.push(h('p', { class: 'warn' }, [t.notRecognised])); result.replaceChildren(...out); return }
    out.push(h('p', { class: 'muted' }, [fmt(t.recognisedAs, { kind: t[`kind_${ref.kind}`], value: ref.value })]))
    const key = workKeyOf(ref)
    if (key) {
      const local = findWork(app.data, key) ?? (app.cards.has(key) ? app.cards.get(key) : null)
      if (local) {
        out.push(h('p', { class: 'ok' }, [t.foundInExport]), h('p', {}, [h('a', { class: 'btn primary', href: routeWork(key) }, [t.openWork])]))
      } else {
        out.push(h('p', {}, [t.notInExport]), ...askOpenAlexBlock(app, ref, key))
      }
    } else {
      out.push(h('p', {}, [ref.kind === 'url' ? t.urlHint : t.titleHint]), candidatesBlock(app, ref))
    }
    result.replaceChildren(...out)
  }

  const entry = h('section', { class: 'card entry' }, [
    h('h2', {}, [t.inputLabel]),
    h('div', { class: 'row' }, [box, button(t.go, () => lookup(value), { class: 'primary', 'data-focus': 'go' })]),
    h('div', { class: 'row pdf' }, [
      file,
      h('label', { for: 'pdf-file', class: 'btn' }, [t.pdfButton]),
      h('small', { class: 'hint' }, [t.pdfNote]),
    ]),
    result,
  ])

  return h('div', { class: 'page home' }, [entry, shelf(app)])
}

/** 「向 OpenAlex 查询」：明示会把编号与 IP 发给 OpenAlex；三态结果都说清楚 */
function askOpenAlexBlock(app: App, ref: EvidenceWorkRef, key: string): Node[] {
  const { t } = app
  const status = h('p', { class: 'status', 'aria-live': 'polite' })
  const ask = button(t.askOpenAlex, async () => {
    ask.disabled = true
    status.textContent = t.openAlexSearching
    const r = await openalex().fetchWorkCard(ref)
    ask.disabled = false
    if (r.kind === 'found') { rememberCard(app, key, r.card); app.navigate(routeWork(key)); return }
    status.replaceChildren(h('span', { class: r.kind === 'error' ? 'warn' : '' }, [r.kind === 'error' ? t.openAlexError : t.openAlexNotFound]))
  }, { class: 'primary', 'data-focus': 'ask-openalex' })
  return [
    h('p', { class: 'row' }, [ask, h('a', { class: 'btn', href: routeWork(key) }, [t.annotateWithoutCard])]),
    h('small', { class: 'hint privacy' }, [t.openAlexPrivacy]),
    status,
  ]
}

/** 链接 / 标题 ⇒ 搜候选（0 credit 的自动补全） */
function candidatesBlock(app: App, ref: EvidenceWorkRef): HTMLElement {
  const { t } = app
  const list = h('div', { class: 'candidates', 'aria-live': 'polite' })
  const search = button(t.searchCandidates, async () => {
    search.disabled = true
    list.replaceChildren(h('p', {}, [t.openAlexSearching]))
    const hits = await openalex().autocompleteWorks(ref.value)
    search.disabled = false
    if (hits === null) { list.replaceChildren(h('p', { class: 'warn' }, [t.candidatesError])); return }
    if (hits.length === 0) { list.replaceChildren(h('p', {}, [t.candidatesNone])); return }
    list.replaceChildren(h('h3', {}, [t.candidatesTitle]), h('ul', { class: 'hits' }, hits.map((hit) => candidateRow(app, hit))))
  }, { class: 'primary', 'data-focus': 'search' })
  return h('div', {}, [h('p', { class: 'row' }, [search]), h('small', { class: 'hint privacy' }, [t.openAlexPrivacy]), list])
}

function candidateRow(app: App, hit: OpenAlexWorkHit): HTMLElement {
  const { t } = app
  const key = hit.doi ? `doi:${hit.doi}` : hit.id
  const pick = button(t.pickCandidate, async () => {
    if (findWork(app.data, key) || app.cards.has(key)) { app.navigate(routeWork(key)); return }
    pick.disabled = true
    pick.textContent = t.openAlexSearching
    const r = await openalex().fetchWorkCard(hit.doi ? { kind: 'doi', value: hit.doi } : { kind: 'openalex', value: hit.id.replace(/^openalex:/, '') })
    if (r.kind === 'found') rememberCard(app, key, r.card)
    app.navigate(routeWork(key))
  })
  return h('li', {}, [
    h('div', {}, [h('strong', {}, [hit.title]), h('small', { class: 'muted' }, [[hit.year ? String(hit.year) : null, hit.hint, hit.doi].filter(Boolean).join(' · ')])]),
    pick,
  ])
}

/** 名片按作品键与各别名键都记住（只在内存里） */
export function rememberCard(app: App, key: string, card: EvidenceWorkCard) {
  app.cards.set(key, card)
  if (card.doi) app.cards.set(`doi:${card.doi}`, card)
  if (card.id) app.cards.set(card.id, card)
  if (card.pmid) app.cards.set(`pmid:${card.pmid}`, card)
}

function shelf(app: App): HTMLElement {
  const { t, exportState } = app
  const body: Node[] = []
  if (exportState.status === 'loading') body.push(h('p', { class: 'muted' }, [t.loading]))
  else if (exportState.status === 'missing') body.push(h('p', { class: 'muted' }, [t.shelfMissing]))
  else if (exportState.status === 'bad') body.push(h('p', { class: 'warn' }, [fmt(t.shelfBad, { n: exportState.issues })]))
  else {
    const { exp, tags } = exportState.data
    const c = exp.manifest.counts
    body.push(h('p', { class: 'muted' }, [fmt(t.shelfCounts, { works: c.works, assertions: c.assertions, contributors: c.contributors, at: exp.manifest.generated_at.slice(0, 10) || '—' })]))
    if (exp.works.length === 0) body.push(h('p', {}, [t.shelfEmpty]))
    else {
      const top = [...tags.values()].sort((a, b) => b.works.size - a.works.size || (a.tag_key < b.tag_key ? -1 : 1)).slice(0, 40)
      if (top.length) body.push(h('p', { class: 'cloud' }, top.map((e) => h('a', { class: 'chip link', href: routeTag(e.tag_key) }, [e.label, ' ', h('small', {}, [fmt(t.tagsCount, { n: e.works.size })])]))))
      const works = [...exp.works].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)).slice(0, 60)
      body.push(h('ul', { class: 'shelf' }, works.map((w) => {
        const card = w.card ? presentWorkCard(w.card, { locale: app.locale }) : null
        return h('li', {}, [
          h('a', { href: routeWork(w.work_id) }, [card?.title ?? w.work_id]),
          h('small', { class: 'muted' }, [card?.meta ?? w.work_id]),
          h('span', { class: 'chips' }, [
            ...w.tags.filter((x) => x.state === 'present').slice(0, 6).map((x) => h('span', { class: 'chip present' }, [x.label])),
            w.pending.length ? h('span', { class: 'chip pending' }, [`${t.pendingTitle} ${w.pending.length}`]) : null,
          ]),
        ])
      })))
    }
  }
  return h('section', { class: 'card shelf-card' }, [h('h2', {}, [t.shelfTitle]), h('p', { class: 'hint' }, [t.shelfHint]), ...body])
}
