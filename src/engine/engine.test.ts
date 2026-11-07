import test from 'node:test'
import assert from 'node:assert/strict'
import { attribute, bm25Score, ExplainParseError, parseNode, parseResponse, verdict, type RawExplanation } from './explain.ts'
import { bumpColumns, compare, diffTerm, observedParams, replay, sanity } from './replay.ts'
import { coverage, diagnose, distribution, linear, listsFromHits, normalize, parseList, rrf } from './hybrid.ts'
import { dcg, lints, metrics, mrr, ndcg, parseAnalyze, parseMapping, precisionAt, suggestParams, tunedQuery } from './insights.ts'
import { analyze, buildIndex, decodeNorm, encodeNorm, explainTerm, parseDocs, search } from './miniindex.ts'
import { decodeState, encodeState } from './share.ts'
import { HERO_CORPUS, SAMPLES } from './samples.ts'

const close = (a: number, b: number, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b}`)
const term = (over: Partial<Parameters<typeof explainTerm>[0]> = {}) => explainTerm({ field: 'title', term: 'foo', docId: 1, freq: 2, n: 10, N: 1000, dl: 8, avgdl: 10, queryBoost: 1, k1: 1.2, b: 0.75, ...over })

// A real tree shape from ES 8.x, verbatim strings.
const ES8: RawExplanation = {
  value: 1.3862942,
  description: 'weight(message:elasticsearch in 0) [PerFieldSimilarity], result of:',
  details: [{
    value: 1.3862942,
    description: 'score(freq=1.0), computed as boost * idf * tf from:',
    details: [
      { value: 2.2, description: 'boost', details: [] },
      { value: 1.3862944, description: 'idf, computed as log(1 + (N - n + 0.5) / (n + 0.5)) from:', details: [
        { value: 1, description: 'n, number of documents containing term', details: [] },
        { value: 5, description: 'N, total number of documents with field', details: [] },
      ] },
      { value: 0.45454544, description: 'tf, computed as freq / (freq + k1 * (1 - b + b * dl / avgdl)) from:', details: [
        { value: 1, description: 'termFreq=1.0', details: [] },
        { value: 1.2, description: 'k1, term saturation parameter', details: [] },
        { value: 0.75, description: 'b, length normalization parameter', details: [] },
        { value: 1, description: 'dl, length of field', details: [] },
        { value: 1, description: 'avgdl, average length of field', details: [] },
      ] },
    ],
  }],
}

test('parses modern BM25 and separates (k1 + 1) from the user boost', () => {
  const n = parseNode(ES8)
  assert.equal(n.kind, 'bm25')
  const t = n.bm25!
  assert.equal(t.field, 'message')
  assert.equal(t.term, 'elasticsearch')
  close(t.queryBoost, 1)
  assert.equal(t.k1Numerator, true)
  close(bm25Score(t, t.k1, t.b), ES8.value)
  assert.equal(n.warning, undefined)
})

test('a field boost shows as boost = 2.2 x boost, and is recovered', () => {
  const t = parseNode(term({ queryBoost: 3 })).bm25!
  close(t.queryBoost, 3)
})

test('parses ES 5/6 tfNorm format', () => {
  const n = parseNode({
    value: 2.0, description: 'weight(title:foo in 0) [PerFieldSimilarity], result of:', details: [{
      value: 2.0, description: 'score(doc=0,freq=1.0 = termFreq=1.0\n), product of:', details: [
        { value: 2.0, description: 'idf, computed as log(1 + (docCount - docFreq + 0.5) / (docFreq + 0.5)) from:', details: [
          { value: 10, description: 'docFreq', details: [] }, { value: 100, description: 'docCount', details: [] },
        ] },
        { value: 1.0, description: 'tfNorm, computed as (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * fieldLength / avgFieldLength)) from:', details: [
          { value: 1, description: 'termFreq=1.0', details: [] },
          { value: 1.2, description: 'parameter k1', details: [] },
          { value: 0.75, description: 'parameter b', details: [] },
          { value: 5, description: 'avgFieldLength', details: [] },
          { value: 5, description: 'fieldLength', details: [] },
        ] },
      ],
    }],
  })
  assert.equal(n.bm25!.format, 'tfNorm')
  close(n.bm25!.n!, 10)
  close(bm25Score(n.bm25!, 1.2, 0.75), 2.0)
})

test('attribution steps sum to the root score across sum, dis_max and function_score', () => {
  const a = term({ field: 'title', term: 'a' })
  const b = term({ field: 'body', term: 'a', freq: 1, dl: 100, avgdl: 100 })
  const inner = { value: a.value + 0.3 * b.value, description: 'max plus 0.3 times others of:', details: [a, b] }
  const root: RawExplanation = {
    value: inner.value * 2,
    description: 'function score, product of:',
    details: [inner, { value: 2, description: 'min of:', details: [
      { value: 2, description: "field value function: log1p(doc['p'].value * factor=1.0)", details: [] },
      { value: 3.4028235e38, description: 'maxBoost', details: [] },
    ] }],
  }
  const c = attribute(parseNode(root))
  close(c.reduce((s, x) => s + x.value, 0), root.value)
  assert.ok(c.some((x) => x.kind === 'function' && x.label.includes('log1p')))
})

test('dis_max without tie breaker records what it discarded', () => {
  const a = term({ field: 'title' })
  const b = term({ field: 'body', freq: 1, dl: 500, avgdl: 100 })
  const c = attribute(parseNode({ value: a.value, description: 'max of:', details: [a, b] }))
  const body = c.find((x) => x.field === 'body')!
  assert.equal(body.value, 0)
  close(body.shadowed!, b.value)
})

test('nested, constant_score, rank_feature and required-clause shapes parse without warnings', () => {
  const tree: RawExplanation = {
    value: 0, description: 'sum of:', details: [],
  }
  tree.details = [
    { value: 3, description: 'Score based on 2 child docs in range from 5 to 7, using score mode Avg', details: [term({ field: 'comments.text' })] },
    { value: 1, description: 'ConstantScore(status:active)', details: [] },
    { value: 0.5, description: 'Saturation function on the _feature field for the pagerank feature, computed as w * S / (S + k) from:', details: [
      { value: 1, description: 'w, weight of this function', details: [] },
      { value: 4, description: 'k, pivot feature value that would give a score contribution equal to w/2', details: [] },
      { value: 4, description: 'S, feature value', details: [] },
    ] },
    { value: 0, description: 'match on required clause, product of:', details: [
      { value: 0, description: '# clause', details: [] },
      { value: 1, description: 'status:active', details: [] },
    ] },
  ]
  tree.value = 4.5
  const parsed = parseNode(tree)
  assert.deepEqual(parsed.children.map((c) => c.kind), ['nested', 'constant', 'rankFeature', 'product'])
  assert.equal(parsed.warning, undefined)
  close(attribute(parsed).reduce((s, c) => s + c.value, 0), 4.5)
})

test('rrf strings from the retriever docs parse, with source ranks', () => {
  const n = parseNode({
    value: 0.5,
    description: 'rrf score: [0.5] computed for initial ranks [0, 1] with rankConstant: [1] as sum of [1 / (rank + rankConstant)] for each query',
    details: [
      { value: 0, description: 'rrf score: [0], result not found in query at index [0]', details: [] },
      { value: 1, description: 'rrf score: [0.5], for rank [1] in query at index [1] computed as [1 / (1 + 1)], for matching query with score', details: [
        { value: 1, description: 'found vector with calculated similarity: 1.0', details: [] },
      ] },
    ],
  })
  assert.equal(n.kind, 'rrf')
  assert.equal(n.rankConstant, 1)
  assert.equal(n.children[0].kind, 'noMatch')
  assert.deepEqual(n.children[1].source, { index: 1, name: undefined, rank: 1 })
  assert.equal(n.children[1].children[0].kind, 'knn')
})

test('linear retriever strings parse', () => {
  const n = parseNode({
    value: 1.8, description: 'weighted linear combination score: [1.8] computed for normalized scores [0.9, 0.3] and normalizer: [minmax] and weights [1.0, 3.0] as sum of (weight[i] * score[i]) for each query.',
    details: [{ value: 0.9, description: 'weighted score: [0.9] in query at index [0] [kw] computed as [1.0 * 0.9] using score normalizer [minmax] for original matching query with score:', details: [term()] }],
  })
  assert.equal(n.kind, 'linear')
  assert.equal(n.children[0].source?.normalizer, 'minmax')
  assert.equal(n.children[0].source?.name, 'kw')
})

test('unsupported shapes raise clear errors rather than guess', () => {
  const bad: [unknown, RegExp][] = [
    ['not json', /Not valid JSON/],
    [{ error: { reason: 'boom' }, status: 400 }, /error response: boom/],
    [{ took: 1, hits: { hits: [{ _id: 'a', _score: 1 }] } }, /no _explanation/],
    [{ hits: { hits: [] } }, /zero hits/],
    [{ _id: 'a', matched: false }, /does not match/],
    [{ foo: 1 }, /Unrecognised JSON shape/],
    [{ responses: [{}, {}] }, /_msearch/],
    [{ hits: { hits: [{ _id: 'a', _score: null, sort: [1], _explanation: ES8 }] } }, /sorted by field/],
    [{ value: 1, description: 'fieldWeight in 0, product of:', details: [] }, /classic TF-IDF/],
  ]
  for (const [input, re] of bad) assert.throws(() => parseResponse(input as string), (e: unknown) => e instanceof ExplainParseError && re.test(e.message), String(re))
})

test('unknown scoring nodes are flagged and held fixed', () => {
  const r = parseResponse({ value: 2, description: 'mystery scorer v9', details: [] })
  assert.match(r.hits[0].warnings[0], /Unrecognised/)
  assert.equal(replay(r.hits, { k1: 2 })[0].score, 2)
})

test('verdict gives per-term percentages and factors', () => {
  const r = parseResponse([{ _id: 'x', _score: ES8.value, _explanation: ES8 }])
  const v = verdict(r.hits[0])
  assert.match(v.headline, /message drives 100%/)
  assert.match(v.bullets[0], /100% from "elasticsearch" in message/)
  assert.match(v.bullets[0], /1 of 5 docs/)
  assert.match(v.bullets[0], /45% of the TF ceiling/)
})

test('all samples parse, replay within tolerance and carry no warnings', () => {
  for (const s of SAMPLES) {
    const r = parseResponse(s.response)
    assert.ok(r.hits.length >= 8, s.id)
    assert.deepEqual(r.hits.flatMap((h) => h.warnings), [], s.id)
    const check = sanity(r.hits)
    assert.ok(check.ok, `${s.id}: ${check.maxErrorPct}%`)
  }
})

test('replay with new k1 recomputes the k1 + 1 numerator', () => {
  const t = parseNode(ES8).bm25!
  const r = parseResponse([{ _id: 'x', _explanation: ES8 }])
  const expected = 1 * (2 + 1) * t.idf * (1 / (1 + 2 * (1 - 0.75 + 0.75)))
  close(replay(r.hits, { k1: 2 })[0].score, expected)
})

test('b = 0 removes the length penalty; the long doc gains', () => {
  const short = term({ dl: 4, avgdl: 50, freq: 1 })
  const long = term({ dl: 300, avgdl: 50, freq: 1, term: 'foo' })
  const r = parseResponse([{ _id: 's', _explanation: short }, { _id: 'l', _explanation: long }])
  const rows = replay(r.hits, { b: 0 })
  close(rows[0].score, rows[1].score)
  assert.ok(replay(r.hits, {})[0].score > replay(r.hits, {})[1].score)
})

test('sanity detects a tree whose score disagrees with its stats', () => {
  const broken = JSON.parse(JSON.stringify(ES8))
  broken.value = 9
  const r = parseResponse([{ _id: 'x', _explanation: broken }])
  assert.equal(sanity(r.hits).ok, false)
  assert.match(r.hits[0].warnings.join(), /arithmetic mismatch/)
})

test('compare effects decompose the delta exactly', () => {
  const a = parseNode(term({ freq: 5, dl: 4, n: 5 }))
  const b = parseNode(term({ freq: 1, dl: 40, n: 200, queryBoost: 2 }))
  const d = diffTerm(attribute(a)[0], attribute(b)[0])
  const e = d.effects!
  close(e.boost + e.idf + e.freq + e.length, d.delta)
})

test('flip option really flips the order when applied', () => {
  const s = SAMPLES[0]
  const { hits } = parseResponse(s.response)
  const relevant = hits.find((h) => h.id === 'sku-2218')!
  const c = compare(hits, hits[0].id, relevant.id)
  assert.equal(c.winner.id, hits[0].id)
  assert.ok(c.flips.length > 0)
  const applied = c.flips.find((f) => f.params)!
  const after = replay(hits, applied.params!)
  assert.ok(after.find((r) => r.id === relevant.id)!.rank < after.find((r) => r.id === hits[0].id)!.rank, applied.title)
  assert.ok(c.gap > 0)
  assert.ok(Math.abs(c.terms.reduce((a, t) => a + t.delta, 0) - c.gap) < 0.01)
})

test('bump columns apply knobs cumulatively and end on the full replay', () => {
  const { hits } = parseResponse(SAMPLES[2].response)
  const p = { k1: 0.9, b: 0.3, fieldBoost: { title: 0.5 }, tie: 0.3 }
  const cols = bumpColumns(hits, p)
  assert.equal(cols[0].label, 'as returned')
  assert.deepEqual(cols[0].ranks[hits[0].id], 1)
  const final = replay(hits, p)
  assert.equal(cols[cols.length - 1].ranks[final[0].id], 1)
})

test('rrf matches the documented 1 / (rank + c) with 1-based ranks', () => {
  const k = parseList('a 9\nb 8\nc 7', 'keyword')
  const v = parseList('b 0.9\nd 0.8', 'vector')
  const out = rrf([k, v], { rankConstant: 1, windowSize: 10 })
  assert.equal(out[0].id, 'b')
  close(out[0].score, 1 / 3 + 1 / 2)
  close(out.find((d) => d.id === 'a')!.score, 1 / 2)
})

test('rrf window truncates each retriever', () => {
  const k = parseList('a 9\nb 8\nc 7', 'keyword')
  const v = parseList('x 0.9\nc 0.8', 'vector')
  const out = rrf([k, v], { rankConstant: 60, windowSize: 1 })
  assert.deepEqual(out.map((d) => d.id).sort(), ['a', 'x'])
  assert.throws(() => rrf([k], { rankConstant: 0 }))
})

test('normalizers: minmax and l2_norm', () => {
  assert.deepEqual(normalize([2, 4, 6], 'minmax'), [0, 0.5, 1])
  const l2 = normalize([3, 4], 'l2_norm')
  close(l2[0], 0.6)
  close(l2[1], 0.8)
  assert.deepEqual(normalize([1, 2], 'none'), [1, 2])
})

test('linear none lets BM25 swamp; minmax lets vectors win', () => {
  const k = parseList('a 20\nb 18', 'keyword')
  const v = parseList('b 0.9\nc 0.89', 'vector')
  assert.equal(linear([k, v], { normalizer: 'none' })[0].id, 'a')
  assert.equal(linear([k, v], { normalizer: 'minmax', weights: [0.3, 0.7] })[0].id, 'b')
})

test('hybrid diagnosis finds scale mismatch, bunching and misses', () => {
  const s = SAMPLES[1]
  const k = parseList(s.keyword!, 'keyword')
  const v = parseList(s.vector!, 'vector')
  const findings = diagnose([k, v], 10)
  assert.ok(findings.some((f) => /run \d+× higher/.test(f.title)))
  assert.ok(findings.some((f) => /bunched/.test(f.title)))
  const fused = rrf([k, v], { windowSize: 10 })
  const cov = coverage([k, v], fused, 10)
  assert.ok(cov.onlyIn[0].includes('reset-api'))
  assert.ok(cov.onlyIn[1].includes('red-yellow'))
  assert.equal(distribution(k, 10).count, 10)
})

test('replayed RRF reproduces a combined response', () => {
  const s = SAMPLES[1]
  const { hits } = parseResponse(s.response)
  const recovered = listsFromHits(hits)!
  assert.equal(recovered.method, 'rrf')
  assert.equal(recovered.rankConstant, 60)
  assert.deepEqual(recovered.lists.map((l) => l.name), ['keyword', 'vector'])
  const out = rrf([parseList(s.keyword!, 'keyword'), parseList(s.vector!, 'vector')], { rankConstant: 60, windowSize: 10 })
  hits.forEach((h, i) => {
    close(out[i].score, h.score, 1e-5)
    assert.equal(out[i].id, h.id)
  })
})

test('parseList errors are specific', () => {
  assert.throws(() => parseList('a nope', 'kw'), /line 1/)
  assert.throws(() => parseList('{"foo":1}', 'kw'), /no hits/)
  assert.throws(() => parseList('', 'kw'), /empty/)
})

test('metrics: nDCG, MRR and precision', () => {
  close(dcg([1, 0, 1], 3), 1 + 1 / 2)
  assert.equal(ndcg(['a', 'b'], { a: 1 }, 2), 1)
  close(ndcg(['b', 'a'], { a: 1 }, 2), 1 / Math.log2(3))
  assert.equal(mrr(['x', 'a'], { a: 1 }), 0.5)
  assert.equal(precisionAt(['a', 'x', 'y', 'z'], { a: 1 }, 2), 0.5)
  assert.equal(metrics(['x'], {}, 5).ndcg, 0)
  // Tuning the e-commerce sample should measurably help.
  const s = SAMPLES[0]
  const { hits } = parseResponse(s.response)
  const before = ndcg(hits.map((h) => h.id), s.judgments, 5)
  const after = ndcg(replay(hits, { fieldBoost: { brand: 0.2 }, maxBoost: 1 }).map((r) => r.id), s.judgments, 5)
  assert.ok(after > before + 0.1, `${before} -> ${after}`)
})

test('lints fire on the samples that exhibit each problem', () => {
  const [eco, , blog] = SAMPLES
  const e = lints(parseResponse(eco.response).hits, { analyzeTokens: parseAnalyze(eco.analyze!), mapping: parseMapping(eco.mapping!) })
  assert.ok(e.some((l) => l.id === 'boost-swamp-brand'), JSON.stringify(e.map((l) => l.id)))
  assert.ok(e.some((l) => l.id === 'function-swamp'))
  assert.ok(e.some((l) => l.id === 'analyzer-mismatch' && /"headphones"/.test(l.detail) && /"headphon"/.test(l.detail)))
  const b = lints(parseResponse(blog.response).hits)
  assert.ok(b.some((l) => l.id === 'dominant-field' && /title/.test(l.title)), JSON.stringify(b.map((l) => l.title)))
  const skew = b.find((l) => l.id === 'idf-skew')
  assert.ok(skew)
  assert.match(skew.fix!, /dfs_query_then_fetch/)
})

test('summed kNN hybrid lint and recovery', () => {
  const root = { value: term().value + 0.8, description: 'sum of:', details: [term(), { value: 0.8, description: 'within top k documents', details: [] }] }
  const r = parseResponse([{ _id: 'x', _explanation: root }])
  assert.equal(listsFromHits(r.hits)!.method, 'sum')
  const big = { value: 20.8, description: 'sum of:', details: [term({ queryBoost: 10 }), { value: 0.8, description: 'within top k documents', details: [] }] }
  big.value = big.details[0].value + 0.8
  assert.ok(lints(parseResponse([{ _id: 'y', _explanation: big }]).hits).some((l) => l.id === 'hybrid-scale'))
})

test('tuned query patches an original query and emits similarity settings', () => {
  const s = SAMPLES[0]
  const { hits } = parseResponse(s.response)
  const out = tunedQuery(hits, { fieldBoost: { brand: 0.2 }, maxBoost: 1.5, k1: 0.8 }, { original: s.query })
  assert.match(out, /brand\^2"/)
  assert.match(out, /"max_boost": 1.5/)
  assert.match(tunedQuery(parseResponse(SAMPLES[2].response).hits, { tie: 0.5 }, { original: SAMPLES[2].query }), /"tie_breaker": 0.5/)
  assert.match(out, /tuned_bm25/)
  assert.match(out, /"k1": 0.8/)
  const generated = tunedQuery(hits, { fieldBoost: { brand: 0.5 } })
  assert.match(generated, /brand\^5/)
  assert.ok(JSON.parse(generated.split('\n').slice(1).join('\n')).query.function_score)
})

test('Lucene norm encoding keeps small lengths exact and rounds large ones down', () => {
  for (const dl of [0, 1, 10, 23, 24, 39]) assert.equal(decodeNorm(encodeNorm(dl)), dl)
  const lossy = decodeNorm(encodeNorm(2240))
  assert.ok(lossy <= 2240 && lossy > 1800, String(lossy))
  assert.ok(encodeNorm(2240) <= 255)
})

test('analyzers: standard and minimal english stem', () => {
  assert.deepEqual(analyze('The Quick-Brown foxes'), ['the', 'quick', 'brown', 'foxes'])
  assert.deepEqual(analyze('The queries of foxes and glass', 'english'), ['query', 'foxe', 'glass'])
})

test('mini index returns ES-shaped responses with correct BM25', () => {
  const ix = buildIndex(parseDocs(JSON.stringify([
    { id: 'a', title: 'red fox', body: 'the fox ran' },
    { id: 'b', title: 'blue whale', body: 'a fox and a whale and a fox' },
    { id: 'c', title: 'green turtle', body: 'slow' },
  ])))
  const res = search(ix, { query: 'fox', fields: { title: 2, body: 1 } })
  assert.equal(res.hits.total.value, 2)
  const parsed = parseResponse(JSON.stringify(res))
  assert.equal(parsed.hits[0].id, 'a')
  assert.deepEqual(parsed.hits.flatMap((h) => h.warnings), [])
  assert.ok(sanity(parsed.hits).ok)
  // Hand-checked: title has N=3, n=1, avgdl=2, dl=2, freq=1, boost 2.
  const idf = Math.log(1 + 2.5 / 1.5)
  close(attribute(parsed.hits[0].root).find((c) => c.field === 'title')!.value, 2 * 2.2 * idf * (1 / 2.2), 1e-4)
})

test('mini index replay at new params equals a real re-search', () => {
  const ix = buildIndex(HERO_CORPUS)
  const fields = { title: 2, body: 1 }
  const before = parseResponse(search(ix, { query: 'search relevance', fields, size: 12 }))
  const replayed = replay(before.hits, { k1: 0.5, b: 0.2, fieldBoost: { title: 1.5 } })
  const fresh = parseResponse(search(ix, { query: 'search relevance', fields: { title: 3, body: 1 }, k1: 0.5, b: 0.2, size: 12 }))
  assert.deepEqual(replayed.map((r) => r.id), fresh.hits.map((h) => h.id))
  replayed.forEach((r, i) => close(r.score, fresh.hits[i].score, 1e-3))
})

test('observed parameters come from the tree', () => {
  const { hits } = parseResponse(SAMPLES[0].response)
  const o = observedParams(hits)
  assert.equal(o.k1, 1.2)
  assert.equal(o.hasFunctions, true)
  assert.ok(o.maxUplift > 2)
})

test('share state round-trips through the URL hash', async () => {
  const state = { sample: 'x', params: { k1: 0.9 }, text: 'é'.repeat(500) }
  const encoded = await encodeState(state)
  assert.match(encoded, /^[\w-]+$/)
  assert.deepEqual(await decodeState(encoded), state)
})

test('suggestParams raises nDCG, and its result reproduces under replay', () => {
  for (const s of [SAMPLES[0], SAMPLES[2]]) {
    const { hits } = parseResponse(s.response)
    const out = suggestParams(hits, s.judgments, 5)
    assert.ok(out.after > out.before + 0.1, `${s.id}: ${out.before} -> ${out.after}`)
    close(ndcg(replay(hits, out.params).map((r) => r.id), s.judgments, 5), out.after, 1e-9)
    assert.ok(out.changed.length > 0)
  }
})
