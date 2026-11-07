// Ranking metrics, relevance lints and tuned-query generation.
import { attribute, type ENode, type Hit } from './explain.ts'
import { fieldStats, observedParams, replay, type Params } from './replay.ts'

// ---- Metrics ---------------------------------------------------------------------------

/** Graded judgments by doc id: 0 not relevant, 1 relevant, 2 highly relevant. */
export type Judgments = Record<string, number>

export function dcg(gains: number[], k: number) {
  return gains.slice(0, k).reduce((a, g, i) => a + (2 ** g - 1) / Math.log2(i + 2), 0)
}

export function ndcg(ranked: string[], j: Judgments, k: number) {
  const ideal = dcg(Object.values(j).filter((g) => g > 0).sort((a, b) => b - a), k)
  return ideal ? dcg(ranked.map((id) => j[id] ?? 0), k) / ideal : 0
}

export function mrr(ranked: string[], j: Judgments) {
  const i = ranked.findIndex((id) => (j[id] ?? 0) > 0)
  return i < 0 ? 0 : 1 / (i + 1)
}

export function precisionAt(ranked: string[], j: Judgments, k: number) {
  const top = ranked.slice(0, k)
  return top.length ? top.filter((id) => (j[id] ?? 0) > 0).length / k : 0
}

export interface Metrics { ndcg: number; mrr: number; precision: number }

export function metrics(ranked: string[], j: Judgments, k: number): Metrics {
  return { ndcg: ndcg(ranked, j, k), mrr: mrr(ranked, j), precision: precisionAt(ranked, j, k) }
}

export interface Suggestion { params: Params; before: number; after: number; changed: string[] }

/** Coordinate descent over query and similarity knobs, maximizing nDCG@k for these judgments. */
export function suggestParams(hits: Hit[], j: Judgments, k: number): Suggestion {
  const obs = observedParams(hits)
  const fields = fieldStats(hits).map((f) => f.field)
  const score = (p: Params) => ndcg(replay(hits, p).map((r) => r.id), j, k)
  const before = score({})
  let params: Params = {}
  let best = before
  const knobs: { name: string; values: number[]; set: (p: Params, v: number) => Params; cost: number }[] = [
    ...fields.map((f) => ({ name: `${f} boost`, values: [0.1, 0.2, 0.33, 0.5, 0.75, 1.5, 2, 3, 5], set: (p: Params, v: number) => ({ ...p, fieldBoost: { ...p.fieldBoost, [f]: v } }), cost: 0.001 })),
    ...(obs.hasFunctions ? [{ name: 'max_boost', values: [1, 1.25, 1.5, 2, 3], set: (p: Params, v: number) => ({ ...p, maxBoost: v }), cost: 0.001 }] : []),
    ...(obs.hasTie ? [{ name: 'tie_breaker', values: [0.1, 0.3, 0.5, 0.7], set: (p: Params, v: number) => ({ ...p, tie: v }), cost: 0.001 }] : []),
    // Similarity changes touch index settings, so they must earn a bigger gain.
    { name: 'k1', values: [0.3, 0.6, 0.9, 1.6, 2], set: (p: Params, v: number) => ({ ...p, k1: v }), cost: 0.005 },
    { name: 'b', values: [0, 0.2, 0.4, 0.6, 0.9], set: (p: Params, v: number) => ({ ...p, b: v }), cost: 0.005 },
  ]
  const changed = new Set<string>()
  for (let pass = 0; pass < 2; pass++) {
    for (const knob of knobs) {
      for (const v of knob.values) {
        const next = knob.set(params, v)
        const s = score(next)
        if (s > best + (changed.has(knob.name) ? 1e-6 : knob.cost)) {
          best = s
          params = next
          changed.add(knob.name)
        }
      }
    }
  }
  return { params, before, after: best, changed: [...changed] }
}

// ---- Optional inputs -------------------------------------------------------------------

export function parseAnalyze(text: string): string[] {
  const j = JSON.parse(text)
  if (Array.isArray(j.tokens)) return j.tokens.map((t: { token: string }) => t.token)
  const d = j.detail
  if (d) {
    const last = d.analyzer?.tokens ?? d.tokenfilters?.[d.tokenfilters.length - 1]?.tokens ?? d.tokenizer?.tokens
    if (Array.isArray(last)) return last.map((t: { token: string }) => t.token)
  }
  throw new Error('Expected an _analyze response with tokens[], or detail{} from explain: true.')
}

export interface FieldMapping { type?: string; analyzer?: string; search_analyzer?: string; similarity?: string; norms?: boolean }

export function parseMapping(text: string): Record<string, FieldMapping> {
  const j = JSON.parse(text)
  let props = j.properties ?? j.mappings?.properties
  if (!props) {
    const first = Object.values(j)[0] as { mappings?: { properties?: unknown } } | undefined
    props = first?.mappings?.properties
  }
  if (!props) throw new Error('Expected a GET <index>/_mapping response with mappings.properties.')
  const out: Record<string, FieldMapping> = {}
  const walk = (o: Record<string, any>, prefix: string) => {
    for (const [k, v] of Object.entries(o)) {
      const name = prefix + k
      out[name] = { type: v.type, analyzer: v.analyzer, search_analyzer: v.search_analyzer, similarity: v.similarity, norms: v.norms }
      if (v.properties) walk(v.properties, `${name}.`)
      if (v.fields) walk(v.fields, `${name}.`)
    }
  }
  walk(props, '')
  return out
}

// ---- Lints -----------------------------------------------------------------------------

export interface Lint {
  id: string
  severity: 'critical' | 'warning' | 'info'
  title: string
  detail: string
  fix?: string
}

function bm25Nodes(n: ENode, out: ENode[] = []) {
  if (n.bm25) out.push(n)
  n.children.forEach((c) => bm25Nodes(c, out))
  return out
}

function commonPrefix(a: string, b: string) {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return i
}

export function lints(hits: Hit[], o: { analyzeTokens?: string[]; mapping?: Record<string, FieldMapping>; k?: number } = {}): Lint[] {
  const out: Lint[] = []
  const k = Math.min(o.k ?? 5, hits.length)
  const top = hits.slice(0, k)

  // Dominant field across the top results.
  const share = new Map<string, number>()
  for (const h of top) {
    for (const c of attribute(h.root)) {
      if (c.kind === 'bm25' && h.score) share.set(c.field!, (share.get(c.field!) ?? 0) + c.value / h.score / top.length)
    }
  }
  const dom = [...share].sort((a, b) => b[1] - a[1])[0]
  if (dom && share.size > 1 && dom[1] >= 0.7) {
    const shadowed = top.flatMap((h) => attribute(h.root)).filter((c) => c.shadowed && c.field !== dom[0]).length
    out.push({
      id: 'dominant-field', severity: 'warning',
      title: `${dom[0]} supplies ${Math.round(dom[1] * 100)}% of the score in the top ${k}`,
      detail: `The other queried fields barely influence order.${shadowed ? ` dis_max also discarded ${shadowed} clause${shadowed > 1 ? 's' : ''} from other fields.` : ''}`,
      fix: 'Lower its boost, add a tie_breaker, or use most_fields or combined_fields when fields hold the same kind of text.',
    })
  } else if (share.size === 1 && hits.length > 1 && fieldStats(hits).filter((f) => f.field !== '(knn)').length > 1) {
    out.push({ id: 'dominant-field', severity: 'info', title: `Only ${[...share.keys()][0]} scores in the top ${k}`, detail: 'Matches on other fields do not reach these results.' })
  }

  // Boost swamping: does removing a boost reorder the top?
  const baseOrder = replay(hits, {}).map((r) => r.id)
  for (const f of fieldStats(hits)) {
    if (f.observedBoost < 3 || !f.field || f.field === '(knn)') continue
    const flat = replay(hits, { fieldBoost: { [f.field]: 1 / f.observedBoost } }).map((r) => r.id)
    const moved = baseOrder.slice(0, k).filter((id, i) => flat[i] !== id).length
    if (moved) {
      out.push({
        id: `boost-swamp-${f.field}`, severity: 'critical',
        title: `${f.field}^${f.observedBoost} is swamping other clauses`,
        detail: `Removing this boost changes ${moved} of the top ${k} positions and puts ${flat[0]} first. BM25 scores are unbounded, so a large multiplier on one field overrides how well the rest of the document matches.`,
        fix: `Start near ${f.field}^${Math.max(1.5, Math.round(Math.sqrt(f.observedBoost) * 10) / 10)} and measure with judgments.`,
      })
    }
  }
  const obs = observedParams(hits)
  if (obs.hasFunctions) {
    const uplift = top.map((h) => attribute(h.root).filter((c) => c.kind === 'function').reduce((a, c) => a + c.value, 0) / (h.score || 1))
    const avg = uplift.reduce((a, b) => a + b, 0) / (uplift.length || 1)
    const noFn = replay(hits, { maxBoost: 1 })
    const movedByCap = baseOrder.slice(0, k).filter((id, i) => noFn[i].id !== id).length
    if (avg >= 0.4) {
      out.push({
        id: 'function-swamp', severity: avg >= 0.6 ? 'critical' : 'warning',
        title: `function_score adds ${Math.round(avg * 100)}% of the score on average`,
        detail: `Text relevance is a minority partner in the top ${k}. Capping the multiplier at 1 ${movedByCap ? `changes ${movedByCap} of those positions and puts ${noFn[0].id} first` : 'leaves those positions unchanged, so the text clauses need fixing as well'}.`,
        fix: 'Set max_boost, lower factor, or switch boost_mode to sum so popularity cannot multiply a weak text match.',
      })
    }
  }

  // IDF skew between shards.
  const seen = new Map<string, { idf: number; n?: number; N?: number; shard?: string }[]>()
  for (const h of hits) {
    for (const nd of bm25Nodes(h.root)) {
      const t = nd.bm25!
      const key = `${t.field}:${t.term}`
      if (!seen.has(key)) seen.set(key, [])
      seen.get(key)!.push({ idf: t.idf, n: t.n, N: t.N, shard: h.shard })
    }
  }
  let worst: { key: string; min: number; max: number; rows: { n?: number; N?: number; shard?: string }[] } | undefined
  for (const [key, rows] of seen) {
    const min = Math.min(...rows.map((r) => r.idf))
    const max = Math.max(...rows.map((r) => r.idf))
    if (rows.length > 1 && min > 0 && (max - min) / min >= 0.05 && (!worst || max / min > worst.max / worst.min)) worst = { key, min, max, rows }
  }
  if (worst) {
    const shards = new Set(worst.rows.map((r) => r.shard).filter(Boolean)).size
    const Ns = worst.rows.map((r) => r.N).filter((v): v is number => v != null)
    const small = Ns.length ? Math.max(...Ns) < 10000 : false
    out.push({
      id: 'idf-skew', severity: worst.max / worst.min > 1.25 ? 'critical' : 'warning',
      title: `IDF for ${worst.key} varies ${Math.round((worst.max / worst.min - 1) * 100)}% between hits`,
      detail: `The same term scores between IDF ${worst.min.toFixed(2)} and ${worst.max.toFixed(2)}${shards > 1 ? ` across ${shards} shards` : ''}. IDF comes from each shard's local statistics, so identical documents can score differently${small ? ', and these document counts are small enough for skew to bite' : ''}. Deleted documents and replicas that have merged differently can cause this too.`,
      fix: 'Try "search_type": "dfs_query_then_fetch" to test whether global statistics fix it. For good, index more data or use fewer shards.',
    })
  }

  // Scale mismatch in sum-of-scores hybrid.
  let textSum = 0
  let knnSum = 0
  for (const h of top) {
    for (const c of attribute(h.root)) {
      if (c.kind === 'bm25') textSum += c.value
      if (c.kind === 'knn') knnSum += c.value
    }
  }
  if (knnSum > 0 && textSum > 0 && textSum / knnSum >= 3) {
    out.push({
      id: 'hybrid-scale', severity: 'critical',
      title: `BM25 outweighs kNN ${(textSum / knnSum).toFixed(0)}× in this summed score`,
      detail: 'A query plus top-level knn adds raw scores together. Cosine similarity tops out at 1, while BM25 is unbounded, so vectors can only break ties.',
      fix: 'Use an rrf retriever, or a linear retriever with a normalizer, and see the Hybrid tab.',
    })
  }

  // Analyzer mismatch.
  const terms = new Set([...seen.keys()].flatMap((key) => key.slice(key.indexOf(':') + 1).split(/ \| | /)))
  if (o.analyzeTokens?.length) {
    const toks = o.analyzeTokens
    const missing = toks.filter((t) => !terms.has(t))
    const near = missing.map((t) => ({ t, match: [...terms].find((x) => commonPrefix(t, x) >= Math.min(4, Math.min(t.length, x.length) - 1)) })).filter((x) => x.match)
    if (near.length) {
      out.push({
        id: 'analyzer-mismatch', severity: 'critical',
        title: `Query analyzer and index tokens disagree: "${near[0].t}" vs "${near[0].match}"`,
        detail: `_analyze produced ${near.map((x) => `"${x.t}"`).join(', ')}, but the explain output scored ${near.map((x) => `"${x.match}"`).join(', ')}. The analyzer you tested is not the one this field uses, so you may be debugging the wrong token stream.`,
        fix: 'Run _analyze with "field": "<field>" instead of "analyzer": "...", so that it uses the field\'s real search analyzer.',
      })
    }
    const none = missing.filter((t) => !near.some((x) => x.t === t))
    if (none.length) {
      out.push({
        id: 'analyzer-missing', severity: 'warning',
        title: `Tokens with no score in any returned hit: ${none.slice(0, 5).join(', ')}`,
        detail: 'These query tokens did not contribute to any explained document. Either no document contains them, or index-time analysis produces something else (stemming, synonyms, stop words, decompounding).',
        fix: 'Analyze a document field that should match, and compare the tokens side by side.',
      })
    }
  }
  if (o.mapping) {
    const scored = [...new Set([...seen.keys()].map((key) => key.slice(0, key.indexOf(':'))))]
    const analyzers = new Map<string, string[]>()
    for (const name of scored) {
      const m = o.mapping[name]
      if (!m) continue
      const a = m.search_analyzer ?? m.analyzer ?? (m.type === 'keyword' ? '(keyword: not analyzed)' : 'standard')
      analyzers.set(a, [...(analyzers.get(a) ?? []), name])
      if (m.search_analyzer && m.analyzer && m.search_analyzer !== m.analyzer) {
        out.push({ id: `search-analyzer-${name}`, severity: 'info', title: `${name} searches with ${m.search_analyzer} but indexes with ${m.analyzer}`, detail: 'Often deliberate, as with edge n-grams or synonyms at search time. Check it when tokens fail to match.' })
      }
      if (m.norms === false) {
        out.push({ id: `no-norms-${name}`, severity: 'info', title: `${name} has norms disabled`, detail: 'Length normalization is off for this field. b has no effect on it.' })
      }
    }
    if (analyzers.size > 1) {
      out.push({
        id: 'analyzer-fields', severity: 'warning',
        title: `Queried fields use ${analyzers.size} analyzers`,
        detail: [...analyzers].map(([a, fs]) => `${a}: ${fs.join(', ')}`).join('; ') + '. One query string yields different terms per field, so per-field scores are not directly comparable and cross_fields needs a shared analyzer.',
      })
    }
  }

  return out.sort((a, b) => rank(a) - rank(b))
}

const rank = (l: Lint) => ({ critical: 0, warning: 1, info: 2 })[l.severity]

// ---- Tuned query -----------------------------------------------------------------------

export function tunedQuery(hits: Hit[], p: Params, opts: { queryText?: string; original?: string } = {}): string {
  const stats = fieldStats(hits).filter((f) => f.field !== '(knn)')
  const fieldsOut = stats.map((f) => {
    const b = f.observedBoost * (p.fieldBoost?.[f.field] ?? 1)
    return Math.abs(b - 1) < 0.005 ? f.field : `${f.field}^${+b.toFixed(2)}`
  })
  const obs = observedParams(hits)
  const terms = [...new Set(hits.flatMap((h) => attribute(h.root)).filter((c) => c.term).map((c) => c.term!))]
  let body: any
  if (opts.original?.trim()) {
    try {
      body = patch(JSON.parse(opts.original), stats, p)
    } catch {
      body = null
    }
  }
  if (!body) {
    const mm: any = { query: opts.queryText || terms.join(' '), fields: fieldsOut, type: obs.hasTie ? 'best_fields' : 'most_fields' }
    if (obs.hasTie && (p.tie ?? obs.tie)) mm.tie_breaker = +(p.tie ?? obs.tie).toFixed(2)
    const q: any = { multi_match: mm }
    body = {
      query: obs.hasFunctions
        ? { function_score: { query: q, max_boost: +(p.maxBoost ?? obs.maxUplift).toFixed(2), boost_mode: 'multiply' } }
        : q,
      explain: true,
    }
  }
  const changedSim = (p.k1 != null && Math.abs(p.k1 - obs.k1) > 1e-4) || (p.b != null && Math.abs(p.b - obs.b) > 1e-4)
  const lines = [`POST /<index>/_search`, JSON.stringify(body, null, 2)]
  if (changedSim) {
    lines.push('', `# k1 and b live in index settings, not the query. A new index:`, `PUT /<new-index>`, JSON.stringify({
      settings: { index: { similarity: { tuned_bm25: { type: 'BM25', k1: +(p.k1 ?? obs.k1).toFixed(3), b: +(p.b ?? obs.b).toFixed(3) } } } },
      mappings: { properties: Object.fromEntries(stats.map((f) => [f.field, { type: 'text', similarity: 'tuned_bm25' }])) },
    }, null, 2))
  }
  return lines.join('\n')
}

function patch(q: any, stats: { field: string; observedBoost: number }[], p: Params): any {
  if (Array.isArray(q)) return q.map((x) => patch(x, stats, p))
  if (q == null || typeof q !== 'object') return q
  const o: any = {}
  for (const [k, v] of Object.entries(q)) {
    if (k === 'fields' && Array.isArray(v)) {
      o.fields = v.map((f: unknown) => {
        if (typeof f !== 'string') return f
        const [name] = f.split('^')
        const st = stats.find((s) => s.field === name)
        const m = p.fieldBoost?.[name]
        if (!st || m == null) return f
        const b = +(st.observedBoost * m).toFixed(2)
        return b === 1 ? name : `${name}^${b}`
      })
    } else if (k === 'max_boost' && p.maxBoost != null) o.max_boost = +p.maxBoost.toFixed(2)
    else if (k === 'tie_breaker' && p.tie != null) o.tie_breaker = +p.tie.toFixed(2)
    else {
      o[k] = patch(v, stats, p)
      // The knob may be new to this query, so add it rather than only replacing an existing value.
      if ((k === 'multi_match' || k === 'dis_max') && p.tie != null && o[k] && typeof o[k] === 'object') o[k].tie_breaker = +p.tie.toFixed(2)
      if (k === 'function_score' && p.maxBoost != null && o[k] && typeof o[k] === 'object') o[k].max_boost = +p.maxBoost.toFixed(2)
    }
  }
  return o
}

export const SIMILARITY_NOTE = 'Elastic documents closing the index to change the default similarity, then reopening it. Existing fields cannot switch to a different named similarity without a new field and reindex. Norms do not store k1 or b, so a parameter-only change should not need re-encoding of existing documents, but test it on a copy first.'
