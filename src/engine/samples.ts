// Realistic responses, in the exact explain format, built from plausible index statistics.
import { explainTerm, type TermInput } from './miniindex.ts'
import type { RawExplanation } from './explain.ts'
import type { Judgments } from './insights.ts'

const f = (x: number) => +Math.fround(x).toPrecision(8)
const sum = (details: RawExplanation[], description = 'sum of:'): RawExplanation => details.length === 1 && description === 'sum of:' ? details[0] : { value: f(details.reduce((a, d) => a + d.value, 0)), description, details }
const dismax = (details: RawExplanation[], tie = 0): RawExplanation => {
  if (details.length === 1) return details[0]
  const vals = details.map((d) => d.value)
  const best = Math.max(...vals)
  return { value: f(best + tie * (vals.reduce((a, b) => a + b, 0) - best)), description: tie ? `max plus ${tie} times others of:` : 'max of:', details }
}
const K = { k1: 1.2, b: 0.75 }

interface Stats { [term: string]: { n: number } }
function terms(field: string, docId: number, m: Record<string, number>, stats: Stats, N: number, dl: number, avgdl: number, queryBoost: number): RawExplanation[] {
  return Object.entries(m).map(([term, freq]) => explainTerm({ field, term, docId, freq, n: stats[term].n, N, dl, avgdl, queryBoost, ...K } as TermInput))
}
const wrap = (hits: unknown[], total: number, took: number) => JSON.stringify({
  took, timed_out: false, _shards: { total: 3, successful: 3, skipped: 0, failed: 0 },
  hits: { total: { value: total, relation: 'eq' }, max_score: (hits[0] as { _score: number })._score, hits },
}, null, 1)

// --- E-commerce: brand boost and popularity multiplier drown out the product type ------------

function ecommerce() {
  const titleStats: Stats = { soni: { n: 840 }, wireless: { n: 3120 }, headphon: { n: 410 } }
  const brandStats: Stats = { soni: { n: 880 } }
  const descStats: Stats = { soni: { n: 610 }, wireless: { n: 9100 }, headphon: { n: 1640 } }
  const N = 48210
  type P = { id: string; title: string; brand: string; popularity: number; t: Record<string, number>; tdl: number; b: Record<string, number>; d: Record<string, number>; ddl: number; rel: number; price: number }
  const products: P[] = [
    { id: 'sku-4471', title: 'Sony Replacement Ear Pads, 2-pack', brand: 'Sony', popularity: 9200, t: { soni: 1 }, tdl: 5, b: { soni: 1 }, d: { soni: 2 }, ddl: 38, rel: 0, price: 14 },
    { id: 'sku-1093', title: 'Sony 3.5mm Audio Cable', brand: 'Sony', popularity: 12400, t: { soni: 1 }, tdl: 4, b: { soni: 1 }, d: { soni: 1 }, ddl: 26, rel: 0, price: 9 },
    { id: 'sku-7730', title: 'Sony USB-C Charging Case', brand: 'Sony', popularity: 7100, t: { soni: 1 }, tdl: 5, b: { soni: 1 }, d: { soni: 1, wireless: 1 }, ddl: 44, rel: 0, price: 29 },
    { id: 'sku-2218', title: 'Sony WH-1000XM6 Wireless Headphones', brand: 'Sony', popularity: 3800, t: { soni: 1, wireless: 1, headphon: 1 }, tdl: 5, b: { soni: 1 }, d: { soni: 2, wireless: 2, headphon: 3 }, ddl: 92, rel: 2, price: 399 },
    { id: 'sku-2240', title: 'Sony WH-CH720N Wireless Headphones', brand: 'Sony', popularity: 2600, t: { soni: 1, wireless: 1, headphon: 1 }, tdl: 5, b: { soni: 1 }, d: { soni: 1, wireless: 2, headphon: 2 }, ddl: 74, rel: 2, price: 149 },
    { id: 'sku-3302', title: 'Sony ULT Wear Wireless Noise Cancelling Headphones', brand: 'Sony', popularity: 1400, t: { soni: 1, wireless: 1, headphon: 1 }, tdl: 7, b: { soni: 1 }, d: { soni: 1, wireless: 1, headphon: 2 }, ddl: 81, rel: 2, price: 199 },
    { id: 'sku-5120', title: 'Sony Headphone Stand', brand: 'Sony', popularity: 2200, t: { soni: 1, headphon: 1 }, tdl: 3, b: { soni: 1 }, d: { headphon: 2 }, ddl: 30, rel: 0, price: 24 },
    { id: 'sku-6601', title: 'Sony WF-C510 Wireless Earbuds', brand: 'Sony', popularity: 5400, t: { soni: 1, wireless: 1 }, tdl: 5, b: { soni: 1 }, d: { soni: 1, wireless: 3 }, ddl: 66, rel: 1, price: 59 },
    { id: 'sku-8842', title: 'Bose QuietComfort Wireless Headphones', brand: 'Bose', popularity: 6100, t: { wireless: 1, headphon: 1 }, tdl: 4, b: {}, d: { wireless: 2, headphon: 3, soni: 1 }, ddl: 88, rel: 1, price: 349 },
    { id: 'sku-9015', title: 'Anker Soundcore Wireless Headphones', brand: 'Anker', popularity: 8800, t: { wireless: 1, headphon: 1 }, tdl: 4, b: {}, d: { wireless: 2, headphon: 2 }, ddl: 70, rel: 1, price: 59 },
  ]
  const hits = products.map((p, i) => {
    const fields = [
      sum(terms('title', i * 37, p.t, titleStats, N, p.tdl, 8.4, 2)),
      ...(Object.keys(p.b).length ? [sum(terms('brand', i * 37, p.b, brandStats, N, 1, 1.1, 10))] : []),
      sum(terms('description', i * 37, p.d, descStats, N, p.ddl, 64.2, 1)),
    ]
    const q = dismax(fields, 0)
    const factor = Math.log10(1 + p.popularity * 1.2)
    const fn: RawExplanation = {
      value: f(factor),
      description: 'min of:',
      details: [
        { value: f(factor), description: `field value function: log1p(doc['popularity'].value * factor=1.2)`, details: [] },
        { value: 3.4028235e38, description: 'maxBoost', details: [] },
      ],
    }
    const value = f(q.value * factor)
    return { p, hit: {
      _shard: `[products][${i % 3}]`, _node: 'p7Wk2nYtQ3yqvJ0xLw8Y3A', _index: 'products', _id: p.id, _score: value,
      _source: { title: p.title, brand: p.brand, popularity: p.popularity, price: p.price },
      _explanation: { value, description: 'function score, product of:', details: [q, fn] },
    } }
  }).sort((a, b) => b.hit._score - a.hit._score)
  return {
    response: wrap(hits.map((h) => h.hit), 2184, 18),
    judgments: Object.fromEntries(products.map((p) => [p.id, p.rel])) as Judgments,
    query: JSON.stringify({ query: { function_score: { query: { multi_match: { query: 'sony wireless headphones', fields: ['title^2', 'brand^10', 'description'], type: 'best_fields' } }, field_value_factor: { field: 'popularity', factor: 1.2, modifier: 'log1p' }, boost_mode: 'multiply' } }, explain: true, size: 10 }, null, 2),
    analyze: JSON.stringify({ tokens: [
      { token: 'sony', start_offset: 0, end_offset: 4, type: '<ALPHANUM>', position: 0 },
      { token: 'wireless', start_offset: 5, end_offset: 13, type: '<ALPHANUM>', position: 1 },
      { token: 'headphones', start_offset: 14, end_offset: 24, type: '<ALPHANUM>', position: 2 },
    ] }, null, 2),
    mapping: JSON.stringify({ products: { mappings: { properties: {
      title: { type: 'text', analyzer: 'english', fields: { keyword: { type: 'keyword' } } },
      brand: { type: 'text', analyzer: 'english' },
      description: { type: 'text', analyzer: 'english' },
      popularity: { type: 'rank_feature' },
      price: { type: 'scaled_float', scaling_factor: 100 },
    } } } }, null, 2),
    queryText: 'sony wireless headphones',
  }
}

// --- Docs search: RRF over BM25 + kNN -------------------------------------------------------

const docTitles: Record<string, string> = {
  'allocation-explain': 'Cluster allocation explain API',
  'shard-recovery': 'Troubleshooting unassigned primary shards',
  'reroute-api': 'Cluster reroute API',
  'watermarks': 'Fix watermark errors',
  'node-restart': 'Full-cluster restart and rolling restart',
  'retry-failed': 'Retry failed shard allocations',
  'delayed-alloc': 'Delaying allocation when a node leaves',
  'tiers': 'Data tiers and allocation filtering',
  'snapshot-restore': 'Restore a snapshot',
  'circuit-breakers': 'Circuit breaker errors',
  'red-yellow': 'Red or yellow cluster health status',
  'hot-spot': 'Hot spotting on nodes',
  'shard-size': 'Size your shards',
  'task-queue': 'Task queue backlog',
  'cat-shards': 'cat shards API',
  'ilm-stuck': 'Troubleshoot index lifecycle management errors',
  'disk-usage': 'Analyze index disk usage',
  'rebalance': 'Cluster-level shard allocation settings',
  'reset-api': 'Reset an index',
  'forcemerge': 'Force merge API',
}

const KW_STATS: Stats = { reset: { n: 141 }, stuck: { n: 96 }, shard: { n: 1412 }, allocat: { n: 412 } }
const KW_DOCS: [string, number, Record<string, number>][] = [
  ['reroute-api', 300, { shard: 9, allocat: 12, stuck: 2 }],
  ['retry-failed', 180, { shard: 6, allocat: 7, stuck: 3 }],
  ['reset-api', 120, { reset: 8, shard: 1 }],
  ['allocation-explain', 640, { shard: 14, allocat: 22, stuck: 1 }],
  ['rebalance', 520, { shard: 12, allocat: 11 }],
  ['cat-shards', 410, { shard: 16 }],
  ['tiers', 700, { allocat: 9, shard: 3 }],
  ['delayed-alloc', 380, { shard: 5, allocat: 5 }],
  ['shard-recovery', 900, { shard: 20, allocat: 6, stuck: 2 }],
  ['shard-size', 1100, { shard: 26 }],
  ['disk-usage', 350, { shard: 2 }],
  ['forcemerge', 430, { shard: 3 }],
]
const kwTree = (i: number) => sum(terms('body', i * 11, KW_DOCS[i][2], KW_STATS, 4210, KW_DOCS[i][1], 412, 1))
const KEYWORD: [string, number][] = KW_DOCS.map(([id], i): [string, number] => [id, kwTree(i).value]).sort((a, b) => b[1] - a[1])
const VECTOR: [string, number][] = [
  ['shard-recovery', 0.8931], ['allocation-explain', 0.8842], ['red-yellow', 0.8795], ['retry-failed', 0.8712], ['watermarks', 0.8604], ['delayed-alloc', 0.8551],
  ['node-restart', 0.8438], ['hot-spot', 0.8312], ['ilm-stuck', 0.8247], ['snapshot-restore', 0.8133], ['circuit-breakers', 0.8021], ['task-queue', 0.7914],
]

function hybrid() {
  const c = 60
  const window = 10
  const fused = new Map<string, { kw?: number; v?: number }>()
  KEYWORD.slice(0, window).forEach(([id], i) => fused.set(id, { ...fused.get(id), kw: i + 1 }))
  VECTOR.slice(0, window).forEach(([id], i) => fused.set(id, { ...fused.get(id), v: i + 1 }))
  const rows = [...fused].map(([id, r]) => ({ id, ...r, score: (r.kw ? 1 / (c + r.kw) : 0) + (r.v ? 1 / (c + r.v) : 0) })).sort((a, b) => b.score - a.score)
  const hits = rows.slice(0, 10).map((r) => {
    const kids: RawExplanation[] = []
    const ranks = `[${r.kw ?? 0}, ${r.v ?? 0}]`
    if (r.kw) {
      const inner = kwTree(KW_DOCS.findIndex((k) => k[0] === r.id))
      kids.push({ value: f(1 / (c + r.kw)), description: `rrf score: [${f(1 / (c + r.kw))}], for rank [${r.kw}] in query at index [0] computed as [1 / (${r.kw} + ${c})], for matching query with score`, details: [inner] })
    } else {
      kids.push({ value: 0, description: 'rrf score: [0], result not found in query at index [0]', details: [] })
    }
    if (r.v) {
      const sim = VECTOR[r.v - 1][1]
      kids.push({ value: f(1 / (c + r.v)), description: `rrf score: [${f(1 / (c + r.v))}], for rank [${r.v}] in query at index [1] computed as [1 / (${r.v} + ${c})], for matching query with score`, details: [{ value: sim, description: `found vector with calculated similarity: ${sim}`, details: [] }] })
    } else {
      kids.push({ value: 0, description: 'rrf score: [0], result not found in query at index [1]', details: [] })
    }
    return {
      _shard: `[docs-v3][${r.id.length % 2}]`, _node: 'Tn0qQ4d8R9aZ', _index: 'docs-v3', _id: r.id, _score: f(r.score), _source: { title: docTitles[r.id] },
      _explanation: { value: f(r.score), description: `rrf score: [${f(r.score)}] computed for initial ranks ${ranks} with rankConstant: [${c}] as sum of [1 / (rank + rankConstant)] for each query`, details: kids },
    }
  })
  const judgments: Judgments = { 'shard-recovery': 2, 'allocation-explain': 2, 'retry-failed': 2, 'red-yellow': 1, 'delayed-alloc': 1, 'reroute-api': 1, 'watermarks': 1 }
  const toList = (rows: [string, number][]) => JSON.stringify(rows.map(([id, score]) => ({ _id: id, _score: score, title: docTitles[id] })), null, 1)
  return {
    response: wrap(hits, 74, 41),
    judgments,
    keyword: toList(KEYWORD),
    vector: toList(VECTOR),
    queryText: 'how do I reset a stuck shard allocation',
    query: JSON.stringify({ retriever: { rrf: { retrievers: [{ standard: { query: { match: { body: 'how do I reset a stuck shard allocation' } } } }, { knn: { field: 'body_vector', query_vector_builder: { text_embedding: { model_id: '.multilingual-e5-small', model_text: 'how do I reset a stuck shard allocation' } }, k: 10, num_candidates: 100 } }], rank_constant: 60, rank_window_size: 10 } }, explain: true }, null, 2),
    mapping: JSON.stringify({ 'docs-v3': { mappings: { properties: { title: { type: 'text' }, body: { type: 'text', analyzer: 'english' }, body_vector: { type: 'dense_vector', dims: 384, similarity: 'cosine' } } } } }, null, 2),
  }
}

// --- Blog search: short titles dominate, plus small shard skew ------------------------------

function fieldDominance() {
  const shards = [
    { N: 1240, title: { kubernet: 34, autoscal: 9 }, body: { kubernet: 620, autoscal: 240 } },
    { N: 1180, title: { kubernet: 12, autoscal: 2 }, body: { kubernet: 590, autoscal: 210 } },
    { N: 1310, title: { kubernet: 51, autoscal: 15 }, body: { kubernet: 700, autoscal: 320 } },
  ]
  type A = { id: string; title: string; s: number; t: Record<string, number>; tdl: number; b: Record<string, number>; bdl: number; rel: number }
  const articles: A[] = [
    { id: 'a-204', title: 'Kubernetes autoscaling FAQ', s: 1, t: { kubernet: 1, autoscal: 1 }, tdl: 3, b: { kubernet: 2, autoscal: 1 }, bdl: 96, rel: 0 },
    { id: 'a-118', title: 'Autoscaling, briefly', s: 1, t: { autoscal: 1 }, tdl: 2, b: { autoscal: 2 }, bdl: 120, rel: 0 },
    { id: 'a-377', title: 'Kubernetes release notes', s: 0, t: { kubernet: 1 }, tdl: 3, b: { kubernet: 6, autoscal: 1 }, bdl: 410, rel: 0 },
    { id: 'a-091', title: 'A production guide to Kubernetes pod autoscaling with HPA and KEDA', s: 2, t: { kubernet: 1, autoscal: 1 }, tdl: 11, b: { kubernet: 24, autoscal: 19 }, bdl: 2240, rel: 2 },
    { id: 'a-156', title: 'Tuning cluster autoscaler in large Kubernetes fleets: lessons from three years', s: 0, t: { kubernet: 1, autoscal: 1 }, tdl: 11, b: { kubernet: 18, autoscal: 22 }, bdl: 1980, rel: 2 },
    { id: 'a-243', title: 'How we cut node costs by 40% using custom metrics', s: 2, t: {}, tdl: 10, b: { kubernet: 14, autoscal: 16 }, bdl: 1460, rel: 2 },
    { id: 'a-412', title: 'Vertical pod autoscaling trade-offs on Kubernetes', s: 0, t: { kubernet: 1, autoscal: 1 }, tdl: 6, b: { kubernet: 9, autoscal: 12 }, bdl: 940, rel: 1 },
    { id: 'a-067', title: 'Kubernetes basics for platform teams', s: 2, t: { kubernet: 1 }, tdl: 5, b: { kubernet: 21 }, bdl: 1750, rel: 0 },
    { id: 'a-330', title: 'Event-driven scaling patterns', s: 1, t: {}, tdl: 3, b: { kubernet: 5, autoscal: 8 }, bdl: 620, rel: 1 },
  ]
  const hits = articles.map((a, i) => {
    const sh = shards[a.s]
    const toStats = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, n]) => [k, { n }])) as Stats
    const clauses = [
      ...(Object.keys(a.t).length ? [sum(terms('title', i * 13, a.t, toStats(sh.title), sh.N, a.tdl, 7.2, 1))] : []),
      sum(terms('body', i * 13, a.b, toStats(sh.body), sh.N, a.bdl, 880, 1)),
    ]
    const exp = dismax(clauses, 0)
    return {
      _shard: `[articles][${a.s}]`, _node: 'mK3sQ8', _index: 'articles', _id: a.id, _score: exp.value, _source: { title: a.title },
      _explanation: exp,
    }
  }).sort((x, y) => y._score - x._score)
  return {
    response: wrap(hits, 312, 12),
    judgments: Object.fromEntries(articles.map((a) => [a.id, a.rel])) as Judgments,
    query: JSON.stringify({ query: { multi_match: { query: 'kubernetes autoscaling', fields: ['title', 'body'], type: 'best_fields' } }, explain: true }, null, 2),
    mapping: JSON.stringify({ articles: { mappings: { properties: { title: { type: 'text', analyzer: 'english' }, body: { type: 'text', analyzer: 'english' } } } } }, null, 2),
    analyze: JSON.stringify({ tokens: [{ token: 'kubernet', start_offset: 0, end_offset: 10, type: '<ALPHANUM>', position: 0 }, { token: 'autoscal', start_offset: 11, end_offset: 22, type: '<ALPHANUM>', position: 1 }] }, null, 2),
    queryText: 'kubernetes autoscaling',
  }
}

export interface Sample {
  id: string
  name: string
  blurb: string
  problem: string
  response: string
  judgments: Judgments
  query?: string
  analyze?: string
  mapping?: string
  keyword?: string
  vector?: string
  queryText?: string
}

export const SAMPLES: Sample[] = [
  { id: 'ecommerce', name: 'E-commerce boost problem', blurb: 'brand^10 and a popularity multiplier sell cables to people looking for headphones.', problem: 'boost swamping', ...ecommerce() },
  { id: 'docs-rrf', name: 'Docs search with hybrid RRF', blurb: 'BM25 and kNN disagree on a support question. Their score scales differ by an order of magnitude, and RRF reconciles them by rank.', problem: 'hybrid fusion', ...hybrid() },
  { id: 'field-dominance', name: 'Title vs body dominance', blurb: 'Stub articles with three-word titles beat real guides, and IDF drifts across small shards.', problem: 'field dominance', ...fieldDominance() },
]

export const HERO_CORPUS: { id: string; title: string; body: string }[] = [
  { id: 'hybrid-rrf', title: 'Hybrid search with reciprocal rank fusion', body: 'Combine keyword search and vector search by rank instead of score. RRF needs no score calibration and works well when BM25 and embedding scores live on different scales.' },
  { id: 'bm25-tuning', title: 'Tuning BM25 k1 and b', body: 'BM25 controls term frequency saturation with k1 and field length normalization with b. Lower b when long documents are unfairly penalized in search results.' },
  { id: 'explain-api', title: 'Reading the explain API', body: 'The explain API shows why a document matched and how its score was computed from idf, term frequency, field length and boost. Search relevance starts here.' },
  { id: 'vector-knn', title: 'Approximate kNN vector search', body: 'Vector search finds nearest neighbors in embedding space using HNSW. Increase num_candidates to improve recall at the cost of search latency.' },
  { id: 'field-boosts', title: 'Field boosts in multi_match', body: 'Boost title over body with the caret syntax, but keep boosts small. A large boost on one field can swamp every other relevance signal in search.' },
  { id: 'analyzers', title: 'Analyzers and search tokens', body: 'Text is tokenized and stemmed by an analyzer at index time and again at search time. If query tokens and index tokens disagree, keyword search misses relevant documents.' },
  { id: 'semantic-text', title: 'Semantic text fields', body: 'The semantic_text field type handles embeddings and chunking automatically, so semantic search over vectors takes one mapping and one query.' },
  { id: 'ndcg', title: 'Measuring relevance with nDCG', body: 'Use judgment lists and the rank evaluation API to measure search quality. nDCG, MRR and precision at k show whether tuning really improved relevance.' },
  { id: 'function-score', title: 'Popularity and function_score', body: 'Multiply text relevance by a popularity signal with field_value_factor. Without max_boost, a very popular document can outrank a far more relevant search result.' },
  { id: 'dfs', title: 'Small shards skew IDF', body: 'Each shard computes term statistics locally. In small indices this skews idf and search scores, and dfs_query_then_fetch collects global statistics first.' },
  { id: 'rank-feature', title: 'Rank features for static signals', body: 'The rank_feature query adds a saturation, log, sigmoid or linear function of a stored signal such as pagerank to the relevance score.' },
  { id: 'search-guide', title: 'Search', body: 'An overview of search, retrievers, query DSL and search relevance.' },
]
