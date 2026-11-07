// Parses Elasticsearch explanation trees (search `explain: true`, `_explain`, retriever responses)
// into a typed tree. Description strings follow Lucene's BM25Similarity / ES LegacyBM25Similarity,
// FunctionScoreQuery, ToParentBlockJoinQuery, FeatureField, RRFRankDoc and LinearRankDoc.

export interface RawExplanation { value: number; description: string; details?: RawExplanation[]; match?: boolean }

export type NodeKind =
  | 'bm25' | 'sum' | 'max' | 'product' | 'min' | 'avg' | 'nested' | 'function' | 'maxBoost'
  | 'constant' | 'knn' | 'rankFeature' | 'rrf' | 'rrfSource' | 'linear' | 'linearSource'
  | 'wrapper' | 'noMatch' | 'opaque'

export interface Bm25 {
  field: string
  term: string
  phrase: boolean
  freq: number
  idf: number
  n?: number
  N?: number
  k1: number
  b: number
  dl: number
  dlApprox: boolean
  avgdl: number
  /** User-visible boost, excluding the (k1 + 1) that ES folds into the Lucene `boost` node. */
  queryBoost: number
  /** Whether the score carries the (k1 + 1) numerator (true for every BM25 shape ES emits). */
  k1Numerator: boolean
  format: 'modern' | 'tfNorm'
}

export interface ENode {
  id: string
  kind: NodeKind
  value: number
  description: string
  label: string
  children: ENode[]
  bm25?: Bm25
  tie?: number
  /** Query index and rank for rrf / linear children. */
  source?: { index: number; name?: string; rank?: number; weight?: number; normalized?: number; normalizer?: string }
  rankConstant?: number
  feature?: { fn: string; field: string; feature: string }
  similarity?: number
  warning?: string
}

export class ExplainParseError extends Error {
  hint?: string
  constructor(message: string, hint?: string) {
    super(message)
    this.name = 'ExplainParseError'
    this.hint = hint
  }
}

const NUM = '(-?[\\d.]+(?:[eE][-+]?\\d+)?|NaN|Infinity)'
const close = (a: number, b: number, tol = 0.002) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b))

export function parseQueryText(q: string): { field: string; term: string; phrase: boolean } {
  const syn = q.match(/^Synonym\((.+)\)$/)
  if (syn) {
    const parts = syn[1].trim().split(/\s+/).map((p) => p.split(':'))
    return { field: parts[0][0], term: parts.map((p) => p.slice(1).join(':')).join(' | '), phrase: false }
  }
  const m = q.match(/^([^:\s(]+):(.+)$/s)
  if (!m) return { field: '(unknown)', term: q, phrase: false }
  const phrase = /^".*"$/s.test(m[2])
  return { field: m[1], term: m[2].replace(/^"|"$/g, ''), phrase }
}

function findChild(n: RawExplanation, re: RegExp) {
  return n.details?.find((d) => re.test(d.description))
}

function parseBm25(raw: RawExplanation, qText: string): Bm25 | string {
  const score = raw.details?.[0]
  if (!score || !/^score\(/.test(score.description)) return `no score(...) child under "${raw.description}"`
  const idfNode = findChild(score, /^idf\b/)
  if (!idfNode) return `no idf node (similarity is not BM25?)`
  const tfNode = findChild(score, /^tf,/)
  const tfNorm = findChild(score, /^tfNorm\b/)
  const boostNode = findChild(score, /^boost$/)
  const { field, term, phrase } = parseQueryText(qText)
  const sub = tfNode ?? tfNorm
  if (!sub) return `no tf / tfNorm node`
  const freqNode = findChild(sub, /^(termFreq|phraseFreq|freq)\b/)
  const k1 = (findChild(sub, /^(k1,|parameter k1)/))?.value
  const b = (findChild(sub, /^(b,|parameter b\b)/))?.value
  const avg = findChild(sub, /^(avgdl|avgFieldLength)\b/)?.value
  const dlNode = findChild(sub, /^(dl,|fieldLength)/)
  const noB = !!findChild(sub, /parameter b is 0/)
  if (freqNode == null || k1 == null) return `tf node missing freq or k1`
  const bv = noB ? 0 : b
  if (bv == null) return `tf node missing b`
  if (bv !== 0 && (avg == null || dlNode == null)) return `tf node missing dl or avgdl`
  const dfNode = findChild(idfNode, /^(n,|docFreq)/)
  const dcNode = findChild(idfNode, /^(N,|docCount)/)
  let n = dfNode?.value
  let N = dcNode?.value
  if (n == null) {
    // Phrase: "idf, sum of:" with one idf(docFreq=.., docCount=..) per term; keep the rarest for display.
    const parts = (idfNode.details ?? []).map((d) => d.details ?? [])
    if (parts.length) {
      n = Math.min(...parts.map((p) => p.find((x) => /^(n,|docFreq)/.test(x.description))?.value ?? Infinity))
      N = parts[0].find((x) => /^(N,|docCount)/.test(x.description))?.value
      if (!Number.isFinite(n)) n = undefined
    }
  }
  const legacy = !!tfNorm
  const rawBoost = boostNode?.value ?? 1
  // ES wraps Lucene BM25 in LegacyBM25Similarity which multiplies boost by (k1 + 1), so an unboosted
  // clause explains as boost = 2.2. tfNorm-era output (ES 5/6) has k1 + 1 in tfNorm instead.
  const k1Numerator = legacy || !!boostNode
  const queryBoost = legacy || !boostNode ? rawBoost : rawBoost / (k1 + 1)
  return {
    field, term, phrase,
    freq: freqNode.value, idf: idfNode.value, n, N, k1, b: bv,
    dl: dlNode?.value ?? avg ?? 1,
    dlApprox: !!dlNode && /approximate/.test(dlNode.description),
    avgdl: avg ?? 1,
    queryBoost: +queryBoost.toPrecision(6),
    k1Numerator,
    format: legacy ? 'tfNorm' : 'modern',
  }
}

export function bm25Score(t: Pick<Bm25, 'freq' | 'idf' | 'dl' | 'avgdl' | 'queryBoost' | 'k1Numerator'>, k1: number, b: number, fieldBoost = 1) {
  const norm = k1 * (1 - b + (b * t.dl) / t.avgdl)
  const tf = t.freq / (t.freq + norm)
  return t.queryBoost * fieldBoost * (t.k1Numerator ? k1 + 1 : 1) * t.idf * tf
}

const CLASSIC = /^(fieldWeight in|queryWeight,|fieldNorm\(|tf\(freq=|idf\(docFreq=.*maxDocs)/

export function parseNode(raw: RawExplanation, path = '0', inFunction = false): ENode {
  if (raw == null || typeof raw !== 'object' || typeof raw.description !== 'string' || typeof raw.value !== 'number') {
    throw new ExplainParseError(`Explanation node at ${path} is not {value, description, details}.`)
  }
  const d = raw.description.trim()
  if (CLASSIC.test(d)) {
    throw new ExplainParseError(
      `Unsupported similarity at node ${path}: "${d.slice(0, 80)}" is classic TF-IDF.`,
      'Classic TF/IDF was removed in Elasticsearch 7. BM25 replay would be wrong for it, so nothing is computed.',
    )
  }
  const base = { id: path, value: raw.value, description: raw.description }
  const kids = (fn = inFunction) => (raw.details ?? []).map((c, i) => parseNode(c, `${path}.${i}`, fn))
  let m: RegExpMatchArray | null

  if ((m = d.match(/^weight\((.+) in \d+\) \[.*\], result of:?$/s))) {
    const q = parseBm25(raw, m[1])
    const leafKids = () => (raw.details ?? []).map((c, i) => parseOpaqueSubtree(c, `${path}.${i}`))
    if (typeof q === 'string') {
      return { ...base, kind: 'opaque', label: m[1], children: leafKids(), warning: `Non-BM25 scoring in weight(${m[1]}): ${q}. Kept as a fixed value, not replayed.` }
    }
    const check = bm25Score(q, q.k1, q.b)
    const warning = close(check, raw.value, 0.01) ? undefined : `BM25 arithmetic mismatch: recomputed ${check.toFixed(4)}, ES reports ${raw.value.toFixed(4)}.`
    return { ...base, kind: 'bm25', label: `${q.field}:${q.term}`, children: leafKids(), bm25: q, warning }
  }
  if (/^(sum of:?|sum of|function score, score mode \[sum\].*)$/.test(d)) return agg('sum')
  if (/^(max of:?|function score, score mode \[max\].*)$/.test(d)) return agg('max')
  if ((m = d.match(new RegExp(`^max plus ${NUM} times others of:?$`)))) return { ...agg('max'), tie: +m[1] }
  if (/^(product of:?|function score, product of:?|function score, score mode \[multiply\].*|match on required clause, product of:?)$/.test(d)) return agg('product')
  if (/^(min of:?|function score, score mode \[min\].*)$/.test(d)) return agg('min')
  if (/^(avg of:?|function score, score mode \[avg\].*)$/.test(d)) return agg('avg')
  if (/^maxBoost$/.test(d)) return { ...base, kind: 'maxBoost', label: 'max_boost', children: [] }
  if (/^(field value function|Function for field|script score function|random score function|weight$|match filter:|queryBoost|Math\.|exp\(|gauss|linear\(|_score:|function score, no filter match|function score, no function match|function score, score mode)/i.test(d)) {
    return { ...base, kind: 'function', label: functionLabel(d), children: (raw.details ?? []).map((c, i) => parseOpaqueSubtree(c, `${path}.${i}`)) }
  }
  if ((m = d.match(/^Score based on (?:(\d+) child docs? in range from \d+ to \d+, using score mode (\w+)|child doc range from \d+ to \d+, best match:?)/))) {
    return { ...base, kind: 'nested', label: m[1] ? `nested: ${m[1]} child docs (${m[2]})` : 'nested: best child', children: kids() }
  }
  if ((m = d.match(/^(Saturation|Log|Sigmoid|Linear) function on the (\S+) field for the (.+) feature, computed as/))) {
    return { ...base, kind: 'rankFeature', label: `${m[1].toLowerCase()}(${m[2]}.${m[3]})`, feature: { fn: m[1].toLowerCase(), field: m[2], feature: m[3] }, children: (raw.details ?? []).map((c, i) => parseOpaqueSubtree(c, `${path}.${i}`)) }
  }
  if (/^within top k documents/.test(d)) return { ...base, kind: 'knn', label: 'kNN (within top k)', similarity: raw.value, children: [] }
  if ((m = d.match(new RegExp(`^found vector with calculated similarity: ${NUM}`)))) {
    return { ...base, kind: 'knn', label: 'kNN vector similarity', similarity: +m[1], children: [] }
  }
  if ((m = d.match(new RegExp(`^rrf score: \\[${NUM}\\] computed for initial ranks \\[[^\\]]*\\] with rankConstant: \\[(\\d+)\\]`)))) {
    return { ...base, kind: 'rrf', label: 'RRF fusion', rankConstant: +m[2], children: kids() }
  }
  if ((m = d.match(/^rrf score: \[0(?:\.0)?\], result not found in query at index \[(\d+)\]/))) {
    return { ...base, kind: 'noMatch', label: `not in retriever ${m[1]}`, source: { index: +m[1] }, children: [] }
  }
  if ((m = d.match(new RegExp(`^rrf score: \\[${NUM}\\], for rank \\[(\\d+)\\] in query at index \\[(\\d+)\\](?: \\[([^\\]]+)\\])?`)))) {
    const children = kids()
    return { ...base, kind: 'rrfSource', label: `${retrieverName(+m[3], m[4], children)} rank ${m[2]}`, source: { index: +m[3], name: m[4], rank: +m[2] }, children }
  }
  if (/^weighted linear combination score/.test(d)) {
    return { ...base, kind: 'linear', label: 'Linear fusion', children: kids() }
  }
  if ((m = d.match(/^weighted score: \[0(?:\.0)?\], result not found in query at index \[(\d+)\]/))) {
    return { ...base, kind: 'noMatch', label: `not in retriever ${m[1]}`, source: { index: +m[1] }, children: [] }
  }
  if ((m = d.match(new RegExp(`^weighted score: \\[${NUM}\\] in query at index \\[(\\d+)\\](?: \\[([^\\]]+)\\])? computed as \\[${NUM} \\* ${NUM}\\](?: using score normalizer \\[(\\w+)\\])?`)))) {
    const children = kids()
    return { ...base, kind: 'linearSource', label: `${retrieverName(+m[2], m[3], children)}: ${m[4]} × ${(+m[5]).toFixed(3)}`, source: { index: +m[2], name: m[3], weight: +m[4], normalized: +m[5], normalizer: m[6] }, children }
  }
  if (/^doc \[\d+\] with an original score of/.test(d)) return { ...base, kind: 'wrapper', label: 'retriever rank doc', children: kids() }
  if (/^(ConstantScore\(|MatchAllDocsQuery|\*:\*|# clause|_name:|DocValuesFieldExistsQuery|FieldExistsQuery|IndexOrDocValuesQuery|range\b|[\w.]+:\[.+ TO .+\])/.test(d)) {
    return { ...base, kind: 'constant', label: d.replace(/^ConstantScore\((.*)\)(\^.*)?$/s, '$1').slice(0, 60), children: (raw.details ?? []).map((c, i) => parseOpaqueSubtree(c, `${path}.${i}`)) }
  }
  if (raw.value === 0 || raw.match === false || /^(no match|no matching|Failure to meet|No matching|MatchNoDocsQuery|not in )/i.test(d)) {
    return { ...base, kind: 'noMatch', label: d.slice(0, 80), children: [] }
  }
  if (inFunction) return { ...base, kind: 'function', label: functionLabel(d), children: (raw.details ?? []).map((c, i) => parseOpaqueSubtree(c, `${path}.${i}`)) }
  return { ...base, kind: 'opaque', label: d.slice(0, 80), children: (raw.details ?? []).map((c, i) => parseOpaqueSubtree(c, `${path}.${i}`)), warning: `Unrecognised explanation node "${d.slice(0, 120)}". Shown at its reported value and not attributed further.` }

  function agg(kind: 'sum' | 'max' | 'product' | 'min' | 'avg'): ENode {
    const children = kids(inFunction || /^function score/.test(d))
    return { ...base, kind, label: d.replace(/:$/, ''), children, warning: aggregateWarning(kind, raw.value, children) }
  }
}

function retrieverName(index: number, name: string | undefined, children: ENode[]) {
  const hasKnn = (n: ENode): boolean => n.kind === 'knn' || n.children.some(hasKnn)
  return `${name ?? (children.some(hasKnn) ? 'vector' : 'keyword')} retriever [${index}]`
}

function functionLabel(d: string) {
  return d.replace(/^field value function: /i, '').replace(/^Function for field (.+):$/, 'decay($1)').replace(/, computed with script:.*/s, '').slice(0, 72)
}

/** Keep inner stats visible in the tree without classifying them. */
function parseOpaqueSubtree(raw: RawExplanation, path: string): ENode {
  return {
    id: path, kind: 'constant', value: raw.value, description: raw.description, label: raw.description.replace(/:$/, '').slice(0, 72),
    children: (raw.details ?? []).map((c, i) => parseOpaqueSubtree(c, `${path}.${i}`)),
  }
}

function aggregateWarning(kind: string, value: number, c: ENode[]): string | undefined {
  if (!c.length) return `"${kind}" node has no children; cannot verify.`
  const v = c.map((x) => x.value)
  const expected =
    kind === 'sum' ? v.reduce((a, b) => a + b, 0)
    : kind === 'product' ? v.reduce((a, b) => a * b, 1)
    : kind === 'min' ? Math.min(...v)
    : kind === 'avg' ? v.reduce((a, b) => a + b, 0) / v.length
    : null
  if (expected != null && !close(expected, value, 0.01)) return `${kind} children give ${expected.toFixed(4)} but node reports ${value.toFixed(4)}. Treat attribution here with suspicion.`
  return undefined
}

// ---- Response shapes ------------------------------------------------------------------

export interface Hit {
  id: string
  index?: string
  shard?: string
  score: number
  source?: Record<string, unknown>
  root: ENode
  warnings: string[]
  rank: number
}

export interface ParsedResponse {
  shape: 'search' | 'explain-api' | 'bare-explanation' | 'hit-array'
  hits: Hit[]
  total?: number
  notes: string[]
}

function collectWarnings(n: ENode, out: string[] = []): string[] {
  if (n.warning) out.push(n.warning)
  n.children.forEach((c) => collectWarnings(c, out))
  return out
}

type RawHit = { _id?: unknown; _index?: string; _shard?: string; _score?: number | null; _source?: Record<string, unknown>; _explanation?: RawExplanation; explanation?: RawExplanation; fields?: Record<string, unknown>; matched?: boolean }

function toHit(h: RawHit, i: number): Hit {
  const exp = h._explanation ?? h.explanation
  const id = h._id == null ? `#${i + 1}` : String(h._id)
  if (!exp) {
    throw new ExplainParseError(`Hit "${id}" has no _explanation.`, 'Re-run the search with "explain": true at the top level of the body.')
  }
  const root = parseNode(exp)
  const warnings = collectWarnings(root)
  const score = h._score ?? root.value
  if (h._score != null && !close(h._score, root.value, 0.01)) {
    warnings.push(`_score ${h._score} differs from explanation ${root.value}: likely a rescore, a nested retriever or a post-processing step that the tree does not show.`)
  }
  return { id, index: h._index, shard: h._shard, score, source: h._source, root, warnings, rank: i + 1 }
}

export function parseResponse(input: string | unknown): ParsedResponse {
  let json: unknown = input
  if (typeof input === 'string') {
    const text = input.trim()
    if (!text) throw new ExplainParseError('Nothing to parse: the input is empty.')
    try {
      json = JSON.parse(text)
    } catch (e) {
      throw new ExplainParseError(`Not valid JSON: ${(e as Error).message}.`, 'Paste the raw response body. Dev Tools "Copy as cURL" output and console prefixes will not parse.')
    }
  }
  if (Array.isArray(json)) {
    if (!json.length) throw new ExplainParseError('The array is empty.')
    return { shape: 'hit-array', hits: json.map((h, i) => toHit(h as RawHit, i)), notes: [] }
  }
  if (json == null || typeof json !== 'object') throw new ExplainParseError('Expected a JSON object from Elasticsearch.')
  const o = json as Record<string, any>
  if (o.error) {
    const reason = o.error.root_cause?.[0]?.reason ?? o.error.reason ?? JSON.stringify(o.error).slice(0, 160)
    throw new ExplainParseError(`This is an Elasticsearch error response: ${reason}`, `Status ${o.status ?? 'unknown'}. Fix the request first.`)
  }
  if (Array.isArray(o.responses)) {
    if (o.responses.length !== 1) throw new ExplainParseError(`This is an _msearch response with ${o.responses.length} searches.`, 'Paste one element of "responses" so ranks are not mixed between queries.')
    return parseResponse(o.responses[0])
  }
  if (o.hits?.hits) {
    const raw: RawHit[] = o.hits.hits
    if (!raw.length) throw new ExplainParseError('The response has zero hits, so there is nothing to explain.', 'Check the query matches documents, or try _explain on a specific document ID.')
    if (raw.every((h) => h._score == null) && raw.some((h: any) => h.sort)) {
      throw new ExplainParseError('These hits are sorted by field with _score: null.', 'A custom sort means relevance score did not decide the order. Add "track_scores": true or remove the sort.')
    }
    const total = typeof o.hits.total === 'number' ? o.hits.total : o.hits.total?.value
    const notes: string[] = []
    if (o.hits.hits.length < (total ?? 0)) notes.push(`Response has ${raw.length} of ${total} matching docs. Replay can only reorder what was returned; raise "size" to see docs entering from below.`)
    return { shape: 'search', hits: raw.map((h, i) => toHit(h, i)), total, notes }
  }
  if ('matched' in o && ('explanation' in o || o.matched === false)) {
    if (!o.matched) throw new ExplainParseError(`_explain says document "${o._id}" does not match.`, o.explanation?.description ? `Reason: ${o.explanation.description}` : 'No score to analyze.')
    return { shape: 'explain-api', hits: [toHit(o as RawHit, 0)], notes: ['Single document from the _explain API. Compare and replay ranks need a search response with several hits.'] }
  }
  if (typeof o.value === 'number' && typeof o.description === 'string') {
    return { shape: 'bare-explanation', hits: [toHit({ _id: 'doc', explanation: o as RawExplanation }, 0)], notes: [] }
  }
  throw new ExplainParseError(
    `Unrecognised JSON shape (top-level keys: ${Object.keys(o).slice(0, 6).join(', ') || 'none'}).`,
    'Supported: a search response with hits.hits[]._explanation, an _explain API response, a bare {value, description, details} node, or an array of hits.',
  )
}

// ---- Attribution ----------------------------------------------------------------------

export type ContribKind = 'bm25' | 'knn' | 'feature' | 'function' | 'constant' | 'retriever' | 'opaque' | 'nested'

export interface Contribution {
  key: string
  kind: ContribKind
  label: string
  field?: string
  term?: string
  value: number
  /** Value the clause had before dis_max discarded it. */
  shadowed?: number
  bm25?: Bm25
  nodeId: string
  source?: ENode['source']
}

/** Split a score into additive steps: their values sum to the root score. */
export function attribute(root: ENode): Contribution[] {
  const out: Contribution[] = []
  walk(root, 1)
  return out

  function walk(n: ENode, m: number) {
    switch (n.kind) {
      case 'bm25':
        out.push({ key: `${n.bm25!.field}:${n.bm25!.term}`, kind: 'bm25', label: n.label, field: n.bm25!.field, term: n.bm25!.term, value: n.value * m, bm25: n.bm25, nodeId: n.id })
        return
      case 'knn':
        out.push({ key: 'knn', kind: 'knn', label: n.label, value: n.value * m, nodeId: n.id, field: '(knn)' })
        return
      case 'rankFeature':
        out.push({ key: n.label, kind: 'feature', label: n.label, value: n.value * m, nodeId: n.id, field: n.feature!.field })
        return
      case 'function':
      case 'maxBoost':
        out.push({ key: `fn:${n.label}`, kind: 'function', label: n.label, value: n.value * m, nodeId: n.id })
        return
      case 'constant':
        if (n.value) out.push({ key: `const:${n.label}`, kind: 'constant', label: n.label, value: n.value * m, nodeId: n.id })
        return
      case 'opaque':
        out.push({ key: `opaque:${n.id}`, kind: 'opaque', label: n.label, value: n.value * m, nodeId: n.id })
        return
      case 'noMatch':
        return
      case 'wrapper':
        n.children.forEach((c) => walk(c, m))
        return
      case 'rrf':
      case 'linear':
        n.children.forEach((c) => c.kind !== 'noMatch' && walk(c, m))
        return
      case 'rrfSource':
      case 'linearSource':
        out.push({ key: `retriever:${n.source!.index}`, kind: 'retriever', label: n.label, value: n.value * m, nodeId: n.id, source: n.source })
        return
      case 'sum':
        n.children.forEach((c) => walk(c, m))
        return
      case 'avg':
        n.children.forEach((c) => walk(c, m / n.children.length))
        return
      case 'max': {
        const best = n.children.reduce((a, b) => (b.value > a.value ? b : a), n.children[0])
        for (const c of n.children) {
          if (c === best) walk(c, m)
          else if (n.tie) walk(c, m * n.tie)
          else if (c.value > 0) shadow(c, m)
        }
        return
      }
      case 'min': {
        const best = n.children.reduce((a, b) => (b.value < a.value ? b : a), n.children[0])
        walk(best, m)
        return
      }
      case 'product': {
        if (!n.value) return
        const primary = primaryChild(n)
        if (!primary) {
          out.push({ key: `fn:${n.label}`, kind: 'function', label: n.label, value: n.value * m, nodeId: n.id })
          return
        }
        walk(primary, m)
        const factorNodes = n.children.filter((c) => c !== primary)
        const factor = factorNodes.reduce((a, b) => a * b.value, 1)
        if (factor !== 1) {
          const label = `× ${factor.toFixed(2)} ${factorLabel(factorNodes)}`
          out.push({ key: `fn:${factorLabel(factorNodes)}`, kind: 'function', label, value: primary.value * (factor - 1) * m, nodeId: factorNodes[0].id })
        }
        return
      }
      case 'nested': {
        const child = n.children[0]
        if (!child) {
          out.push({ key: 'nested', kind: 'nested', label: n.label, value: n.value * m, nodeId: n.id })
          return
        }
        walk(child, m)
        if (!close(child.value, n.value, 1e-4)) out.push({ key: 'nested', kind: 'nested', label: `${n.label}: adjustment`, value: (n.value - child.value) * m, nodeId: n.id })
      }
    }
  }

  function shadow(n: ENode, m: number) {
    const before = out.length
    walk(n, m)
    for (const c of out.slice(before)) {
      c.shadowed = c.value
      c.value = 0
    }
  }
}

function hasScoring(n: ENode): boolean {
  return ['bm25', 'knn', 'rankFeature', 'rrf', 'linear', 'opaque'].includes(n.kind) || (n.kind !== 'function' && n.children.some(hasScoring))
}

function primaryChild(n: ENode): ENode | undefined {
  return n.children.find(hasScoring)
}

function factorLabel(nodes: ENode[]): string {
  const find = (n: ENode): string | undefined => (n.kind === 'function' ? n.label : n.children.map(find).find(Boolean))
  return nodes.map(find).find(Boolean) ?? 'boost'
}

// ---- Verdict --------------------------------------------------------------------------

export interface TermFacts {
  tf: number
  saturation: number
  lengthNorm: number
  lengthEffect: number
}

/** saturation: how close to the tf ceiling (1 = ceiling). lengthEffect: score multiplier from dl vs avgdl. */
export function termFacts(t: Bm25, k1 = t.k1, b = t.b): TermFacts {
  const lengthNorm = 1 - b + (b * t.dl) / t.avgdl
  const tf = t.freq / (t.freq + k1 * lengthNorm)
  const neutral = t.freq / (t.freq + k1)
  return { tf, saturation: tf, lengthNorm, lengthEffect: tf / neutral }
}

export function fmt(n: number, d = 2) {
  if (!Number.isFinite(n)) return String(n)
  if (Math.abs(n) >= 100) return n.toFixed(1)
  if (n !== 0 && Math.abs(n) < 0.1) return n.toPrecision(3)
  return n.toFixed(d)
}

export function describeTerm(c: Contribution, score: number): string {
  const t = c.bm25!
  const facts = termFacts(t)
  const pct = score ? Math.round((c.value / score) * 100) : 0
  const rare = t.N && t.n != null ? ` matches ${t.n.toLocaleString('en-US')} of ${t.N.toLocaleString('en-US')} docs (IDF ${fmt(t.idf)})` : ` has IDF ${fmt(t.idf)}`
  const boost = t.queryBoost !== 1 ? ` Boost ×${fmt(t.queryBoost)} applies.` : ''
  const sat = `${t.freq} occurrence${t.freq === 1 ? ' reaches' : 's reach'} ${Math.round(facts.saturation * 100)}% of the TF ceiling.`
  const delta = Math.round((facts.lengthEffect - 1) * 100)
  const len = Math.abs(delta) < 2 ? 'Field length is near average, so length norm is neutral.'
    : `Field has ${t.dl}${t.dlApprox ? ' (approx.)' : ''} token${t.dl === 1 ? '' : 's'} vs ${fmt(t.avgdl, 1)} average, so length norm ${delta > 0 ? 'adds' : 'costs'} ${Math.abs(delta)}%.`
  return `${pct}% from "${t.term}" in ${t.field}. The term${rare}.${boost} ${sat} ${len}`
}

export interface Verdict {
  headline: string
  bullets: string[]
  byField: { field: string; value: number; pct: number }[]
}

export function verdict(hit: Hit): Verdict {
  const contribs = attribute(hit.root)
  const live = contribs.filter((c) => c.value !== 0)
  const score = hit.score || 1
  const groups = new Map<string, number>()
  for (const c of live) {
    const g = c.field ?? (c.kind === 'function' ? 'function_score' : c.kind === 'retriever' ? c.label : `(${c.kind})`)
    groups.set(g, (groups.get(g) ?? 0) + c.value)
  }
  const byField = [...groups].map(([field, value]) => ({ field, value, pct: (value / score) * 100 })).sort((a, b) => b.value - a.value)
  const top = byField[0]
  const bullets: string[] = []
  for (const c of [...live].sort((a, b) => b.value - a.value)) {
    if (c.kind === 'bm25') bullets.push(describeTerm(c, score))
    else if (c.kind === 'function') bullets.push(`${Math.round((c.value / score) * 100)}% from a function_score step: ${c.label}. It is multiplied or added after text scoring, so no term in the document caused it.`)
    else if (c.kind === 'knn') bullets.push(`${Math.round((c.value / score) * 100)}% from vector similarity (${fmt(c.value, 3)}). Cosine and dot-product scores live in 0 to 1, which is why BM25 can swamp them.`)
    else if (c.kind === 'retriever') bullets.push(`${Math.round((c.value / score) * 100)}% from ${c.label}. RRF uses this rank only and ignores the raw score.`)
    else if (c.kind === 'feature') bullets.push(`${Math.round((c.value / score) * 100)}% from rank feature ${c.label}.`)
    else if (c.kind === 'constant') bullets.push(`${Math.round((c.value / score) * 100)}% is a constant-score clause: ${c.label}. Every matching doc gets the same amount.`)
    else if (c.kind === 'opaque') bullets.push(`${Math.round((c.value / score) * 100)}% from an unrecognised node: ${c.label}. Not attributed further.`)
    else bullets.push(`${Math.round((c.value / score) * 100)}% from ${c.label}.`)
  }
  const shadowed = contribs.filter((c) => c.shadowed)
  if (shadowed.length) {
    const lost = shadowed.reduce((a, c) => a + (c.shadowed ?? 0), 0)
    bullets.push(`dis_max discarded ${fmt(lost)} points from ${[...new Set(shadowed.map((c) => c.field))].join(', ')}: only the best field counts unless tie_breaker is set.`)
  }
  const headline = top ? `${top.field} drives ${Math.round(top.pct)}% of this ${fmt(hit.score)} score.` : `Score ${fmt(hit.score)} has no positive contribution.`
  return { headline, bullets, byField }
}
