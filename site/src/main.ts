/**
 * 入口：hash 路由（`#/`、`#/w/<key>`、`#/t/<tag_key>`、`#/about`）、语言切换、导出加载。
 * 页面不发任何网络请求，除了读本站的导出文件，以及用户主动点「向 OpenAlex 查询 / 搜候选」。
 */
import { getMessages, type EvidenceWorkCard } from 'scholar-meta'
import type { App } from './app.js'
import { config, loadExport, type ExportState } from './data.js'
import { h } from './dom.js'
import { TEXT, type Locale } from './i18n.js'
import { aboutPage } from './pages/about.js'
import { homePage } from './pages/home.js'
import { tagPage } from './pages/tag.js'
import { workPage } from './pages/work.js'

const store = {
  get(k: string): string | null { try { return window.localStorage.getItem(k) } catch { return null } },
  set(k: string, v: string) { try { window.localStorage.setItem(k, v) } catch { /* 隐私模式：不记也能用 */ } },
}

const initialLocale = (): Locale => {
  const saved = store.get('smt-locale')
  if (saved === 'zh' || saved === 'en') return saved
  return (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

const root = document.getElementById('app')!
let exportState: ExportState = { status: 'loading' }
const cards = new Map<string, EvidenceWorkCard>()

const app: App = {
  locale: initialLocale(),
  get t() { return TEXT[app.locale] },
  get m() { return getMessages(app.locale) },
  get exportState() { return exportState },
  get data() { return exportState.status === 'ok' ? exportState.data : null },
  cards,
  navigate(hash) { if (location.hash === hash) render(); else location.hash = hash },
  rerender() { render() },
}

type Route = { name: 'home' } | { name: 'work'; key: string } | { name: 'tag'; key: string } | { name: 'about' }

function route(): Route {
  const hash = location.hash.replace(/^#/, '')
  const m = /^\/(w|t)\/(.+)$/.exec(hash)
  if (m) {
    let key = m[2]!
    try { key = decodeURIComponent(key) } catch { /* 原样 */ }
    return m[1] === 'w' ? { name: 'work', key } : { name: 'tag', key }
  }
  if (hash === '/about') return { name: 'about' }
  return { name: 'home' }
}

function header(): HTMLElement {
  const t = app.t
  const langs: Array<[Locale, string]> = [['zh', '中文'], ['en', 'English']]
  return h('header', { class: 'top' }, [
    h('div', { class: 'brand' }, [h('h1', {}, [h('a', { href: '#/' }, [t.siteTitle])]), h('p', { class: 'tagline' }, [t.tagline])]),
    h('nav', { class: 'nav', 'aria-label': 'Site' }, [
      h('a', { href: '#/', 'aria-current': route().name === 'home' ? 'page' : null }, [t.navHome]),
      h('a', { href: '#/about', 'aria-current': route().name === 'about' ? 'page' : null }, [t.navAbout]),
      h('a', { href: `https://github.com/${config.owner}/${config.repo}`, rel: 'noopener' }, ['GitHub']),
      h('span', { class: 'lang', role: 'group', 'aria-label': t.langLabel }, langs.map(([code, label]) => {
        const b = h('button', { type: 'button', 'aria-pressed': app.locale === code ? 'true' : 'false' }, [label])
        b.addEventListener('click', () => { app.locale = code; store.set('smt-locale', code); render() })
        return b
      })),
    ]),
  ])
}

function render() {
  const r = route()
  document.documentElement.lang = app.locale === 'zh' ? 'zh-CN' : 'en'
  document.title = app.t.siteTitle
  const body = r.name === 'home' ? homePage(app) : r.name === 'work' ? workPage(app, r.key) : r.name === 'tag' ? tagPage(app, r.key) : aboutPage(app)
  root.replaceChildren(header(), h('main', {}, [body]))
  window.scrollTo(0, 0)
}

window.addEventListener('hashchange', render)
render()
void loadExport(config.exportPath).then((s) => { exportState = s; render() })
