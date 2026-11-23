// 标注页的浏览器测试：三个根（空导出 / 夹具导出 / 没有导出），核对入口、DOI 流程、关于页、作品页表单、数字卡、
// 语言切换、盲复录、投票、标签页，并要求控制台没有脚本错误。全部离线：页面只读本机的静态文件，不连任何外部服务。
// 用法：pnpm site:test（先导出并构建页面）。可选 --shots <目录> 存截图；PW_CHROMIUM 指定浏览器可执行文件。
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, normalize } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const site = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(site, 'dist')
if (!existsSync(join(dist, 'index.html')) || !existsSync(join(dist, 'export', 'v1', 'manifest.json'))) {
  console.error('先运行 pnpm export && pnpm site:build（需要 site/dist 与其中的 export/v1）')
  process.exit(2)
}
const shotsAt = process.argv.indexOf('--shots')
const SHOTS = shotsAt >= 0 ? process.argv[shotsAt + 1] : null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
const shot = async (name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, name), fullPage: true }) }

// ── 三个根 ──
const tmp = mkdtempSync(join(tmpdir(), 'smt-site-'))
const baseManifest = JSON.parse(readFileSync(join(dist, 'export', 'v1', 'manifest.json'), 'utf8'))
const makeRoot = (name, manifest, shards) => {
  const root = join(tmp, name)
  cpSync(dist, root, { recursive: true })
  rmSync(join(root, 'export'), { recursive: true, force: true })
  if (manifest) {
    mkdirSync(join(root, 'export', 'v1', 'works'), { recursive: true })
    for (const [path, text] of Object.entries(shards)) writeFileSync(join(root, 'export', 'v1', path), text)
    writeFileSync(join(root, 'export', 'v1', 'manifest.json'), JSON.stringify(manifest, null, 2))
    for (const f of ['bindings.json', 'concepts.json', 'frames.json']) writeFileSync(join(root, 'export', 'v1', f), '[]')
  }
  return root
}
const dec = (o) => ({ work_id: 'doi:10.1234/fixture-a', subject: 'x', kind: 'tag', state: 'pending', decided_by: 'contributor', support: { contributor: { add: 1, remove: 0 } }, quorum: null, verification: null, re_extractions: 0, effective_id: 'a_1', value: null, issues: [], last_changed: '2026-10-01T00:00:00Z', reasons: [], ...o })
const quorum = (add, remove) => ({ n: add + remove, add, remove, unsure: 0, challengers: 0, challenged: false, share: add / (add + remove), ci_low: 0.65, ci_high: 1, z: 1.2816, threshold: 0.5, confidence: 0.8, min_independent: 2 })
const row = (id, outcome, value, lo, hi, n, p) => ({ row_id: id, input: { kind: 'row', context: { row_id: id, outcome, comparison: 'placebo', population: 'children', timepoint: '8 weeks', unit: 'participant', analysis: 'as_reported', locator: 'Table 2', kind: 'continuous' }, effect: { metric: 'smd', value, ci_low: lo, ci_high: hi, n, p_value: p, higher_is_better: false }, direction: 'favours' }, concept_ids: { outcome: 'c:outcome/adhd-symptoms', comparison: 'c:comparison/placebo', population: 'c:population/children', timepoint: 'c:timepoint/8-weeks' }, decision: dec({ subject: `row:${id}`, kind: 'row', state: 'accepted', quorum: quorum(2, 0), verification: 'double', re_extractions: 1, value: null }) })
const work = (key, wid, title, year, rows) => ({
  work_id: key, aliases: [wid],
  card: { id: wid, doi: key.slice(4), pmid: null, title, year, authors: ['A One', 'B Two', 'C Three', 'D Four'], venue: { id: 'S1', name: 'Journal of Fixtures', type: 'journal', is_oa: true, issn_l: null, publisher: null }, publication_type: 'article', topics: [{ id: 'openalex:T1', display_name: 'Attention Deficit Disorders' }], keywords: ['Methylphenidate', 'Children'], mesh: ['Methylphenidate'], abstract: null, language: 'en', cited_by_count: 12, is_open_access: true, oa_url: 'https://example.org/oa', is_retracted: false },
  tags: [
    { tag_key: 'adhd', label: 'ADHD', state: 'present', decided_by: 'contributor', support: { contributor: { add: 3, remove: 0 } }, last_changed: '2026-10-01T00:00:00Z', request_id: null, quorum: quorum(3, 0) },
    { tag_key: 'sleep', label: 'sleep', state: 'disputed', decided_by: 'contributor', support: { contributor: { add: 2, remove: 2 } }, last_changed: '2026-10-01T00:00:00Z', request_id: null },
  ],
  pending: [{ subject: 'tag:stimulants', decision: dec({ work_id: key, subject: 'tag:stimulants', kind: 'tag', state: 'pending', value: 'stimulants', quorum: quorum(1, 0) }) }],
  facets: { design: { value: 'rct', decision: dec({ work_id: key, subject: 'facet:design', kind: 'facet', state: 'accepted', value: 'rct', quorum: quorum(2, 0) }), locators: ['Methods para 1'] } },
  rows, unsure: 1, updated_at: '2026-10-02T00:00:00Z',
})
const works = [
  work('doi:10.1234/fixture-a', 'openalex:W1', 'A fixture trial of thing X in children', 2021, [row('o1', 'ADHD-RS total score', -0.42, -0.71, -0.13, 212, 0.004)]),
  work('doi:10.1234/fixture-b', 'openalex:W2', 'Second fixture trial of thing X', 2022, [row('o1', 'ADHD symptom severity', -0.3, -0.6, 0.0, 150, 0.05)]),
]
const shard = works.map((w) => JSON.stringify(w)).join('\n') + '\n'
const zero = { works: 0, assertions: 0, contributors: 0, accepted: 0, pending: 0, disputed: 0, frames: 0 }
const roots = {
  empty: makeRoot('empty', { ...baseManifest, shards: [], counts: zero }, {}),
  fixture: makeRoot('fixture', { ...baseManifest, shards: [{ path: 'works/ab.jsonl', bytes: shard.length, sha256: 'fixture', works: works.length }], counts: { ...zero, works: works.length, assertions: 9, contributors: 4 } }, { 'works/ab.jsonl': shard }),
  nodata: makeRoot('nodata', null, {}),
}

// ── 极简静态服务器（每个根一个，系统分配端口） ──
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jsonl': 'application/x-ndjson' }
const serve = (root) => new Promise((ok) => {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0])
    let p = join(root, normalize(path === '/' ? '/index.html' : path))
    try {
      if ((await stat(p)).isDirectory()) p = join(p, 'index.html')
      const body = await readFile(p)
      res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' })
      res.end(body)
    } catch { res.writeHead(404); res.end('not found') }
  }).listen(0, '127.0.0.1', () => ok({ server, url: `http://127.0.0.1:${server.address().port}` }))
})
const servers = {}
const url = {}
for (const [name, root] of Object.entries(roots)) { servers[name] = await serve(root); url[name] = servers[name].url }

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`) }
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {})
const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, locale: 'zh-CN' })
const page = await ctx.newPage()
const consoleErrors = []
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`[${m.type()}] ${m.text()}`) })
page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`))
page.on('requestfailed', (r) => consoleErrors.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`))
const text = async () => (await page.locator('body').innerText())

// 1 空导出（0 篇作品）
await page.goto(`${url.empty}/#/`)
await page.waitForSelector('.shelf-card')
await sleep(300)
let t = await text()
check('home renders', t.includes('打样书架') && t.includes('从本地 PDF 找 DOI'))
check('home: empty export shelf', t.includes('导出里还没有作品'), t.match(/0 篇.*/)?.[0] ?? '')
await shot('01-home.png')
await page.fill('input[data-focus="entry"]', '10.1000/xyz123')
await page.click('button[data-focus="go"]')
await sleep(200)
t = await text()
check('home: DOI → ask OpenAlex button', await page.locator('button[data-focus="ask-openalex"]').isVisible() && t.includes('向 OpenAlex 查询') && t.includes('IP'))
await shot('02-home-doi.png')
await page.fill('input[data-focus="entry"]', 'A randomised trial of something')
await page.click('button[data-focus="go"]')
await sleep(200)
check('home: title → search candidates button', await page.locator('button[data-focus="search"]').isVisible())
// about
await page.goto(`${url.empty}/#/about`)
await sleep(300)
t = await text()
check('about renders policy', t.includes('裁决参数') && t.includes('threshold') && t.includes('min_disputers') && t.includes('单侧 90%'))
await shot('03-about.png')
// 作品页（无名片）
await page.goto(`${url.empty}/#/w/doi%3A10.1000%2Fxyz123`)
await sleep(300)
t = await text()
check('work (no card) renders three questions', t.includes('它讲什么') && t.includes('它是什么研究') && t.includes('主结局偏向哪边') && t.includes('没有名片'))
check('work: design not preselected', (await page.locator('input[name="design"]:checked').count()) === 0)
check('work: submit empty', t.includes('还没有可提交的内容'))
await page.fill('input[data-focus="newtag"]', 'Insomnia CBT')
await sleep(100)
t = await text()
check('work: tag normalised live', t.includes('归一为「insomnia cbt」'))
await page.keyboard.press('Enter')
await page.check('input#design-rct')
await sleep(100)
t = await text()
check('work: design needs locator issue', t.includes('选了研究设计就要写原文位置'))
await page.fill('input[required][placeholder*="Methods"]', 'Methods para 2')
await page.fill('input[data-focus="outcome"]', 'ISI')
await page.check('input#direction-favours')
await page.fill('input[placeholder="比如：Methods 第 2 段 · Table 1 · p. 3"]:not([required])', 'Table 3')
await sleep(150)
t = await text()
check('work: preview says pending first', t.includes('你这条先是「待定」') && t.includes('现在能画到'))
check('work: form has no issues', t.includes('没有问题'), t.match(/表单检查[\s\S]{0,200}/)?.[0]?.replace(/\n/g, ' | '))
const payload = JSON.parse(await page.locator('textarea.json').inputValue())
check('work: payload shape', payload.form === 'annotate/1' && payload.work_id === 'doi:10.1000/xyz123' && payload.items.length === 3 && payload.items.some((i) => i.kind === 'row' && i.payload.context.row_id === 'o1' && i.payload.direction === 'favours'), JSON.stringify(payload.items.map((i) => `${i.kind}/${i.op}/${i.subject}`)))
// 数字卡
await page.click('details.numbers summary')
await page.selectOption('details.numbers select', 'smd')
const nums = page.locator('details.numbers input[inputmode="decimal"]')
await nums.nth(0).fill('-0.5'); await nums.nth(1).fill('-0.9'); await nums.nth(2).fill('-0.1'); await nums.nth(3).fill('120'); await nums.nth(4).fill('0.01')
await page.check('input#hib-false')
const ctxInputs = page.locator('details.numbers .grid3').nth(1).locator('input')
await ctxInputs.nth(0).fill('placebo'); await ctxInputs.nth(2).fill('8 weeks')
await sleep(200)
t = await text()
const payload2 = JSON.parse(await page.locator('textarea.json').inputValue())
const rowItem = payload2.items.find((i) => i.kind === 'row')
check('work: numbers → effect in payload', rowItem?.payload.effect?.metric === 'smd' && rowItem.payload.effect.value === -0.5 && rowItem.payload.context.kind === 'continuous' && rowItem.payload.context.comparison === 'placebo')
check('work: frame preview appears', t.includes('哪个 frame 变了') && !t.includes('没有数字行'), t.match(/哪个 frame 变了[\s\S]{0,300}/)?.[0]?.replace(/\n/g, ' | '))
check('work: submit enabled', !(await page.locator('.submit button.primary').isDisabled()))
await shot('04-work-form.png')
// 英文
await page.click('.lang button:has-text("English")')
await sleep(200)
t = await text()
check('locale switch keeps draft', t.includes('Three questions') && t.includes('Insomnia CBT') && t.includes('Your submission starts as'))
await shot('05-work-en.png')
await page.click('.lang button:has-text("中文")')

// 2 夹具导出
await page.goto(`${url.fixture}/#/`)
await sleep(400)
t = await text()
check('fixture: shelf lists works', t.includes('A fixture trial') && t.includes('ADHD'))
await shot('06-home-fixture.png')
await page.goto(`${url.fixture}/#/w/doi%3A10.1234%2Ffixture-a`)
await sleep(400)
t = await text()
check('fixture work: card + status', t.includes('Journal of Fixtures') && t.includes('这篇现在被说成什么') && t.includes('ADHD') && t.includes('争议') && t.includes('待定') && t.includes('Table 2'))
check('fixture work: model suggestions separate', t.includes('建议 · 模型') && t.includes('Attention Deficit Disorders'))
// 盲复录
await page.click('ul.said button:has-text("复录")')
await sleep(100)
t = await text()
check('re-extract: original hidden by default', t.includes('盲复录第 o1 行') && !t.includes('你看过原值'))
const re = page.locator('.reextract')
await re.locator('select').nth(0).selectOption('smd')
const rin = re.locator('input[inputmode="decimal"]')
await rin.nth(0).fill('-0.42'); await rin.nth(1).fill('-0.71'); await rin.nth(2).fill('-0.13'); await rin.nth(3).fill('212'); await rin.nth(4).fill('0.004')
await re.locator('select').nth(1).selectOption('false')
await re.locator('select').nth(2).selectOption('favours')
await re.locator('button:has-text("比对")').click()
await sleep(150)
t = await text()
check('re-extract: match → endorse', t.includes('一致：将作为「认可」提交'))
let p3 = JSON.parse(await page.locator('textarea.json').inputValue())
let rev = p3.items.find((i) => i.kind === 'review')
check('re-extract payload', rev?.op === 'endorse' && rev.payload.re_extraction?.effect?.value === -0.42 && rev.payload.peeked === false, JSON.stringify(rev))
await rin.nth(0).fill('-0.5')
await re.locator('button:has-text("显示原值")').click()
await re.locator('button:has-text("比对")').click()
await sleep(150)
t = await text()
p3 = JSON.parse(await page.locator('textarea.json').inputValue())
rev = p3.items.find((i) => i.kind === 'review')
check('re-extract: mismatch + peeked → dispute', t.includes('不一致') && t.includes('你看过原值') && rev?.op === 'dispute' && rev.payload.peeked === true && rev.payload.reason.includes('value'), rev?.payload.reason)
// 投票
await page.locator('ul.said li').first().locator('button:has-text("不认可")').click()
await sleep(100)
t = await text()
check('vote dispute needs reason', t.includes('不认可的理由'))
await shot('07-work-fixture.png')
// 标签页
await page.goto(`${url.fixture}/#/t/adhd`)
await sleep(300)
t = await text()
check('tag page', t.includes('标签「ADHD」') && t.includes('2 篇作品') && t.includes('现在能画到') && t.includes('frame'), t.match(/这批作品能画到哪一级[\s\S]{0,300}/)?.[0]?.replace(/\n/g, ' | '))
await shot('08-tag.png')

// 3 无导出
const errsBefore = consoleErrors.length
await page.goto(`${url.nodata}/#/`)
await sleep(400)
t = await text()
check('no export: empty shelf, no crash', t.includes('本站还没有发布导出'))
await shot('09-home-noexport.png')
const noexportErrs = consoleErrors.slice(errsBefore)

const realErrors = consoleErrors.filter((e) => !/Failed to load resource.*404/.test(e))
check('console: no script errors', realErrors.length === 0, realErrors.join(' || ').slice(0, 800))
console.log(`console messages: ${consoleErrors.length}; no-export root: ${noexportErrs.length}`)
await browser.close()
for (const s of Object.values(servers)) s.server.close()
rmSync(tmp, { recursive: true, force: true })
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`)
process.exit(results.every((r) => r.ok) ? 0 : 1)
