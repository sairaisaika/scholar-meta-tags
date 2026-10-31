/**
 * `#/about`：裁决参数（config/smt.config.json；导出的 manifest.policy 优先）、置信度旋钮表（`assessQuorum` 现算）、单侧 90% 说明、许可、隐私、荣誉制。
 */
import { DEFAULT_COMMUNITY_POLICY, assessQuorum, type EvidenceCommunityPolicy, type EvidenceQuorumRule } from 'scholar-meta'
import type { App } from '../app.js'
import { buildInfo, policyFile } from '../data.js'
import { h } from '../dom.js'
import { fmt } from '../i18n.js'

const ENGINE_URL = 'https://github.com/sairaisaika/scholar-meta-visulization'

export function aboutPage(app: App): HTMLElement {
  const { t, locale } = app
  const policy: EvidenceCommunityPolicy = app.data?.exp.manifest.policy ?? policyFromFile()
  const rule = policy.quorum
  const pct = (x: number) => `${Math.round(x * 100)}%`
  const cmp = (q: EvidenceQuorumRule) => (n: number, remove: number) => {
    const r = assessQuorum({ add: n - remove, remove }, q)
    const low = r.quorum.ci_low === null ? '—' : pct(r.quorum.ci_low)
    return `${app.m.communityState[r.state]} (${low})`
  }
  const row = cmp(rule)
  const knobRows = [2, 3, 4, 5, 6, 8, 10].map((n) => h('tr', {}, [h('th', { scope: 'row' }, [String(n)]), h('td', {}, [row(n, 0)]), h('td', {}, [row(n, 1)]), h('td', {}, [n > 2 ? row(n, 2) : '—'])]))

  return h('div', { class: 'page about' }, [
    h('h2', {}, [t.aboutTitle]),
    h('section', { class: 'card' }, [
      h('h3', {}, [t.aboutPolicy]), h('p', { class: 'hint' }, [t.aboutPolicyHint]),
      renderObject({ ...policyFile, ...(app.data ? { policy_in_export: app.data.exp.manifest.policy } : {}) }),
    ]),
    h('section', { class: 'card' }, [
      h('h3', {}, [t.aboutKnobs]),
      h('p', {}, [fmt(t.aboutKnobsHint, { conf: pct(rule.confidence), thr: pct(rule.threshold), md: rule.min_disputers })]),
      h('div', { class: 'scroll' }, [h('table', { class: 'knobs' }, [
        h('thead', {}, [h('tr', {}, [h('th', {}, [t.knobN]), h('th', {}, [t.knobAll]), h('th', {}, [t.knobOne]), h('th', {}, [t.knobTwo])])]),
        h('tbody', {}, knobRows),
      ])]),
      h('p', { class: 'hint' }, [`${t.knobLow}: Wilson · z = ${assessQuorum({ add: 1, remove: 0 }, rule).quorum.z.toFixed(3)}`]),
      h('p', {}, [t.aboutOneSided]),
    ]),
    h('section', { class: 'card' }, [h('h3', {}, [t.aboutHonour]), h('p', {}, [t.aboutHonourText])]),
    h('section', { class: 'card' }, [h('h3', {}, [t.aboutLicense]), h('p', {}, [t.aboutLicenseText])]),
    h('section', { class: 'card' }, [h('h3', {}, [t.aboutPrivacy]), h('p', {}, [t.aboutPrivacyText])]),
    h('section', { class: 'card' }, [
      h('h3', {}, [t.aboutEngine]),
      h('p', {}, [fmt(t.aboutEngineText, { engine: buildInfo.engine, at: buildInfo.at.slice(0, 10) }), ' ', h('a', { href: ENGINE_URL, rel: 'noopener' }, [t.engineLink])]),
      h('p', { class: 'muted' }, [locale === 'zh' ? '词表与配置随构建注入；导出在运行时读取。' : 'Vocabulary and config are injected at build time; the export is read at runtime.']),
    ]),
  ])
}

/** config/smt.config.json 的裁决部分（去掉 abuse / queue / export 三节就是 EvidenceCommunityPolicy）；缺省回引擎常量 */
function policyFromFile(): EvidenceCommunityPolicy {
  const p = policyFile as Partial<EvidenceCommunityPolicy>
  return {
    quorum: { ...DEFAULT_COMMUNITY_POLICY.quorum, ...(p.quorum ?? {}) },
    row: { ...DEFAULT_COMMUNITY_POLICY.row, ...(p.row ?? {}) },
    min_tier: { ...DEFAULT_COMMUNITY_POLICY.min_tier, ...(p.min_tier ?? {}) },
    model_min_confidence: p.model_min_confidence ?? DEFAULT_COMMUNITY_POLICY.model_min_confidence,
  }
}

function renderObject(o: unknown): HTMLElement {
  if (!o || typeof o !== 'object') return h('code', {}, [String(o)])
  return h('dl', { class: 'kv' }, Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => [
    h('dt', {}, [k]),
    h('dd', {}, [v && typeof v === 'object' && !Array.isArray(v) ? renderObject(v) : h('code', {}, [JSON.stringify(v)])]),
  ]))
}
