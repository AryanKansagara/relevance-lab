import { readFileSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'
import { expect, STORAGE_KEY, test } from './fixtures.ts'
import type { Locator, Page } from '@playwright/test'

// ---- independent reference maths (no imports from src/) --------------------------------

const K1 = 1.2
const B = 0.75
const tokens = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) ?? []
type Doc = Record<string, string>

/** Lucene BM25 for one term in one field, including the (k1 + 1) that Elasticsearch folds into boost. */
function bm25(docs: Doc[], id: string, field: string, term: string, boost = 1, k1 = K1, b = B) {
  const withField = docs.filter((d) => tokens(d[field] ?? '').length)
  const N = withField.length
  const n = withField.filter((d) => tokens(d[field]).includes(term)).length
  const avgdl = withField.reduce((a, d) => a + tokens(d[field]).length, 0) / N
  const doc = docs.find((d) => d.id === id)!
  const t = tokens(doc[field] ?? '')
  const freq = t.filter((x) => x === term).length
  if (!freq) return 0
  const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
  return boost * (k1 + 1) * idf * (freq / (freq + k1 * (1 - b + (b * t.length) / avgdl)))
}

/** nDCG@k, MRR, P@k worked by hand from a ranked id list and graded judgments. */
function handMetrics(ranked: string[], judged: Record<string, number>, k: number) {
  const dcg = (gains: number[]) => gains.slice(0, k).reduce((a, g, i) => a + (2 ** g - 1) / Math.log2(i + 2), 0)
  const ideal = dcg(Object.values(judged).sort((x, y) => y - x))
  const first = ranked.findIndex((id) => (judged[id] ?? 0) > 0)
  return {
    ndcg: dcg(ranked.map((id) => judged[id] ?? 0)) / ideal,
    mrr: first < 0 ? 0 : 1 / (first + 1),
    precision: ranked.slice(0, k).filter((id) => (judged[id] ?? 0) > 0).length / k,
  }
}

// ---- page helpers ----------------------------------------------------------------------

const slider = (page: Page, label: string) =>
  page.locator('label.slider').filter({ has: page.locator('.slider-head > span:first-child').getByText(label, { exact: true }) }).locator('input[type=range]')
const metricValue = (page: Page, label: string) => page.locator('.metric', { hasText: label }).locator('b')
const resultRows = (page: Page) => page.locator('.tune-main section', { hasText: 'Results and judgments' }).locator('tbody tr')
const miniDocs = (page: Page) => page.getByLabel('Documents')
const miniQuery = (page: Page) => page.getByPlaceholder('Type a query')
const miniResults = (page: Page) => page.locator('.mini-results li')

async function miniSearch(page: Page, docs: unknown, query: string) {
  await page.goto('/app?tab=mini')
  await miniDocs(page).fill(typeof docs === 'string' ? docs : JSON.stringify(docs))
  await miniQuery(page).fill(query)
}

const rowIds = async (rows: Locator) => (await rows.locator('small').allInnerTexts()).map((s) => s.trim())
const titles = async (page: Page) => (await miniResults(page).locator('.hit-title').allInnerTexts()).map((s) => s.trim())
const scores = async (page: Page) => (await miniResults(page).locator('.hit-score').allInnerTexts()).map(Number)
const approx = (got: number[], want: number[], digits = 2) => {
  expect(got).toHaveLength(want.length)
  got.forEach((g, i) => expect(g).toBeCloseTo(want[i], digits))
}

async function openDialog(page: Page) {
  await page.getByRole('button', { name: 'Paste or upload' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
}

async function waitForSaved(page: Page, needle: string) {
  await expect.poll(() => page.evaluate((k) => localStorage.getItem(k) ?? '', STORAGE_KEY)).toContain(needle)
}

// ---- sample, rankings and metrics ------------------------------------------------------

test.describe('sample workspace', () => {
  test('ecommerce sample shows the returned ranking and metrics that match a hand-worked example', async ({ page }) => {
    await page.goto('/app?sample=ecommerce&tab=tune')
    await expect(page.locator('.pill')).toHaveText('10 hits of 2,184')
    await expect(page.locator('.sanity')).toContainText('Replay matches ES')

    const rows = resultRows(page)
    const ranked = await rowIds(rows)
    expect(ranked.slice(0, 5)).toEqual(['sku-1093', 'sku-4471', 'sku-7730', 'sku-6601', 'sku-2218'])

    // Judgments from the sample: sku-6601 relevant (1) at rank 4, sku-2218 highly relevant (2) at rank 5.
    // Ideal list is 2,2,2,1,1,1. DCG@5 = 1/log2(5) + 3/log2(6) = 1.5913, IDCG@5 = 7.2104, so nDCG@5 = 0.2207.
    const judged = { 'sku-2218': 2, 'sku-2240': 2, 'sku-3302': 2, 'sku-6601': 1, 'sku-8842': 1, 'sku-9015': 1 }
    const want = handMetrics(ranked, judged, 5)
    expect(want.ndcg).toBeCloseTo(0.2207, 4)
    expect(want.mrr).toBe(0.25)
    expect(want.precision).toBe(0.4)
    await expect(metricValue(page, 'nDCG@5')).toHaveText('0.221')
    await expect(metricValue(page, 'MRR')).toHaveText('0.250')
    await expect(metricValue(page, 'P@5')).toHaveText('0.400')
    await expect(page.locator('.metric-d').first()).toHaveText('no change')

    // The pressed buttons agree with the judgments above.
    await expect(rows.nth(3).getByRole('button', { name: 'Rel' })).toHaveAttribute('aria-pressed', 'true')
    await expect(rows.nth(4).getByRole('button', { name: 'High' })).toHaveAttribute('aria-pressed', 'true')
    await expect(rows.nth(0).getByRole('button', { name: 'No' })).toHaveAttribute('aria-pressed', 'true')
  })

  test('the Explain tab names the winner and its score', async ({ page }) => {
    await page.goto('/app?sample=ecommerce')
    await expect(page.getByRole('tab', { name: 'Explain' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.hit').first()).toContainText('Sony 3.5mm Audio Cable')
    await expect(page.locator('.hit').first().locator('.hit-score')).toHaveText('173.5')
    await expect(page.locator('.verdict h2')).toBeVisible()
    await page.locator('.hit', { hasText: 'Sony WH-1000XM6' }).click()
    await expect(page.locator('.verdict .eyebrow')).toHaveText('Verdict for rank 5')
  })

  test('changing a ranking parameter reorders results and moves the metrics', async ({ page }) => {
    await page.goto('/app?sample=ecommerce&tab=tune')
    await expect(metricValue(page, 'nDCG@5')).toHaveText('0.221')

    // brand^10 is what puts cables on top. Drop it to 1 and the headphones rise.
    await slider(page, 'brand').fill('1')
    await expect(page.getByRole('button', { name: 'Reset' })).toBeEnabled()
    const rows = resultRows(page)
    expect((await rowIds(rows)).slice(0, 5)).toEqual(['sku-2218', 'sku-2240', 'sku-5120', 'sku-3302', 'sku-9015'])
    // Replayed score for the new leader is lower than what ES returned (152.1).
    await expect(rows.first().locator('td.num').nth(2)).toHaveText('152.1')
    await expect(rows.first().locator('td.num').nth(3)).toHaveText('101.3')

    // Hand-worked: gains 2,2,0,2,1 against ideal 2,2,2,1,1,1 gives nDCG@5 = 6.5717 / 7.2104 = 0.9114.
    await expect(metricValue(page, 'nDCG@5')).toHaveText('0.911')
    await expect(metricValue(page, 'MRR')).toHaveText('1.000')
    await expect(metricValue(page, 'P@5')).toHaveText('0.800')
    await expect(page.locator('.metric-d').first()).toContainText('▲ 0.691 from 0.221')
    await expect(page.locator('.copyblock pre')).toContainText('"brand",')
    await expect(page.locator('.copyblock pre')).not.toContainText('brand^10')

    await page.getByRole('button', { name: 'Reset' }).click()
    await expect(metricValue(page, 'nDCG@5')).toHaveText('0.221')
    expect((await rowIds(rows)).slice(0, 2)).toEqual(['sku-1093', 'sku-4471'])
  })

  test('fitting knobs to the sample judgments reaches the ideal ranking and reports it truthfully', async ({ page }) => {
    await page.goto('/app?sample=ecommerce&tab=tune')
    await page.getByRole('button', { name: 'Fit knobs to my judgments' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Fitted' })).toContainText('nDCG@5 0.221 to 1.000')
    await expect(metricValue(page, 'nDCG@5')).toHaveText('1.000')
    await expect(page.locator('.sanity')).toContainText('Replay matches ES')
  })

  test('the hybrid sample replays RRF by hand: score = sum of 1 / (rank_constant + rank)', async ({ page }) => {
    await page.goto('/app?sample=docs-rrf&tab=hybrid')
    const rows = page.locator('section', { hasText: 'Fused results' }).locator('tbody tr')
    await expect(rows.first()).toBeVisible()
    // Each cell reads "#rank +contribution"; the fused score must equal the sum of contributions.
    for (const row of await rows.all()) {
      const text = await row.innerText()
      const parts = [...text.matchAll(/#(\d+)\s*\+(\d\.\d+)/g)].map((m) => ({ rank: +m[1], c: +m[2] }))
      for (const p of parts) expect(p.c).toBeCloseTo(1 / (60 + p.rank), 4)
      const score = Number(await row.locator('td.num.strong').last().innerText())
      expect(score).toBeCloseTo(parts.reduce((a, p) => a + p.c, 0), 4)
    }
    // Lowering rank_constant is a visible change in the contributions.
    await slider(page, 'rank_constant').fill('10')
    await expect(rows.first()).toContainText(/\+0\.0[5-9]\d\d/)
  })
})

// ---- mini index: documents and queries imported by the user -----------------------------

test.describe('mini index', () => {
  const docs: Doc[] = [
    { id: 'd1', text: 'alpha beta' },
    { id: 'd2', text: 'alpha' },
    { id: 'd3', text: 'gamma delta epsilon' },
  ]

  test('ranks pasted documents with BM25 that matches a hand-worked example', async ({ page }) => {
    await miniSearch(page, docs, 'alpha')
    // N = 3, n = 2, avgdl = 2. idf = ln(1.6) = 0.4700. d2: tf = 1 / 1.75 -> 2.2 * 0.4700 / 1.75 = 0.5909.
    // d1: tf = 1 / 2.2 -> 0.4700. d3 does not contain the term and must not appear.
    await expect(page.getByText('2 matches.')).toBeVisible()
    expect(await titles(page)).toEqual(['d2', 'd1'])
    approx(await scores(page), [0.5909, 0.47])
    expect(bm25(docs, 'd2', 'text', 'alpha')).toBeCloseTo(0.5909, 4)
    expect(bm25(docs, 'd1', 'text', 'alpha')).toBeCloseTo(0.47, 4)
    await expect(page.getByText('3 docs · 1 text fields')).toBeVisible()
  })

  test('boosts and the multi-field ranking follow the reference formula as sliders move', async ({ page }) => {
    const fieldDocs: Doc[] = [
      { id: 'd1', title: 'alpha', body: 'zeta eta theta iota' },
      { id: 'd2', title: 'omega psi', body: 'alpha beta' },
    ]
    await miniSearch(page, fieldDocs, 'alpha beta')

    await slider(page, 'title boost').fill('1')
    const bodyScore = bm25(fieldDocs, 'd2', 'body', 'alpha') + bm25(fieldDocs, 'd2', 'body', 'beta')
    const titleScore = (boost: number) => bm25(fieldDocs, 'd1', 'title', 'alpha', boost)
    expect(await titles(page)).toEqual(['omega psi', 'alpha'])
    approx(await scores(page), [bodyScore, titleScore(1)])

    await slider(page, 'title boost').fill('4')
    expect(await titles(page)).toEqual(['alpha', 'omega psi'])
    approx(await scores(page), [titleScore(4), bodyScore])

    // Lengthening nothing, just killing length normalization and saturation: scores follow the formula again.
    await slider(page, 'b').fill('0')
    const flat = bm25(fieldDocs, 'd1', 'title', 'alpha', 4, K1, 0)
    approx(await scores(page), [flat, bm25(fieldDocs, 'd2', 'body', 'alpha', 1, K1, 0) + bm25(fieldDocs, 'd2', 'body', 'beta', 1, K1, 0)])
  })

  test('uploads documents from a file and sends the results to the lab with no judgments', async ({ page }) => {
    await page.goto('/app?tab=mini')
    await page.locator('.mini input[type=file]').setInputFiles({ name: 'docs.ndjson', mimeType: 'text/plain', buffer: Buffer.from(docs.map((d) => JSON.stringify(d)).join('\n')) })
    await miniQuery(page).fill('alpha')
    expect(await titles(page)).toEqual(['d2', 'd1'])

    await page.getByRole('button', { name: 'Open these results in the lab' }).click()
    await expect(page.getByRole('tab', { name: 'Explain' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.pill')).toHaveText('2 hits of 2')
    await page.getByRole('tab', { name: 'Tune' }).click()
    expect(await rowIds(resultRows(page))).toEqual(['d2', 'd1'])
    // The replay of the generated explain output reproduces the scores it came from.
    await expect(page.locator('.sanity')).toContainText('Replay matches ES')
  })

  test('empty, malformed and non-object documents give a message and no results', async ({ page }) => {
    await page.goto('/app?tab=mini')
    for (const [text, message] of [
      ['', /Paste a JSON array of documents/],
      ['[{"id":"a","text":"alpha"},', /Could not parse as JSON or NDJSON/],
      ['{"id":"a", text: nope}', /Could not parse as JSON or NDJSON/],
      ['[1, 2, 3]', /Every document must be a JSON object/],
      ['[["nested"]]', /Every document must be a JSON object/],
    ] as const) {
      await miniDocs(page).fill(text)
      await miniQuery(page).fill('alpha')
      await expect(page.getByRole('alert')).toContainText(message)
      await expect(miniResults(page)).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Open these results in the lab' })).toHaveCount(0)
    }
  })

  test('a query that matches nothing says so instead of returning a ranking', async ({ page }) => {
    await miniSearch(page, docs, 'zzzz')
    await expect(page.getByText('No document matches those tokens')).toBeVisible()
    await expect(miniResults(page)).toHaveCount(0)
    await miniQuery(page).fill('   ')
    await expect(page.getByText('Type a query to rank these documents.')).toBeVisible()
  })
})

// ---- duplicate document ids -------------------------------------------------------------

test.describe('duplicate document ids', () => {
  const docs: Doc[] = [
    { id: 'd1', text: 'alpha' },
    { id: 'd2', text: 'alpha beta gamma' },
    { id: 'd3', text: 'alpha beta' },
  ]

  test('the mini index refuses two documents with one id, names them, and shows no ranking', async ({ page }) => {
    await miniSearch(page, [{ id: 'a', title: 'first', text: 'alpha' }, { id: 'a', title: 'second', text: 'alpha beta gamma' }], 'alpha')
    await expect(page.getByRole('alert')).toContainText('Documents 1 and 2 have the same id "a"')
    await expect(page.getByRole('alert')).toContainText('Nothing was indexed')
    await expect(miniResults(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Open these results in the lab' })).toHaveCount(0)
    // Fixing the ids brings the ranking back.
    await miniDocs(page).fill(JSON.stringify([{ id: 'a', title: 'first', text: 'alpha' }, { id: 'b', title: 'second', text: 'alpha beta gamma' }]))
    await expect(page.getByRole('alert')).toHaveCount(0)
    expect(await titles(page)).toEqual(['first', 'second'])
  })

  /** Real search response from the mini index, with the hit fields edited by `edit`, pasted as a file. */
  async function openEdited(page: Page, edit: (hits: Record<string, unknown>[]) => void) {
    await miniSearch(page, docs, 'alpha')
    await page.getByRole('button', { name: 'Open these results in the lab' }).click()
    await expect.poll(() => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}').response?.includes('_explanation') ?? false, STORAGE_KEY)).toBe(true)
    const response = JSON.parse(await page.evaluate((k) => JSON.parse(localStorage.getItem(k)!).response as string, STORAGE_KEY))
    edit(response.hits.hits)
    await openDialog(page)
    await page.getByRole('dialog').locator('input[type=file]').setInputFiles({ name: 'two-indices.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(response)) })
    await page.getByRole('button', { name: 'Analyze' }).click()
  }

  test('hits that share an _id across indices are labelled and judged separately, and nDCG stays at or below 1', async ({ page }) => {
    await openEdited(page, (hits) => {
      hits[0]._index = 'logs-a'
      hits[0]._id = 'a'
      hits[1]._index = 'logs-b'
      hits[1]._id = 'a'
    })
    await expect(page.getByRole('dialog')).toBeHidden()
    await expect(page.locator('.pill')).toHaveText('3 hits of 3')
    await expect(page.locator('.note')).toContainText('Hits from different indices share an _id ("a")')
    await expect(page.locator('.note')).toContainText('judged separately')
    await page.getByRole('tab', { name: 'Tune' }).click()
    const rows = resultRows(page)
    expect(await rowIds(rows)).toEqual(['logs-a/a', 'logs-b/a', 'd2'])

    // Judge only the first. With one judged document the ideal list is that document alone, so nDCG is exactly 1.
    // (When both rows shared the id, it was counted twice: 1 + 1/log2(3) = 1.631.)
    await rows.nth(0).getByRole('button', { name: 'Rel' }).click()
    await expect(rows.nth(0).getByRole('button', { name: 'Rel' })).toHaveAttribute('aria-pressed', 'true')
    await expect(rows.nth(1).getByRole('button', { name: 'Rel' })).toHaveAttribute('aria-pressed', 'false')
    await expect(metricValue(page, 'nDCG@5')).toHaveText('1.000')
    await expect(metricValue(page, 'MRR')).toHaveText('1.000')
    await expect(metricValue(page, 'P@5')).toHaveText('0.200')

    // Judging the second counts it once: gains 1,1,0 against ideal 1,1.
    await rows.nth(1).getByRole('button', { name: 'Rel' }).click()
    await expect(metricValue(page, 'nDCG@5')).toHaveText('1.000')
    await expect(metricValue(page, 'P@5')).toHaveText('0.400')

    // Now mark the first No and the third (d2) Rel. Judged: logs-b/a and d2. Gains 0,1,1 against ideal 1,1:
    // DCG = 1/log2(3) + 1/log2(4) = 1.1309, IDCG = 1 + 1/log2(3) = 1.6309, so nDCG = 0.6934.
    await rows.nth(0).getByRole('button', { name: 'No' }).click()
    await rows.nth(2).getByRole('button', { name: 'Rel' }).click()
    await expect(metricValue(page, 'nDCG@5')).toHaveText('0.693')
  })

  test('hits with the same index and _id are refused with their positions and nothing is scored', async ({ page }) => {
    await openEdited(page, (hits) => {
      hits[0]._index = 'logs-a'
      hits[0]._id = 'a'
      hits[1]._index = 'logs-a'
      hits[1]._id = 'a'
    })
    await expect(page.getByRole('dialog')).toBeHidden()
    await expect(page.getByRole('alert').filter({ hasText: 'Hits 1 and 2 have the same _id "a" in index "logs-a"' })).toBeVisible()
    await expect(page.locator('.err-card')).toContainText('Nothing was guessed')
    await expect(page.locator('.pill')).toHaveCount(0)
    await expect(page.locator('.metric')).toHaveCount(0)
    await expect(page.getByRole('tab', { name: 'Tune' })).toBeDisabled()
  })
})

// ---- judgments: never invented ----------------------------------------------------------

test.describe('judgments', () => {
  async function unjudgedResults(page: Page) {
    await miniSearch(page, [
      { id: 'd1', text: 'alpha beta' },
      { id: 'd2', text: 'alpha' },
      { id: 'd3', text: 'alpha gamma delta' },
    ], 'alpha')
    await page.getByRole('button', { name: 'Open these results in the lab' }).click()
    await page.getByRole('tab', { name: 'Tune' }).click()
    return resultRows(page)
  }

  test('a query without judgments shows no nDCG, MRR or precision, not zero and not one', async ({ page }) => {
    const rows = await unjudgedResults(page)
    await expect(rows).toHaveCount(3)
    await expect(page.getByText('Mark results below to light up nDCG, MRR and precision.')).toBeVisible()
    await expect(page.locator('.metric')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Fit knobs to my judgments' })).toHaveCount(0)

    // Explicitly marking everything "No" is still not a judged query: nothing relevant to measure against.
    for (const row of await rows.all()) await row.getByRole('button', { name: 'No' }).click()
    await expect(page.locator('.metric')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Fit knobs to my judgments' })).toHaveCount(0)
  })

  test('marking results produces metrics that match a hand calculation, and removing them removes the metrics', async ({ page }) => {
    const rows = await unjudgedResults(page)
    const ranked = await rowIds(rows)
    expect(ranked).toEqual(['d2', 'd1', 'd3'])

    await rows.nth(1).getByRole('button', { name: 'Rel' }).click()
    // One relevant doc (d1, rank 2): nDCG@5 = (1/log2(3)) / 1 = 0.631, MRR = 0.5, P@5 = 1/5.
    const want = handMetrics(ranked, { d1: 1 }, 5)
    expect(want.ndcg).toBeCloseTo(0.6309, 4)
    await expect(metricValue(page, 'nDCG@5')).toHaveText('0.631')
    await expect(metricValue(page, 'MRR')).toHaveText('0.500')
    await expect(metricValue(page, 'P@5')).toHaveText('0.200')

    await rows.nth(0).getByRole('button', { name: 'High' }).click()
    const both = handMetrics(ranked, { d1: 1, d2: 2 }, 3)
    await page.locator('.inline-select select').selectOption('3')
    await expect(metricValue(page, 'nDCG@3')).toHaveText(both.ndcg.toFixed(3))
    await expect(metricValue(page, 'MRR')).toHaveText('1.000')

    await rows.nth(0).getByRole('button', { name: 'No' }).click()
    await rows.nth(1).getByRole('button', { name: 'No' }).click()
    await expect(page.locator('.metric')).toHaveCount(0)
  })

  test('loading a different response drops the old judgments instead of scoring against them', async ({ page }) => {
    await page.goto('/app?sample=ecommerce&tab=tune')
    await expect(metricValue(page, 'nDCG@5')).toHaveText('0.221')
    await page.getByRole('tab', { name: 'Mini index' }).click()
    await miniQuery(page).fill('search relevance')
    await page.getByRole('button', { name: 'Open these results in the lab' }).click()
    await page.getByRole('tab', { name: 'Tune' }).click()
    await expect(page.getByText('Mark results below to light up nDCG, MRR and precision.')).toBeVisible()
    await expect(page.locator('.metric')).toHaveCount(0)
  })

  test('the hybrid debugger shows no nDCG rows until something is judged', async ({ page }) => {
    await page.goto('/app?sample=docs-rrf&tab=hybrid')
    await expect(page.locator('.compare-metrics')).toBeVisible()
    await page.getByRole('tab', { name: 'Mini index' }).click()
    await page.getByRole('button', { name: 'Open these results in the lab' }).click()
    await page.getByRole('tab', { name: 'Hybrid' }).click()
    await expect(page.locator('.compare-metrics')).toHaveCount(0)
  })
})

// ---- importing responses ----------------------------------------------------------------

test.describe('importing responses', () => {
  const fixture = (name: string) => readFileSync(new URL(`../src/engine/fixtures/${name}`, import.meta.url))
  const upload = async (page: Page, name: string, buffer: Buffer) => {
    await openDialog(page)
    await page.getByRole('dialog').locator('input[type=file]').setInputFiles({ name, mimeType: 'application/json', buffer })
    await page.getByRole('button', { name: 'Analyze' }).click()
  }

  test('uploads a real _explain response from a file and explains it', async ({ page }) => {
    await page.goto('/app')
    await expect(page.getByRole('heading', { name: /Show me a response with/ })).toBeVisible()
    await upload(page, 'explain.json', fixture('es-explain-api-8.json'))
    await expect(page.getByRole('dialog')).toBeHidden()
    await expect(page.locator('.pill')).toHaveText('1 hits')
    await expect(page.locator('.verdict h2')).toContainText('message')
    await expect(page.locator('.tbl').first()).toContainText('message:elasticsearch')
    // Real BM25 numbers survive: idf 1.3862944 shown to two places.
    await expect(page.locator('.tbl').first()).toContainText('1.39')
    await expect(page.locator('.err-card')).toHaveCount(0)
  })

  test('uploads a real RRF search response and opens the hybrid debugger', async ({ page }) => {
    await page.goto('/app')
    await upload(page, 'rrf.json', fixture('es-rrf-explain.json'))
    await expect(page.locator('.pill')).toContainText('hits')
    await page.getByRole('tab', { name: 'Hybrid' }).click()
    await expect(page.getByRole('heading', { name: 'RRF flow' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Fused results' })).toBeVisible()
  })

  const bad: [string, string | Buffer, RegExp][] = [
    ['not JSON', 'this is not json', /Not valid JSON/],
    ['truncated JSON', fixture('es-rrf-explain.json').subarray(0, 700), /Not valid JSON/],
    ['an empty array', '[]', /The array is empty/],
    ['a JSON string', '"hello"', /Expected a JSON object/],
    ['an unrelated object', '{"hello":"world"}', /\S/],
    ['an ES error body', '{"error":{"type":"parsing_exception","reason":"bad query"},"status":400}', /Elasticsearch error response/],
    ['a search with zero hits', '{"hits":{"total":{"value":0},"hits":[]}}', /zero hits/],
    ['a search without explain', '{"hits":{"hits":[{"_id":"1","_score":1.2,"_source":{"title":"x"}}]}}', /has no _explanation/],
  ]
  for (const [name, content, message] of bad) {
    test(`${name} gives a useful message and no scores`, async ({ page }) => {
      await page.goto('/app?sample=ecommerce')
      await upload(page, 'bad.json', Buffer.from(content))
      await expect(page.getByRole('dialog')).toBeHidden()
      await expect(page.getByRole('alert').filter({ hasText: message })).toBeVisible()
      await expect(page.locator('.err-card')).toContainText('Nothing was guessed from this input')
      // The previous sample's data is gone, nothing is scored, and the analysis tabs are unavailable.
      await expect(page.locator('.pill')).toHaveCount(0)
      await expect(page.locator('.hit')).toHaveCount(0)
      await expect(page.locator('.metric')).toHaveCount(0)
      await expect(page.getByRole('tab', { name: 'Tune' })).toBeDisabled()
      await expect(page.getByRole('tab', { name: 'Compare' })).toBeDisabled()
    })
  }

  test('an empty file leaves the lab in its empty state with no metrics', async ({ page }) => {
    await page.goto('/app?sample=ecommerce')
    await upload(page, 'empty.json', Buffer.alloc(0))
    await expect(page.locator('.hit')).toHaveCount(0)
    await expect(page.locator('.metric')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: /Show me a response with/ })).toBeVisible()
  })

  test('a bad optional input is reported and nothing is committed', async ({ page }) => {
    await page.goto('/app')
    await openDialog(page)
    await page.getByRole('dialog').locator('input[type=file]').setInputFiles({ name: 'explain.json', mimeType: 'application/json', buffer: fixture('es-explain-api-8.json') })
    await page.getByLabel(/Original query body/).fill('{"query": ')
    await page.getByRole('button', { name: 'Analyze' }).click()
    await expect(page.getByRole('alert')).toContainText('Optional input problem')
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.locator('.pill')).toHaveCount(0)
  })
})

// ---- persistence ------------------------------------------------------------------------

test.describe('persistence', () => {
  test('judgments, replay parameters and tab survive a reload', async ({ page }) => {
    await page.goto('/app?sample=ecommerce&tab=tune')
    await slider(page, 'brand').fill('1')
    const rows = resultRows(page)
    await rows.nth(2).getByRole('button', { name: 'Rel' }).click()
    await waitForSaved(page, '"sku-5120":1')

    await page.goto('/app')
    await expect(page.getByRole('tab', { name: 'Tune' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.pill')).toHaveText('10 hits of 2,184')
    expect((await rowIds(rows)).slice(0, 2)).toEqual(['sku-2218', 'sku-2240'])
    await expect(slider(page, 'brand')).toHaveValue('1')
    await expect(rows.nth(2).getByRole('button', { name: 'Rel' })).toHaveAttribute('aria-pressed', 'true')
    // Gains are now 2,2,1,2,1 (sku-5120 marked Rel): DCG@5 = 7.0717, so nDCG@5 = 7.0717 / 7.2104 = 0.9808.
    await expect(metricValue(page, 'nDCG@5')).toHaveText('0.981')
  })

  test('mini index documents, query and boosts survive a reload', async ({ page }) => {
    await miniSearch(page, [{ id: 'd1', text: 'alpha beta' }, { id: 'd2', text: 'alpha' }], 'alpha')
    await slider(page, 'text boost').fill('3')
    await waitForSaved(page, '"text":3')
    await page.reload()
    await expect(miniQuery(page)).toHaveValue('alpha')
    await expect(miniDocs(page)).toHaveValue(/"d2"/)
    expect(await titles(page)).toEqual(['d2', 'd1'])
  })

  test('a corrupted saved workspace falls back to a clean lab instead of crashing', async ({ page }) => {
    await page.addInitScript((k) => localStorage.setItem(k, '{not json'), STORAGE_KEY)
    await page.goto('/app')
    await expect(page.getByRole('heading', { name: /Show me a response with/ })).toBeVisible()
    await expect(page.locator('.metric')).toHaveCount(0)
  })

  test('theme choice survives a reload', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Switch to dark theme' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark')
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme-mode', 'dark')
  })
})

// ---- share links ------------------------------------------------------------------------

test.describe('share links', () => {
  test('a share link restores parameters and judgments in a fresh browser context', async ({ page, browser, baseURL }) => {
    await page.goto('/app?sample=ecommerce&tab=tune')
    await slider(page, 'brand').fill('1')
    await page.getByRole('button', { name: 'Copy share link' }).click()
    await expect(page).toHaveURL(/\/app#s=/)
    const url = page.url()

    const ctx = await browser.newContext({ baseURL })
    const fresh = await ctx.newPage()
    const problems: string[] = []
    fresh.on('pageerror', (e) => problems.push(e.message))
    await fresh.route('**/*', (r) => (r.request().url().startsWith(baseURL!) || r.request().url().startsWith('data:') ? r.continue() : /fonts\./.test(r.request().url()) ? r.fulfill({ status: 200, contentType: 'text/css', body: '' }) : r.abort()))
    await fresh.goto(url)
    await expect(fresh.locator('.metric b').first()).toHaveText('0.911')
    expect(problems).toEqual([])
    await ctx.close()
  })

  // Each link is damaged in a different way. All must show the same message and raise no page error
  // (the fixture fails the test on any uncaught error or console error).
  const damaged: [string, string][] = [
    ['valid base64url that is not deflate data', 'AAAA'],
    ['too short to be deflate data', 'abc'],
    ['corrupt deflate blocks', 'AAAAAAAAAAAAAAAA'],
    ['not base64', '%%%'],
    ['deflated text that is not JSON', 'y8svUcgqzs8DAA'],
    ['deflated JSON null', 'yyvNyQEA'],
    ['deflated JSON number', 'MzECAA'],
    ['a real link cut short', 'q1YqTswtyElVslJKTc7PzU0tSk5V0lEqSUxSslIqKc1LVa'],
  ]
  for (const [name, hash] of damaged) {
    test(`a damaged share link (${name}) says so, raises no error and does not load a workspace`, async ({ page }) => {
      await page.goto(`/app#s=${hash}`)
      await expect(page.getByRole('status')).toContainText('That share link is damaged')
      await expect(page.locator('.metric')).toHaveCount(0)
      await expect(page.locator('.hit')).toHaveCount(0)
      await expect(page.getByRole('heading', { name: /Show me a response with/ })).toBeVisible()
    })
  }
})

// ---- unknown query values ---------------------------------------------------------------

test.describe('unknown ?sample= and ?tab= values', () => {
  const tabs = (page: Page) => page.getByRole('tab')
  const selected = (page: Page) => page.locator('[role=tab][aria-selected=true]')
  const toast = (page: Page) => page.locator('.toast')

  test('an unknown tab is ignored and reported, and the sample opens on a real tab', async ({ page }) => {
    await page.goto('/app?sample=ecommerce&tab=bogus')
    await expect(toast(page)).toContainText('Unknown tab "bogus", so it was ignored.')
    await expect(selected(page)).toHaveCount(1)
    await expect(page.getByRole('tab', { name: 'Explain' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.hit').first()).toContainText('Sony 3.5mm Audio Cable')
    await expect(page.locator('.verdict h2')).toBeVisible()

    // The bad value was not saved: a reload with no query lands on the same real tab.
    await waitForSaved(page, '"tab":"explain"')
    await page.goto('/app')
    await expect(page.getByRole('tab', { name: 'Explain' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.hit').first()).toBeVisible()
  })

  test('an unknown tab keeps the tab the saved workspace had', async ({ page }) => {
    await page.goto('/app?sample=ecommerce&tab=tune')
    await waitForSaved(page, '"tab":"tune"')
    await page.goto('/app?tab=bogus')
    await expect(toast(page)).toContainText('Unknown tab "bogus"')
    await expect(page.getByRole('tab', { name: 'Tune' })).toHaveAttribute('aria-selected', 'true')
    await expect(metricValue(page, 'nDCG@5')).toHaveText('0.221')
  })

  test('an unknown sample is reported and nothing else is loaded in its place', async ({ page }) => {
    await page.goto('/app?sample=nope')
    await expect(toast(page)).toContainText('Unknown sample "nope", so it was ignored.')
    await expect(page.locator('.pill')).toHaveCount(0)
    await expect(page.locator('.hit')).toHaveCount(0)
    await expect(page.getByLabel('Load a sample')).toHaveValue('')
    await expect(page.getByRole('heading', { name: /Show me a response with/ })).toBeVisible()
    await expect(selected(page)).toHaveCount(1)
  })

  test('an unknown sample leaves the saved workspace as it was', async ({ page }) => {
    await page.goto('/app?sample=field-dominance&tab=tune')
    await waitForSaved(page, '"sample":"field-dominance"')
    const pill = await page.locator('.pill').innerText()
    await page.goto('/app?sample=nope')
    await expect(toast(page)).toContainText('Unknown sample "nope"')
    await expect(page.getByLabel('Load a sample')).toHaveValue('field-dominance')
    await expect(page.locator('.pill')).toHaveText(pill)
    await expect(page.getByRole('tab', { name: 'Tune' })).toHaveAttribute('aria-selected', 'true')
  })

  test('both unknown at once are both reported', async ({ page }) => {
    await page.goto('/app?sample=nope&tab=bogus')
    await expect(toast(page)).toContainText('Unknown sample "nope", so it was ignored.')
    await expect(toast(page)).toContainText('Unknown tab "bogus", so it was ignored.')
    await expect(selected(page)).toHaveCount(1)
  })

  test('known values still work with no message', async ({ page }) => {
    await page.goto('/app?sample=docs-rrf&tab=lints')
    await expect(page.getByRole('tab', { name: 'Lints' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByLabel('Load a sample')).toHaveValue('docs-rrf')
    await expect(toast(page)).toHaveText('')
    await expect(tabs(page)).toHaveCount(6)
  })

  test('case and surrounding spaces in the query do not matter', async ({ page }) => {
    await page.goto('/app?sample=ECOMMERCE&tab=%20Tune')
    await expect(page.getByRole('tab', { name: 'Tune' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByLabel('Load a sample')).toHaveValue('ecommerce')
    await expect(toast(page)).toHaveText('')
  })

  test('a saved workspace that already holds an unknown tab or sample is repaired on load', async ({ page }) => {
    await page.addInitScript((k) => localStorage.setItem(k, JSON.stringify({ tab: 'bogus', sample: 'gone' })), STORAGE_KEY)
    await page.goto('/app')
    await expect(selected(page)).toHaveCount(1)
    await expect(page.getByRole('tab', { name: 'Explain' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByLabel('Load a sample')).toHaveValue('')
    await expect(page.getByRole('heading', { name: /Show me a response with/ })).toBeVisible()
  })

  const link = (state: unknown) => `/app#s=${deflateRawSync(Buffer.from(JSON.stringify(state))).toString('base64url')}`

  test('a share link with an unknown tab opens its sample on a real tab and says so', async ({ page }) => {
    await page.goto(link({ sample: 'ecommerce', tab: 'bogus', params: {}, judgments: {} }))
    await expect(toast(page)).toContainText('This share link names an unknown tab "bogus", so it was ignored.')
    await expect(page.locator('.pill')).toHaveText('10 hits of 2,184')
    await expect(selected(page)).toHaveCount(1)
  })

  test('a share link with an unknown sample loads no sample and says so', async ({ page }) => {
    await page.goto(link({ sample: 'nope', tab: 'tune' }))
    await expect(toast(page)).toContainText('This share link names an unknown sample "nope", so it was ignored.')
    await expect(page.locator('.pill')).toHaveCount(0)
    await expect(page.getByLabel('Load a sample')).toHaveValue('')
  })
})

// ---- site -------------------------------------------------------------------------------

test.describe('site', () => {
  test('landing, docs and unknown paths render without errors', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('link', { name: 'Open the lab' }).first()).toBeVisible()
    await page.getByRole('link', { name: 'Docs', exact: true }).click()
    await expect(page).toHaveURL(/\/docs$/)
    await expect(page.getByRole('main')).toContainText(/fixtures/i)
    await page.getByRole('link', { name: 'Samples', exact: true }).click()
    await expect(page).toHaveURL(/\/app\?sample=ecommerce/)
    await expect(page.locator('.hit').first()).toBeVisible()
  })
})
