// Replays RRF and linear fusion over keyword and vector result lists.
import { ExplainParseError, type ENode, type Hit } from './explain.ts'

export interface ListItem { id: string; score: number; rank: number; title?: string }
export interface RetrieverList { name: string; items: ListItem[]; incomplete?: boolean }

export function parseList(text: string, name: string): RetrieverList {
  const t = text.trim()
  if (!t) throw new ExplainParseError(`The ${name} list is empty.`)
  let rows: { id: string; score: number; title?: string }[]
  if (t[0] === '{' || t[0] === '[') {
    let j: any
    try {
      j = JSON.parse(t)
    } catch (e) {
      throw new ExplainParseError(`The ${name} list is not valid JSON: ${(e as Error).message}.`)
    }
    if (j.error) throw new ExplainParseError(`The ${name} list is an Elasticsearch error: ${j.error.reason ?? 'unknown'}.`)
    const arr = Array.isArray(j) ? j : j.hits?.hits ?? j.hits
    if (!Array.isArray(arr)) throw new ExplainParseError(`The ${name} list has no hits array.`, 'Use a search response, an array of {_id, _score}, or lines of "id score".')
    rows = arr.map((h: any, i: number) => {
      const id = h._id ?? h.id
      const score = h._score ?? h.score
      if (id == null || typeof score !== 'number') throw new ExplainParseError(`${name} item ${i + 1} needs an id and a numeric score.`)
      return { id: String(id), score, title: h._source?.title ?? h.title }
    })
  } else {
    rows = t.split(/\r?\n/).filter((l) => l.trim() && !/^(id|_id)\b/i.test(l.trim())).map((l, i) => {
      const parts = l.trim().split(/[\s,\t]+/)
      const score = Number(parts[1])
      if (parts.length < 2 || !Number.isFinite(score)) throw new ExplainParseError(`${name} line ${i + 1} should be "id score": "${l.slice(0, 50)}".`)
      return { id: parts[0], score }
    })
  }
  if (!rows.length) throw new ExplainParseError(`The ${name} list has no rows.`)
  const seen = new Set<string>()
  const items = rows
    .sort((a, b) => b.score - a.score)
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .map((r, i) => ({ ...r, rank: i + 1 }))
  return { name, items }
}

/** Recovers per-retriever lists from rrf, linear or sum-of-scores responses. */
export function listsFromHits(hits: Hit[]): { lists: RetrieverList[]; method: 'rrf' | 'linear' | 'sum'; rankConstant?: number } | null {
  const by = new Map<number, Map<string, { score: number; rank?: number; title?: string }>>()
  const names = new Map<number, string>()
  let method: 'rrf' | 'linear' | 'sum' | undefined
  let rankConstant: number | undefined
  const titleOf = (h: Hit) => (typeof h.source?.title === 'string' ? h.source.title : undefined)
  const put = (i: number, id: string, score: number, rank?: number, title?: string) => {
    if (!by.has(i)) by.set(i, new Map())
    by.get(i)!.set(id, { score, rank, title })
  }
  for (const h of hits) {
    const root = unwrap(h.root)
    if (root.kind === 'rrf' || root.kind === 'linear') {
      method = root.kind
      rankConstant = root.rankConstant ?? rankConstant
      for (const c of root.children) {
        if (c.kind !== 'rrfSource' && c.kind !== 'linearSource') continue
        const src = c.source!
        if (src.name) names.set(src.index, src.name)
        const inner = c.children[0]
        put(src.index, h.id, inner?.value ?? c.value, src.rank, titleOf(h))
        if (inner && !names.has(src.index)) names.set(src.index, hasKnn(inner) ? 'vector' : 'keyword')
      }
    } else if (root.kind === 'sum' && root.children.some((c) => c.kind === 'knn')) {
      method = 'sum'
      const knn = root.children.filter((c) => c.kind === 'knn').reduce((a, c) => a + c.value, 0)
      if (root.value - knn > 0) put(0, h.id, root.value - knn, undefined, titleOf(h))
      if (knn > 0) put(1, h.id, knn, undefined, titleOf(h))
      names.set(0, 'keyword')
      names.set(1, 'vector')
    } else if (root.kind === 'knn') {
      method = 'sum'
      put(1, h.id, root.value, undefined, titleOf(h))
      names.set(1, 'vector')
    }
  }
  if (!method) return null
  const lists = [...by.keys()].sort((a, b) => a - b).map((i) => {
    const rows = [...by.get(i)!].map(([id, v]) => ({ id, ...v }))
    rows.sort((a, b) => (a.rank != null && b.rank != null ? a.rank - b.rank : b.score - a.score))
    return { name: names.get(i) ?? `retriever ${i}`, incomplete: true, items: rows.map((r, j) => ({ id: r.id, score: r.score, title: r.title, rank: r.rank ?? j + 1 })) }
  })
  return { lists, method, rankConstant }
}

function unwrap(n: ENode): ENode {
  return n.kind === 'wrapper' && n.children[0] ? unwrap(n.children[0]) : n
}

function hasKnn(n: ENode): boolean {
  return n.kind === 'knn' || n.children.some(hasKnn)
}

export interface FusedDoc {
  id: string
  title?: string
  score: number
  rank: number
  parts: { list: number; rank?: number; raw?: number; normalized?: number; contribution: number }[]
}

export function rrf(lists: RetrieverList[], o: { rankConstant?: number; windowSize?: number; weights?: number[] } = {}): FusedDoc[] {
  const c = o.rankConstant ?? 60
  if (!(c >= 1)) throw new Error('rank_constant must be >= 1')
  const window = o.windowSize ?? 10
  if (!(window >= 1)) throw new Error('rank_window_size must be >= 1')
  return fuse(lists, window, (item, i) => {
    const contribution = (o.weights?.[i] ?? 1) / (c + item.rank)
    return { contribution, raw: item.score }
  })
}

export type Normalizer = 'minmax' | 'l2_norm' | 'none'

export function normalize(scores: number[], kind: Normalizer): number[] {
  if (kind === 'none' || !scores.length) return scores
  if (kind === 'l2_norm') {
    const norm = Math.sqrt(scores.reduce((a, s) => a + s * s, 0))
    return norm ? scores.map((s) => s / norm) : scores.map(() => 0)
  }
  const min = Math.min(...scores)
  const max = Math.max(...scores)
  // identical scores map to 1; ES clamps this degenerate case internally, verify on real data.
  return max === min ? scores.map(() => 1) : scores.map((s) => (s - min) / (max - min))
}

export function linear(lists: RetrieverList[], o: { weights?: number[]; normalizer?: Normalizer; windowSize?: number } = {}): FusedDoc[] {
  const window = o.windowSize ?? 10
  const norms = lists.map((l) => {
    const items = l.items.slice(0, window)
    const n = normalize(items.map((i) => i.score), o.normalizer ?? 'minmax')
    return new Map(items.map((it, k) => [it.id, n[k]]))
  })
  return fuse(lists, window, (item, i) => {
    const normalized = norms[i].get(item.id)!
    return { contribution: (o.weights?.[i] ?? 1) * normalized, raw: item.score, normalized }
  })
}

function fuse(lists: RetrieverList[], window: number, value: (item: ListItem, list: number) => { contribution: number; raw?: number; normalized?: number }): FusedDoc[] {
  const docs = new Map<string, FusedDoc>()
  lists.forEach((l, i) => {
    for (const item of l.items.slice(0, window)) {
      const d = docs.get(item.id) ?? { id: item.id, title: item.title, score: 0, rank: 0, parts: [] }
      d.title ??= item.title
      const v = value(item, i)
      d.parts.push({ list: i, rank: item.rank, ...v })
      d.score += v.contribution
      docs.set(item.id, d)
    }
  })
  return [...docs.values()]
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .map((d, i) => ({ ...d, rank: i + 1 }))
}

export interface Distribution {
  name: string
  count: number
  min: number
  max: number
  mean: number
  median: number
  spread: number
  bins: number[]
}

export function distribution(l: RetrieverList, window = l.items.length, bins = 12): Distribution {
  const s = l.items.slice(0, window).map((i) => i.score).sort((a, b) => a - b)
  const min = s[0] ?? 0
  const max = s[s.length - 1] ?? 0
  const counts = new Array(bins).fill(0)
  for (const v of s) counts[max === min ? 0 : Math.min(bins - 1, Math.floor(((v - min) / (max - min)) * bins))]++
  return {
    name: l.name, count: s.length, min, max,
    mean: s.reduce((a, b) => a + b, 0) / (s.length || 1),
    median: s[Math.floor(s.length / 2)] ?? 0,
    spread: max - min,
    bins: counts,
  }
}

export interface Coverage {
  both: string[]
  onlyIn: string[][]
  overlap: number
  /** Docs a single retriever would have lost from the fused top N. */
  lostFromTop: { list: number; ids: string[] }[]
}

export function coverage(lists: RetrieverList[], fused: FusedDoc[], window: number, topN = 10): Coverage {
  const sets = lists.map((l) => new Set(l.items.slice(0, window).map((i) => i.id)))
  const all = new Set(sets.flatMap((s) => [...s]))
  const both = [...all].filter((id) => sets.every((s) => s.has(id)))
  const onlyIn = sets.map((s, i) => [...s].filter((id) => sets.every((o, j) => j === i || !o.has(id))))
  return {
    both, onlyIn,
    overlap: all.size ? both.length / all.size : 0,
    lostFromTop: lists.map((_, i) => ({ list: i, ids: fused.slice(0, topN).filter((d) => !sets[i].has(d.id)).map((d) => d.id) })),
  }
}

export interface HybridFinding { severity: 'critical' | 'warning' | 'info'; title: string; detail: string }

export function diagnose(lists: RetrieverList[], window: number, size = 10): HybridFinding[] {
  const out: HybridFinding[] = []
  const ds = lists.map((l) => distribution(l, window))
  if (window < size) out.push({ severity: 'critical', title: `rank_window_size ${window} is below size ${size}`, detail: 'Elasticsearch rejects this: rank_window_size must be greater than or equal to size.' })
  if (ds.length === 2 && ds[0].count && ds[1].count) {
    const [a, b] = ds
    const ratio = Math.max(a.max, b.max) / Math.max(1e-9, Math.min(a.max, b.max))
    if (ratio >= 3) {
      const big = a.max > b.max ? a : b
      const small = big === a ? b : a
      out.push({ severity: 'warning', title: `${big.name} scores run ${ratio.toFixed(0)}× higher than ${small.name}`, detail: `Max ${big.max.toFixed(2)} against ${small.max.toFixed(2)}. Adding raw scores, or a linear retriever with normalizer "none", lets ${big.name} decide nearly every position. Use RRF, or linear with minmax or l2_norm.` })
    }
    for (const d of [a, b]) {
      if (d.max && d.spread / d.max < 0.1 && d.count > 2) {
        out.push({ severity: 'warning', title: `${d.name} scores are bunched in a ${(d.spread / d.max * 100).toFixed(0)}% band`, detail: `Range ${d.min.toFixed(3)} to ${d.max.toFixed(3)}. Min-max stretches this tiny gap to the full 0 to 1 range, so near-ties become big score gaps. l2_norm or RRF is calmer here.` })
      }
    }
  }
  for (const d of ds) {
    if (/vector|knn|semantic|dense/i.test(d.name) && d.max > 1.0001) {
      out.push({ severity: 'info', title: `${d.name} scores exceed 1`, detail: 'cosine, dot_product on floats and l2_norm all score at most 1. A score above 1 implies max_inner_product (or a query boost on kNN), so magnitude is in play and values are unbounded.' })
    }
    if (/vector|knn|semantic|dense/i.test(d.name) && d.max <= 1 && d.min >= 0.5 && d.count > 2 && d.max < 0.7) {
      out.push({ severity: 'info', title: `${d.name} top score is only ${d.max.toFixed(2)}`, detail: 'With cosine, _score = (1 + cos) / 2, so 0.5 means orthogonal. A top score this low suggests a weak semantic match, or query and document embedding models that differ.' })
    }
  }
  const sets = lists.map((l) => new Set(l.items.slice(0, window).map((i) => i.id)))
  if (sets.length === 2 && sets[0].size && sets[1].size && ![...sets[0]].some((id) => sets[1].has(id))) {
    out.push({ severity: 'warning', title: 'The retrievers have no documents in common', detail: `Within a window of ${window}, RRF has nothing to reinforce, and the order is just alternating ranks. Raise rank_window_size.` })
  }
  if (lists.some((l) => l.incomplete)) {
    out.push({ severity: 'info', title: 'Lists recovered from a combined response are partial', detail: 'The combined response only explains docs that survived to size. Paste each retriever\'s full list to replay window changes accurately.' })
  }
  return out
}

export function explainWinner(fused: FusedDoc[], lists: RetrieverList[], method: 'rrf' | 'linear', c = 60): string {
  const top = fused[0]
  if (!top) return 'No documents to fuse.'
  const parts = top.parts.map((p) => method === 'rrf' ? `rank ${p.rank} in ${lists[p.list].name} (1 / (${c} + ${p.rank}) = ${p.contribution.toFixed(4)})` : `${lists[p.list].name} ${p.raw?.toFixed(3)} normalized to ${p.normalized?.toFixed(3)}, contributing ${p.contribution.toFixed(3)}`)
  const second = fused[1]
  const margin = second ? top.score - second.score : 0
  const lead = !second ? '' : margin < 1e-6 ? ` Exactly tied with ${second.id}, so a tiebreak decides it.` : ` Leads ${second.id} by ${margin.toFixed(4)}.`
  const single = top.parts.length === 1 ? ` Only ${lists[top.parts[0].list].name} found it.` : ' Both retrievers found it, which is what fusion rewards.'
  return `${top.id} wins with ${top.score.toFixed(4)}: ${parts.join(' + ')}.${single}${lead}`
}
