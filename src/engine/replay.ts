// Local BM25 replay, rank shifts and A-vs-B analysis over parsed explanation trees.
import { attribute, bm25Score, type Contribution, type ENode, type Hit } from './explain.ts'

export interface Params {
  k1?: number
  b?: number
  /** Multiplier on top of the boost already in the query, keyed by field. "(knn)" scales vector clauses. */
  fieldBoost?: Record<string, number>
  /** Replaces function_score max_boost. */
  maxBoost?: number
  /** Replaces dis_max tie_breaker. */
  tie?: number
  /** Recompute each term from its own stats and parameters instead of trusting the reported value. */
  force?: boolean
}

export function replayNode(n: ENode, p: Params): number {
  const kids = () => n.children.map((c) => replayNode(c, p))
  switch (n.kind) {
    case 'bm25': {
      const t = n.bm25!
      if (!p.force && p.k1 == null && p.b == null && !p.fieldBoost?.[t.field]) return n.value
      return bm25Score(t, p.k1 ?? t.k1, p.b ?? t.b, p.fieldBoost?.[t.field] ?? 1)
    }
    case 'knn':
      return n.value * (p.fieldBoost?.['(knn)'] ?? 1)
    case 'rankFeature':
      return n.value * (p.fieldBoost?.[n.feature!.field] ?? 1)
    case 'maxBoost':
      return p.maxBoost ?? n.value
    case 'sum':
      return kids().reduce((a, b) => a + b, 0)
    case 'product':
      return kids().reduce((a, b) => a * b, 1)
    case 'avg': {
      const v = kids()
      return v.reduce((a, b) => a + b, 0) / (v.length || 1)
    }
    case 'min':
      return Math.min(...kids())
    case 'max': {
      const v = kids()
      const best = Math.max(...v)
      const tie = p.tie ?? n.tie ?? 0
      return best + tie * (v.reduce((a, b) => a + b, 0) - best)
    }
    case 'nested': {
      const c = n.children[0]
      return c && c.value ? (replayNode(c, p) * n.value) / c.value : n.value
    }
    case 'wrapper':
      return n.children[0] ? replayNode(n.children[0], p) : n.value
    default:
      return n.value // function, constant, opaque, rrf and linear are held fixed
  }
}

export interface Row {
  id: string
  hit: Hit
  score: number
  rank: number
  originalRank: number
  shift: number
}

export function replay(hits: Hit[], p: Params): Row[] {
  return hits
    .map((hit) => ({ id: hit.id, hit, score: replayNode(hit.root, p), originalRank: hit.rank }))
    .sort((x, y) => y.score - x.score || x.originalRank - y.originalRank)
    .map((r, i) => ({ ...r, rank: i + 1, shift: r.originalRank - (i + 1) }))
}

export interface Sanity {
  ok: boolean
  checked: number
  maxErrorPct: number
  worst?: { id: string; es: number; replay: number }
  replayable: boolean
  fixedShare: number
}

/** Rebuild every score from extracted stats and compare with what Elasticsearch reported. */
export function sanity(hits: Hit[], tolerancePct = 0.5): Sanity {
  let maxErrorPct = 0
  let worst: Sanity['worst']
  let bm = 0
  let total = 0
  for (const h of hits) {
    const v = replayNode(h.root, { force: true })
    const err = h.root.value ? (Math.abs(v - h.root.value) / Math.abs(h.root.value)) * 100 : 0
    if (err >= maxErrorPct) {
      maxErrorPct = err
      worst = { id: h.id, es: h.root.value, replay: v }
    }
    for (const c of attribute(h.root)) {
      total += Math.abs(c.value)
      if (c.kind === 'bm25') bm += Math.abs(c.value)
    }
  }
  return { ok: maxErrorPct <= tolerancePct, checked: hits.length, maxErrorPct, worst, replayable: bm > 0, fixedShare: total ? 1 - bm / total : 1 }
}

export interface FieldStat {
  field: string
  observedBoost: number
  share: number
}

export function fieldStats(hits: Hit[]): FieldStat[] {
  const m = new Map<string, { boost: number; val: number }>()
  let total = 0
  for (const h of hits) {
    for (const c of attribute(h.root)) {
      if (!c.field) continue
      const e = m.get(c.field) ?? { boost: c.bm25?.queryBoost ?? 1, val: 0 }
      e.val += c.value + (c.shadowed ?? 0)
      total += c.value + (c.shadowed ?? 0)
      m.set(c.field, e)
    }
  }
  return [...m].map(([field, e]) => ({ field, observedBoost: e.boost, share: total ? e.val / total : 0 })).sort((a, b) => b.share - a.share)
}

export function observedParams(hits: Hit[]): { k1: number; b: number; hasFunctions: boolean; hasTie: boolean; tie: number; maxUplift: number } {
  let t: ENode['bm25']
  let hasFunctions = false
  let hasTie = false
  let tie = 0
  let maxUplift = 1
  const walk = (n: ENode) => {
    if (n.kind === 'maxBoost') hasFunctions = true
    if (n.kind === 'min' && n.children.some((c) => c.kind === 'maxBoost')) maxUplift = Math.max(maxUplift, n.value)
    if (n.kind === 'max') {
      hasTie = true
      if (n.tie != null) tie = n.tie
    }
    if (n.bm25 && !t) t = n.bm25
    n.children.forEach(walk)
  }
  hits.forEach((h) => walk(h.root))
  return { k1: t?.k1 ?? 1.2, b: t?.b ?? 0.75, hasFunctions, hasTie, tie, maxUplift }
}

export interface BumpColumn {
  label: string
  ranks: Record<string, number>
  scores: Record<string, number>
}

/** One column per knob, applied cumulatively, so the chart shows which knob caused which move. */
export function bumpColumns(hits: Hit[], p: Params): BumpColumn[] {
  const stages: [string, Params][] = [['as returned', {}]]
  let acc: Params = {}
  const push = (label: string, patch: Params) => {
    acc = { ...acc, ...patch }
    stages.push([label, acc])
  }
  push(`k1 ${(p.k1 ?? observedParams(hits).k1).toFixed(2)}`, { k1: p.k1 })
  push(`b ${(p.b ?? observedParams(hits).b).toFixed(2)}`, { b: p.b })
  push('field boosts', { fieldBoost: p.fieldBoost })
  const o = observedParams(hits)
  if (o.hasTie) push(`tie ${(p.tie ?? o.tie).toFixed(2)}`, { tie: p.tie })
  if (o.hasFunctions) push(p.maxBoost != null ? `max_boost ${p.maxBoost.toFixed(1)}` : 'max_boost', { maxBoost: p.maxBoost })
  return stages.map(([label, params]) => {
    const rows = replay(hits, params)
    return { label, ranks: Object.fromEntries(rows.map((r) => [r.id, r.rank])), scores: Object.fromEntries(rows.map((r) => [r.id, r.score])) }
  })
}

// ---- Compare ---------------------------------------------------------------------------

export interface TermDiff {
  key: string
  field?: string
  label: string
  a?: Contribution
  b?: Contribution
  delta: number
  /** Log-mean decomposition: effects sum exactly to delta when both docs matched the term. */
  effects?: { boost: number; idf: number; freq: number; length: number }
  cause: string
}

function logMean(x: number, y: number) {
  if (x === y) return x
  return (x - y) / Math.log(x / y)
}

export function diffTerm(a: Contribution | undefined, b: Contribution | undefined): TermDiff {
  const ref = (a ?? b)!
  const av = a?.value ?? 0
  const bv = b?.value ?? 0
  const delta = av - bv
  const out: TermDiff = { key: ref.key, field: ref.field, label: ref.label, a, b, delta, cause: '' }
  if (a?.bm25 && b?.bm25 && a.value > 0 && b.value > 0) {
    const x = a.bm25
    const y = b.bm25
    const tf = (f: number, dl: number, t = x) => f / (f + t.k1 * (1 - t.b + (t.b * dl) / t.avgdl))
    const lm = logMean(av, bv)
    const mid = tf(y.freq, x.dl)
    const effects = {
      boost: lm * Math.log(x.queryBoost / y.queryBoost),
      idf: lm * Math.log(x.idf / y.idf),
      freq: lm * Math.log(tf(x.freq, x.dl) / mid),
      length: lm * Math.log(mid / (y.freq / (y.freq + y.k1 * (1 - y.b + (y.b * y.dl) / y.avgdl)))),
    }
    out.effects = effects
    const main = (Object.entries(effects) as [keyof typeof effects, number][]).sort((p, q) => Math.abs(q[1]) - Math.abs(p[1]))[0]
    const words: Record<keyof typeof effects, string> = {
      boost: `boost ×${x.queryBoost} vs ×${y.queryBoost}`,
      idf: `IDF ${x.idf.toFixed(2)} vs ${y.idf.toFixed(2)}: different shard statistics`,
      freq: `term frequency ${x.freq} vs ${y.freq}`,
      length: `field length ${x.dl} vs ${y.dl} tokens`,
    }
    out.cause = Math.abs(delta) < 1e-6 ? 'Identical contribution' : words[main[0]]
  } else if (a && b && !a.value && !b.value) out.cause = 'Discarded by dis_max in both, so it has no effect'
  else if (a && !b) out.cause = a.value ? 'Only the winner matched this clause' : 'Winner matched it, but dis_max discarded it'
  else if (b && !a) out.cause = b.value ? 'Only the loser matched this clause' : 'Loser matched it, but dis_max discarded it'
  else if (a && b && !a.value && b.value) out.cause = 'Winner matched it, but dis_max discarded it'
  else if (a && b && a.value && !b.value) out.cause = 'Loser matched it, but dis_max discarded it'
  else if (ref.kind === 'function') out.cause = `function_score uplift: ${av.toFixed(2)} vs ${bv.toFixed(2)} (multiplier applied to each doc's text score)`
  else if (ref.kind === 'retriever') out.cause = `rank ${a?.source?.rank ?? '?'} vs ${b?.source?.rank ?? '?'} in this retriever`
  else out.cause = 'Different value for the same clause'
  return out
}

export interface FlipOption {
  type: 'query' | 'settings' | 'content'
  title: string
  detail: string
  /** Lower is smaller. Comparable across query knobs; content edits rank after them. */
  magnitude: number
  sideEffects: number
  estimate?: boolean
  params?: Params
}

export interface Comparison {
  winner: Hit
  loser: Hit
  gap: number
  terms: TermDiff[]
  flips: FlipOption[]
  summary: string
}

function scan(lo: number, hi: number, steps: number, test: (x: number) => boolean, from: number): number | undefined {
  // Walk outwards from the current value, then bisect the crossing for a tight answer.
  let best: number | undefined
  for (let i = 1; i <= steps; i++) {
    const x = from + ((hi - from) * i) / steps
    if (x >= lo && x <= hi && test(x)) {
      best = bisect(from + ((hi - from) * (i - 1)) / steps, x, test)
      break
    }
  }
  for (let i = 1; i <= steps; i++) {
    const x = from + ((lo - from) * i) / steps
    if (x >= lo && x <= hi && test(x)) {
      const c = bisect(from + ((lo - from) * (i - 1)) / steps, x, test)
      if (best == null || Math.abs(c - from) < Math.abs(best - from)) best = c
      break
    }
  }
  return best
}

function bisect(fail: number, pass: number, test: (x: number) => boolean) {
  for (let i = 0; i < 24; i++) {
    const mid = (fail + pass) / 2
    if (test(mid)) pass = mid
    else fail = mid
  }
  return pass
}

function withFreq(n: ENode, id: string, freq: number): ENode {
  if (n.id === id && n.bm25) return { ...n, bm25: { ...n.bm25, freq, dl: n.bm25.dl + freq - n.bm25.freq } }
  return { ...n, children: n.children.map((c) => withFreq(c, id, freq)) }
}

export function compare(hits: Hit[], idA: string, idB: string, base: Params = {}): Comparison {
  const rows = replay(hits, base)
  const ra = rows.find((r) => r.id === idA)
  const rb = rows.find((r) => r.id === idB)
  if (!ra || !rb) throw new Error(`Cannot compare: unknown hit ${!ra ? idA : idB}`)
  const [winRow, loseRow] = ra.rank < rb.rank ? [ra, rb] : [rb, ra]
  const winner = winRow.hit
  const loser = loseRow.hit
  const gap = winRow.score - loseRow.score
  const ca = attribute(winner.root)
  const cb = attribute(loser.root)
  const keys = [...new Set([...ca, ...cb].map((c) => c.key))]
  const terms = keys
    .map((k) => diffTerm(ca.find((c) => c.key === k), cb.find((c) => c.key === k)))
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))

  const flipped = (p: Params) => replayNode(loser.root, { ...base, ...p }) > replayNode(winner.root, { ...base, ...p })
  const side = (p: Params) => {
    const after = replay(hits, { ...base, ...p })
    return after.filter((r) => r.id !== winner.id && r.id !== loser.id && rows.find((o) => o.id === r.id)!.rank !== r.rank).length
  }
  const flips: FlipOption[] = []
  const obs = observedParams(hits)
  const add = (o: Omit<FlipOption, 'sideEffects'>) => flips.push({ ...o, sideEffects: o.params ? side(o.params) : 0 })

  for (const f of fieldStats(hits)) {
    const current = base.fieldBoost?.[f.field] ?? 1
    const test = (logM: number) => flipped({ fieldBoost: { ...base.fieldBoost, [f.field]: current * 2 ** logM } })
    const x = scan(-6, 6, 60, test, 0)
    if (x == null) continue
    const m = 2 ** x
    const margin = m * (x > 0 ? 1.01 : 0.99)
    const params = { fieldBoost: { ...base.fieldBoost, [f.field]: current * margin } }
    const next = f.observedBoost * current * margin
    add({ type: 'query', title: `${f.field} boost ${fmtN(f.observedBoost * current)} → ${fmtN(next)}`, detail: `Multiply the ${f.field} clause by ${fmtN(margin)}. ${x > 0 ? 'The loser is stronger on this field.' : 'The winner leans on this field.'}`, magnitude: Math.abs(x), params })
  }
  const curK1 = base.k1 ?? obs.k1
  const k1 = scan(0.01, 3, 150, (v) => flipped({ k1: v }), curK1)
  if (k1 != null) add({ type: 'settings', title: `k1 ${curK1.toFixed(2)} → ${k1.toFixed(3)}`, detail: k1 < curK1 ? 'Saturate term frequency sooner: repeated terms count for less.' : 'Saturate later: repeated terms count for more.', magnitude: Math.abs(Math.log2(k1 / curK1)) + 0.25, params: { k1 } })
  const curB = base.b ?? obs.b
  const bv = scan(0, 1, 100, (v) => flipped({ b: v }), curB)
  if (bv != null) add({ type: 'settings', title: `b ${curB.toFixed(2)} → ${bv.toFixed(3)}`, detail: bv < curB ? 'Penalise long fields less.' : 'Penalise long fields more.', magnitude: Math.abs(bv - curB) * 2 + 0.25, params: { b: bv } })
  if (obs.hasTie) {
    const cur = base.tie ?? obs.tie
    const t = scan(0, 1, 100, (v) => flipped({ tie: v }), cur)
    if (t != null) add({ type: 'query', title: `tie_breaker ${cur.toFixed(2)} → ${t.toFixed(3)}`, detail: 'Let non-best fields count toward the dis_max score.', magnitude: Math.abs(t - cur) * 2, params: { tie: t } })
  }
  if (obs.hasFunctions) {
    const mb = scan(1, Math.max(2, obs.maxUplift), 80, (v) => flipped({ maxBoost: v }), Math.max(2, obs.maxUplift))
    if (mb != null) add({ type: 'query', title: `max_boost → ${mb.toFixed(2)}`, detail: `Cap the function_score multiplier (currently up to ×${obs.maxUplift.toFixed(2)}).`, magnitude: Math.abs(Math.log2(obs.maxUplift / mb)), params: { maxBoost: mb } })
  }
  // Content edits on the loser.
  for (const c of cb.filter((x) => x.bm25)) {
    const t = c.bm25!
    for (let f = t.freq + 1; f <= t.freq + 12; f++) {
      const edited = withFreq(loser.root, c.nodeId, f)
      if (replayNode(edited, { ...base, k1: base.k1 ?? t.k1 }) > winRow.score) {
        add({ type: 'content', title: `Add "${t.term}" ${f - t.freq}× to ${loser.id}.${t.field}`, detail: `Raises freq from ${t.freq} to ${f}, including the extra length penalty.`, magnitude: 3 + (f - t.freq) * 0.25 })
        break
      }
    }
  }
  for (const c of ca.filter((x) => x.bm25 && x.value > 0 && !cb.some((y) => y.key === x.key))) {
    const t = c.bm25!
    const gain = bm25Score({ ...t, freq: 1, dl: t.avgdl }, base.k1 ?? t.k1, base.b ?? t.b, base.fieldBoost?.[t.field] ?? 1)
    if (gain > gap) {
      add({ type: 'content', title: `Add "${t.term}" to ${loser.id}.${t.field}`, detail: `One occurrence at average field length is worth about ${gain.toFixed(2)}, more than the ${gap.toFixed(2)} gap. Upper bound: under dis_max only the best field counts.`, magnitude: 3, estimate: true })
    }
  }
  flips.sort((x, y) => x.magnitude - y.magnitude)

  const lead = terms[0]
  const summary = !terms.length
    ? `${winner.id} and ${loser.id} have no scoring clauses to compare.`
    : `${winner.id} beats ${loser.id} by ${gap.toFixed(3)}. Biggest swing: ${lead.label} (${lead.delta >= 0 ? '+' : ''}${lead.delta.toFixed(3)}), caused by ${lead.cause.charAt(0).toLowerCase()}${lead.cause.slice(1)}.`
  return { winner, loser, gap, terms, flips, summary }
}

function fmtN(n: number) {
  return n >= 100 ? n.toFixed(0) : n.toFixed(2)
}
