// 线上页面冒烟：用真的浏览器打开已发布的站点，看它读到的是不是线上那份导出，以及模型建议是不是标着「不计票」显示出来。
// 与 e2e.mjs 的区别：e2e 全程离线、用本机构建的页面；这里只读线上，不写任何东西，检查的是「发布出去的那一份」。
// 用法：node site/test/live.mjs <站点根地址>      例如 https://<账号>.github.io/<仓库>
//       或 GH_REPO=<账号>/<仓库> node site/test/live.mjs
// 线上连不上（清单取不到）⇒ 打印「这次没看」并以 0 退出——没看不等于通过，日志里写明；看了且有一项不过 ⇒ 退出码 1。
import { chromium } from 'playwright'

const repo = process.env.GH_REPO ?? ''
const base = (process.argv[2] ?? (repo.includes('/') ? `https://${repo.split('/')[0]}.github.io/${repo.split('/')[1]}` : '')).replace(/\/+$/, '')
if (!/^https?:\/\//.test(base)) { console.error('要一个站点根地址，或环境变量 GH_REPO=<账号>/<仓库>'); process.exit(2) }

const getJson = async (path) => {
  try {
    const res = await fetch(`${base}/${path}`, { cache: 'no-store' })
    return res.ok ? await res.json() : null
  } catch { return null }
}
const getText = async (path) => {
  try {
    const res = await fetch(`${base}/${path}`, { cache: 'no-store' })
    return res.ok ? await res.text() : null
  } catch { return null }
}

const manifest = await getJson('export/v1/manifest.json')
if (!manifest) {
  const note = `线上页面冒烟：${base} 的导出清单没取到，这次没看（不是通过）`
  console.log(process.env.GITHUB_ACTIONS ? `::warning title=线上页面这次没看::${note}` : `⚠️ ${note}`)
  process.exit(0)
}

const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`) }

const index = await getJson('export/v1/suggestions.json')
check('live: suggestions.json is published', !!index && Array.isArray(index.shards), index ? `${index.counts?.works} works · ${index.counts?.suggestions} suggestions` : 'missing')
// 挑一篇有贡献包建议（带置信度）的作品；没有就退而取第一篇有模型建议的
let pick = null
for (const sh of (index?.shards ?? []).slice(0, 8)) {
  const text = await getText(`export/v1/${sh.path}`)
  const rows = (text ?? '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const withConfidence = rows.find((r) => r.models?.some((m) => m.tags?.some((t) => typeof t.confidence === 'number')))
  const found = withConfidence ?? (pick ? null : rows[0] ?? null)
  if (found) pick = { ...found, shard_path: sh.path }
  if (withConfidence) break
}

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {})
const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 }, locale: 'zh-CN' })).newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))
try {
  await page.goto(`${base}/#/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForFunction(() => document.querySelectorAll('ul.shelf li').length > 0, null, { timeout: 60000 }).catch(() => {})
  const home = await page.locator('body').innerText()
  const shelf = await page.locator('ul.shelf li').count()
  // 首页显示的作品数就是线上清单里的那个数，并且书架上真的列出了作品——作品数来自清单，书架来自分片；分片没读到时书架是空的
  check('live: home shows the published work count and lists works from the shards', home.includes(String(manifest.counts.works)) && (manifest.counts.works === 0 || shelf > 0), `manifest.counts.works = ${manifest.counts.works} · 书架 ${shelf} 条`)
  if (pick) {
    await page.goto(`${base}/#/w/${encodeURIComponent(pick.work_id)}`)
    await page.waitForSelector('.ledger-suggestions button.chip.model', { timeout: 60000 }).catch(() => {})
    const ledger = await page.locator('.ledger-suggestions').innerText().catch(() => '')
    const body = await page.locator('body').innerText()
    const first = pick.models[0]
    check('live: work page shows ledger model suggestions', pick.models.every((m) => ledger.includes(m.id)) && ledger.includes(first.tags[0].label), `${pick.work_id} · ${pick.models.map((m) => `${m.id}（${m.tags.length}）`).join(', ')}`)
    check('live: they are labelled as model suggestions that do not count', body.includes('模型建议 · 不计票') && ledger.includes('不计票'))
    // 模型建议不计票：线上导出里这一篇的作品分片里，没有任何一个标签是凭模型建议「成立」的——
    // 只被模型建议过、没有人表态的标签，不许出现在这篇作品的 tags / pending 里，页面的「这篇现在被说成什么」里也不许有
    const hh = /suggestions\/([0-9a-f]+)\.jsonl$/.exec(pick.shard_path ?? '')?.[1] ?? null
    const workRows = hh ? ((await getText(`export/v1/works/${hh}.jsonl`)) ?? '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) : []
    const exported = workRows.find((w) => w.work_id === pick.work_id) ?? null
    const decided = new Set([...(exported?.tags ?? []).map((t) => t.tag_key), ...(exported?.pending ?? []).map((p) => String(p.subject).replace(/^tag:/, ''))])
    const modelOnly = pick.models.flatMap((m) => m.tags).filter((t) => !decided.has(t.tag_key))
    const said = (await page.locator('ul.said').allInnerTexts()).join('\n')
    check('live: tags suggested only by models are not statements', exported !== null && modelOnly.length > 0 && modelOnly.every((t) => !said.includes(t.label)), exported ? `${modelOnly.length} 个只有模型建议的标签，都不在「这篇现在被说成什么」里` : '线上作品分片里没找到这一篇')
  } else {
    check('live: a work with model suggestions exists', false, 'suggestions.json 里没有任何一篇')
  }
  check('live: no script errors', pageErrors.length === 0, pageErrors.join(' || ').slice(0, 400))
} finally {
  await browser.close()
}
const passed = results.filter(Boolean).length
console.log(`\n线上页面冒烟（${base}，清单生成于 ${manifest.generated_at}，提交 ${String(manifest.source_commit).slice(0, 7)}）：${passed}/${results.length} 通过`)
process.exit(passed === results.length ? 0 : 1)
