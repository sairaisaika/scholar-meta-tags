/**
 * 标签页 `#/t/<tag_key>`：带这个标签的作品、这批记录能画到哪一级（`pickEvidenceView` + `describeLadderGap` 现算）、frame 列表。
 */
import {
  buildSynthesisTable, describeLadderGap, pickEvidenceView, presentFrames, presentLadderGap, presentWorkCard, summarizeFrames,
} from 'scholar-meta'
import { type App, routeWork } from '../app.js'
import { scopeByTags, tagKeysOfRecord } from '../data.js'
import { h } from '../dom.js'
import { fmt } from '../i18n.js'

export function tagPage(app: App, tagKey: string): HTMLElement {
  const { t, data, locale } = app
  const entry = data?.tags.get(tagKey) ?? null
  const head = h('header', { class: 'page-head' }, [
    h('h2', {}, [fmt(t.tagTitle, { tag: entry?.label ?? tagKey })]),
    h('p', { class: 'muted' }, [h('code', {}, [tagKey])]),
  ])
  if (!data || !entry) return h('div', { class: 'page tag' }, [head, h('p', {}, [t.tagNoWorks]), h('p', {}, [h('a', { href: '#/' }, [t.backHome])])])

  const binding = data.exp.bindings.find((b) => b.tag_key === tagKey) ?? null
  const works = [...entry.works].map((k) => data.ports.work(k)).filter((w): w is NonNullable<typeof w> => !!w)
  const scope = scopeByTags(data, [tagKey])
  const view = pickEvidenceView(scope.records)
  const gap = presentLadderGap(describeLadderGap(scope.records), { usable: view.usable, total: view.total }, { locale })
  const table = buildSynthesisTable(scope.records, scope.contexts)
  const frames = presentFrames(summarizeFrames(table, { concepts: data.concepts, locale, tagsOf: (id) => tagKeysOfRecord(data, id) }), { locale })

  return h('div', { class: 'page tag' }, [
    head,
    binding ? h('p', { class: 'muted' }, [fmt(t.tagBinding, { topic: binding.topic_name ?? binding.topic_id ?? '—' })]) : null,
    h('section', { class: 'card' }, [
      h('h3', {}, [fmt(t.tagWorks, { n: works.length })]),
      h('ul', { class: 'shelf' }, works.map((w) => {
        const card = w.card ? presentWorkCard(w.card, { locale }) : null
        const tag = w.tags.find((x) => x.tag_key === tagKey)
        const state = tag ? tag.state : 'pending'
        return h('li', {}, [
          h('a', { href: routeWork(w.work_id) }, [card?.title ?? w.work_id]),
          h('small', { class: 'muted' }, [card?.meta ?? w.work_id]),
          h('span', { class: `chip ${state}` }, [state === 'pending' ? app.m.communityState.pending : app.m.workTagState[state]]),
        ])
      })),
    ]),
    h('section', { class: 'card' }, [
      h('h3', {}, [t.tagLadder]),
      h('p', {}, [gap.current_text]),
      h('p', {}, [gap.next_text]),
      gap.pooling_text ? h('p', {}, [gap.pooling_text]) : null,
      h('p', { class: 'hint' }, [t.synthesisNote]),
    ]),
    h('section', { class: 'card' }, [
      h('h3', {}, [t.tagFrames]),
      frames.length === 0 ? h('p', { class: 'muted' }, [t.tagFramesNone]) : h('ul', { class: 'frames' }, frames.map((f) => h('li', {}, [
        h('strong', {}, [f.title]), ' · ', f.count_text, ' · ', f.view_text,
        f.blockers_text ? h('small', { class: 'muted' }, [f.blockers_text]) : null,
      ]))),
    ]),
    h('p', {}, [h('a', { href: '#/' }, [t.backHome])]),
  ])
}
