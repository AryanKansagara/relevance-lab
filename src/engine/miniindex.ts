// In-browser BM25 index. Emits the same explanation JSON that Elasticsearch does, so the
// rest of the app treats it exactly like a pasted response.
import type { RawExplanation } from './explain.ts'

const f = (x: number) => +Math.fround(x).toPrecision(8)

// Lucene SmallFloat: norms store field length in one byte, which is why long fields report approximate dl.
const NUM_FREE_VALUES = 24
function longToInt4(i: number) {
  const numBits = i === 0 ? 0 : Math.floor(Math.log2(i)) + 1
  if (numBits < 4) return i
  const shift = numBits - 4
  return (Math.floor(i / 2 ** shift) & 7) | ((shift + 1) << 3)
}
function int4ToLong(i: number) {
  const shift = (i >>> 3) - 1
  return shift === -1 ? i & 7 : ((i & 7) | 8) * 2 ** shift
}
export function encodeNorm(dl: number) {
  return dl < NUM_FREE_VALUES ? dl : NUM_FREE_VALUES + longToInt4(dl - NUM_FREE_VALUES)
}
export function decodeNorm(b: number) {
  return b < NUM_FREE_VALUES ? b : NUM_FREE_VALUES + int4ToLong(b - NUM_FREE_VALUES)
}

export type Analyzer = 'standard' | 'english'

const STOP = new Set('a an and are as at be but by for if in into is it no not of on or such that the their then there these they this to was will with'.split(' '))

/** Lucene's EnglishMinimalStemmer. */
function minimalStem(s: string) {
  const n = s.length
  if (n < 3 || s[n - 1] !== 's') return s
  switch (s[n - 2]) {
    case 'u':
    case 's':
      return s
    case 'e':
      if (n > 3 && s[n - 3] === 'i' && s[n - 4] !== 'a' && s[n - 4] !== 'e') return s.slice(0, n - 3) + 'y'
      if ('iaoe'.includes(s[n - 3])) return s
  }
  return s.slice(0, n - 1)
}

export function analyze(text: string, analyzer: Analyzer = 'standard'): string[] {
  // Regex word split, close to UAX#29 for Latin text. Port a segmenter if non-Latin corpora matter.
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+(?:['._][\p{L}\p{N}]+)*/gu) ?? []
  if (analyzer === 'standard') return tokens
  return tokens.map((t) => t.replace(/'s$/, '')).filter((t) => !STOP.has(t)).map(minimalStem)
}

export interface TermInput {
  field: string
  term: string
  docId: number
  freq: number
  n: number
  N: number
  dl: number
  avgdl: number
  queryBoost: number
  k1: number
  b: number
}

/** Exact shape of an ES 8/9 BM25 term explanation. */
export function explainTerm(t: TermInput): RawExplanation {
  const norm = encodeNorm(t.dl)
  const dl = decodeNorm(norm)
  const idf = Math.log(1 + (t.N - t.n + 0.5) / (t.n + 0.5))
  const tf = t.freq / (t.freq + t.k1 * (1 - t.b + (t.b * dl) / t.avgdl))
  const boost = t.queryBoost * (t.k1 + 1)
  const fr = t.freq.toFixed(1)
  return {
    value: f(boost * idf * tf),
    description: `weight(${t.field}:${t.term} in ${t.docId}) [PerFieldSimilarity], result of:`,
    details: [{
      value: f(boost * idf * tf),
      description: `score(freq=${fr}), computed as boost * idf * tf from:`,
      details: [
        { value: f(boost), description: 'boost', details: [] },
        {
          value: f(idf),
          description: 'idf, computed as log(1 + (N - n + 0.5) / (n + 0.5)) from:',
          details: [
            { value: t.n, description: 'n, number of documents containing term', details: [] },
            { value: t.N, description: 'N, total number of documents with field', details: [] },
          ],
        },
        {
          value: f(tf),
          description: 'tf, computed as freq / (freq + k1 * (1 - b + b * dl / avgdl)) from:',
          details: [
            { value: t.freq, description: `termFreq=${fr}`, details: [] },
            { value: t.k1, description: 'k1, term saturation parameter', details: [] },
            { value: t.b, description: 'b, length normalization parameter', details: [] },
            { value: dl, description: norm > 39 ? 'dl, length of field (approximate)' : 'dl, length of field', details: [] },
            { value: f(t.avgdl), description: 'avgdl, average length of field', details: [] },
          ],
        },
      ],
    }],
  }
}

export interface Doc { id: string; source: Record<string, unknown>; fields: Record<string, string[]> }

export interface MiniIndex {
  docs: Doc[]
  fields: string[]
  analyzer: Analyzer
  stats: Record<string, { docCount: number; sumDl: number; df: Map<string, number> }>
}

export function parseDocs(text: string): Record<string, unknown>[] {
  const t = text.trim()
  if (!t) throw new Error('Paste a JSON array of documents, or NDJSON with one document per line.')
  let raw: unknown
  try {
    raw = JSON.parse(t)
  } catch {
    try {
      raw = t.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))
    } catch (e) {
      throw new Error(`Could not parse as JSON or NDJSON: ${(e as Error).message}`)
    }
  }
  const hits = (raw as any)?.hits?.hits
  const arr = Array.isArray(raw) ? raw : hits ? hits : [raw]
  const docs = arr.map((d: any) => (d && typeof d === 'object' && d._source ? { _id: d._id, ...d._source } : d))
  if (!docs.length || docs.some((d: unknown) => d == null || typeof d !== 'object' || Array.isArray(d))) throw new Error('Every document must be a JSON object.')
  return docs.slice(0, 5000)
}

export function buildIndex(sources: Record<string, unknown>[], analyzer: Analyzer = 'standard'): MiniIndex {
  const fieldSet = new Set<string>()
  const docs: Doc[] = sources.map((s, i) => {
    const fields: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(s)) {
      if (k === 'id' || k === '_id') continue
      const text = typeof v === 'string' ? v : Array.isArray(v) && v.every((x) => typeof x === 'string') ? v.join(' ') : null
      if (text == null) continue
      const tokens = analyze(text, analyzer)
      if (tokens.length) {
        fields[k] = tokens
        fieldSet.add(k)
      }
    }
    return { id: String(s._id ?? s.id ?? i + 1), source: s, fields }
  })
  const stats: MiniIndex['stats'] = {}
  for (const name of fieldSet) stats[name] = { docCount: 0, sumDl: 0, df: new Map() }
  for (const d of docs) {
    for (const [name, tokens] of Object.entries(d.fields)) {
      const st = stats[name]
      st.docCount++
      st.sumDl += tokens.length
      for (const t of new Set(tokens)) st.df.set(t, (st.df.get(t) ?? 0) + 1)
    }
  }
  return { docs, fields: [...fieldSet], analyzer, stats }
}

export interface SearchOptions {
  query: string
  fields: Record<string, number>
  type?: 'best_fields' | 'most_fields'
  tie?: number
  k1?: number
  b?: number
  size?: number
}

/** multi_match over the index. Returns an Elasticsearch search response with explain: true. */
export function search(ix: MiniIndex, o: SearchOptions) {
  const started = performance.now()
  const k1 = o.k1 ?? 1.2
  const b = o.b ?? 0.75
  const terms = [...new Set(analyze(o.query, ix.analyzer))]
  const type = o.type ?? 'best_fields'
  const tie = o.tie ?? 0
  const scored: { doc: Doc; docId: number; exp: RawExplanation }[] = []
  ix.docs.forEach((doc, docId) => {
    const clauses: RawExplanation[] = []
    for (const [field, queryBoost] of Object.entries(o.fields)) {
      const tokens = doc.fields[field]
      const st = ix.stats[field]
      if (!tokens || !st || queryBoost <= 0) continue
      const parts = terms.flatMap((term) => {
        const freq = tokens.reduce((a, t) => a + (t === term ? 1 : 0), 0)
        if (!freq) return []
        return [explainTerm({ field, term, docId, freq, n: st.df.get(term) ?? 1, N: st.docCount, dl: tokens.length, avgdl: st.sumDl / st.docCount, queryBoost, k1, b })]
      })
      if (parts.length === 1) clauses.push(parts[0])
      else if (parts.length) clauses.push({ value: f(parts.reduce((a, p) => a + p.value, 0)), description: 'sum of:', details: parts })
    }
    if (!clauses.length) return
    let exp: RawExplanation
    if (clauses.length === 1) exp = clauses[0]
    else if (type === 'most_fields') exp = { value: f(clauses.reduce((a, c) => a + c.value, 0)), description: 'sum of:', details: clauses }
    else {
      const vals = clauses.map((c) => c.value)
      const best = Math.max(...vals)
      const value = best + tie * (vals.reduce((a, v) => a + v, 0) - best)
      exp = { value: f(value), description: tie ? `max plus ${tie} times others of:` : 'max of:', details: clauses }
    }
    scored.push({ doc, docId, exp })
  })
  scored.sort((x, y) => y.exp.value - x.exp.value || x.docId - y.docId)
  return {
    took: Math.round(performance.now() - started),
    timed_out: false,
    _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
    hits: {
      total: { value: scored.length, relation: 'eq' },
      max_score: scored[0]?.exp.value ?? null,
      hits: scored.slice(0, o.size ?? 10).map((s) => ({
        _shard: '[mini][0]',
        _node: 'browser',
        _index: 'mini',
        _id: s.doc.id,
        _score: s.exp.value,
        _source: s.doc.source,
        _explanation: s.exp,
      })),
    },
  }
}
