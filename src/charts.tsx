import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { fmt, type Bm25, type Contribution, type ENode } from './engine/explain.ts'
import type { BumpColumn } from './engine/replay.ts'
import { normalize, type FusedDoc, type Normalizer, type RetrieverList } from './engine/hybrid.ts'

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/** Tweens a flat numeric record towards its target. */
export function useTween(target: Record<string, number>, ms = 620): Record<string, number> {
  const [val, setVal] = useState(target)
  const cur = useRef(target)
  const key = JSON.stringify(target)
  useEffect(() => {
    if (reduced()) {
      cur.current = target
      setVal(target)
      return
    }
    const from = cur.current
    const start = performance.now()
    let raf = 0
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ms)
      const e = 1 - (1 - p) ** 3
      const next: Record<string, number> = {}
      for (const k of Object.keys(target)) next[k] = (from[k] ?? target[k]) + (target[k] - (from[k] ?? target[k])) * e
      cur.current = next
      setVal(next)
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ms])
  return val
}

// ---- Bump chart -------------------------------------------------------------------------

export function BumpChart({ columns, titles, height, compact, onPick }: { columns: BumpColumn[]; titles?: Record<string, string>; height?: number; compact?: boolean; onPick?: (id: string) => void }) {
  const [hover, setHover] = useState<string | null>(null)
  const ids = useMemo(() => Object.keys(columns[0]?.ranks ?? {}), [columns])
  const target = useMemo(() => {
    const t: Record<string, number> = {}
    for (const id of ids) columns.forEach((c, i) => { t[`${id}|${i}`] = c.ranks[id] ?? ids.length })
    return t
  }, [ids, columns])
  const r = useTween(target)
  const n = ids.length
  const host = useRef<SVGSVGElement>(null)
  const [measured, setMeasured] = useState(420)
  useEffect(() => {
    if (!compact || !host.current?.parentElement) return
    const parent = host.current.parentElement
    const ro = new ResizeObserver(() => setMeasured(Math.max(160, parent.clientWidth)))
    ro.observe(parent)
    return () => ro.disconnect()
  }, [compact])
  // Compact mode draws at true pixel size so its last column lines up with the result rows beside it.
  const W = compact ? measured : 880
  const pad = compact ? { l: 8, r: 8, t: 54, b: 20 } : { l: 34, r: 216, t: 34, b: 12 }
  const rowH = compact ? 44 : 34
  const H = height ?? pad.t + pad.b + rowH * Math.max(1, n - 1)
  const x = (i: number) => pad.l + ((W - pad.l - pad.r) * i) / Math.max(1, columns.length - 1)
  const y = (rank: number) => pad.t + ((H - pad.t - pad.b) * (rank - 1)) / Math.max(1, n - 1)
  const last = columns.length - 1
  const color = (id: string) => {
    const s = (columns[0]?.ranks[id] ?? 0) - (columns[last]?.ranks[id] ?? 0)
    return s > 0 ? 'var(--up)' : s < 0 ? 'var(--down)' : 'var(--flat)'
  }
  const order = [...ids].sort((a, b) => {
    const score = (id: string) => (id === hover ? 3 : color(id) === 'var(--flat)' ? 0 : 1)
    return score(a) - score(b)
  })
  return (
    <svg ref={host} className="bump" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Rank changes across ${columns.length} tuning stages for ${n} documents`} onPointerLeave={() => setHover(null)}>
      {columns.map((c, i) => (
        <g key={i}>
          <line x1={x(i)} x2={x(i)} y1={pad.t - 8} y2={H - pad.b + 4} className="bump-axis" />
          <text x={x(i)} y={14} className="bump-col" textAnchor={i === 0 ? 'start' : i === last && compact ? 'end' : 'middle'}>{c.label}</text>
        </g>
      ))}
      {!compact && Array.from({ length: n }, (_, i) => (
        <text key={i} x={pad.l - 10} y={y(i + 1) + 4} className="bump-rank" textAnchor="end">{i + 1}</text>
      ))}
      {order.map((id) => {
        const pts = columns.map((_, i) => ({ x: x(i), y: y(r[`${id}|${i}`] ?? 1) }))
        let d = `M${pts[0].x},${pts[0].y}`
        for (let i = 1; i < pts.length; i++) {
          const mx = (pts[i - 1].x + pts[i].x) / 2
          d += ` C${mx},${pts[i - 1].y} ${mx},${pts[i].y} ${pts[i].x},${pts[i].y}`
        }
        const dim = hover && hover !== id
        const shift = (columns[0]?.ranks[id] ?? 0) - (columns[last]?.ranks[id] ?? 0)
        const tip = `${titles?.[id] ?? id}: rank ${columns[0]?.ranks[id]} to ${columns[last]?.ranks[id]}, score ${fmt(columns[last]?.scores[id] ?? 0)}`
        const end = pts[pts.length - 1]
        return (
          <g key={id} style={{ opacity: dim ? 0.18 : 1, transition: 'opacity .15s' }} onPointerEnter={() => setHover(id)} onClick={() => onPick?.(id)} data-tip={tip}>
            <path d={d} fill="none" stroke="transparent" strokeWidth="14" />
            <path d={d} fill="none" stroke={color(id)} strokeWidth={hover === id ? 3.5 : 2.25} strokeLinecap="round" />
            {pts.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={4.25} fill={color(id)} stroke="var(--panel)" strokeWidth="2" />)}
            {!compact && <text x={end.x + 12} y={end.y + 4} className="bump-label">{clip(titles?.[id] ?? id, 28)}</text>}
            {shift !== 0 && !compact && (
              <text x={W - 4} y={end.y + 4} className="bump-shift" textAnchor="end">{shift > 0 ? `▲${shift}` : `▼${-shift}`}</text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// ---- Waterfall --------------------------------------------------------------------------

export function Waterfall({ contribs, score, colorOf, onSelect }: { contribs: Contribution[]; score: number; colorOf: (c: Contribution) => string; onSelect?: (nodeId: string) => void }) {
  const steps = [...contribs].filter((c) => c.value !== 0 || c.shadowed).sort((a, b) => (kindRank(a) - kindRank(b)) || b.value - a.value)
  const scale = Math.max(score, steps.reduce((m, c) => Math.max(m, c.shadowed ?? 0), 0)) || 1
  let run = 0
  return (
    <div className="wf" role="table" aria-label="Score waterfall">
      {steps.map((c) => {
        const from = run
        run += c.value
        const lo = Math.min(from, run)
        const w = Math.abs(c.value)
        const pct = score ? (c.value / score) * 100 : 0
        return (
          <div className={`wf-row${c.shadowed ? ' shadow' : ''}`} key={c.nodeId + c.key} role="row">
            <button className="wf-label" role="rowheader" onClick={() => onSelect?.(c.nodeId)} data-tip={c.label}>{c.label}</button>
            <div className="wf-track" role="cell">
              {c.shadowed ? (
                <i className="wf-ghost" style={{ left: `${(run / scale) * 100}%`, width: `${(c.shadowed / scale) * 100}%`, borderColor: colorOf(c) }} data-tip={`${c.label}: scored ${fmt(c.shadowed)}, discarded by dis_max`} />
              ) : (
                <i className="wf-bar" style={{ left: `${(lo / scale) * 100}%`, width: `max(3px, ${(w / scale) * 100}%)`, background: colorOf(c) }} data-tip={`${c.label}: ${c.value >= 0 ? '+' : ''}${fmt(c.value)} (${pct.toFixed(1)}%)`} />
              )}
            </div>
            <div className="wf-val" role="cell">{c.shadowed ? <em>discarded</em> : <>{c.value >= 0 ? '+' : ''}{fmt(c.value, 3)}<small>{Math.round(pct)}%</small></>}</div>
          </div>
        )
      })}
      <div className="wf-row total" role="row">
        <span className="wf-label" role="rowheader">_score</span>
        <div className="wf-track" role="cell"><i className="wf-bar" style={{ left: 0, width: `${(score / scale) * 100}%` }} /></div>
        <div className="wf-val" role="cell">{fmt(score, 3)}</div>
      </div>
    </div>
  )
}
const kindRank = (c: Contribution) => (c.kind === 'function' ? 2 : c.kind === 'nested' ? 1 : 0)

// ---- Zoomable tree ----------------------------------------------------------------------

interface LNode { n: ENode; x: number; y: number; kids: LNode[]; collapsed: boolean; hidden: number }
const NW = 248
const NH = 50
const GX = 44
const GY = 12

function layout(n: ENode, collapsed: Set<string>, depth = 0, cursor = { y: 0 }): LNode {
  const isClosed = collapsed.has(n.id)
  const kids = isClosed ? [] : n.children.map((c) => layout(c, collapsed, depth + 1, cursor))
  const y = kids.length ? (kids[0].y + kids[kids.length - 1].y) / 2 : (cursor.y += NH + GY) - NH - GY
  return { n, x: depth * (NW + GX), y, kids, collapsed: isClosed && n.children.length > 0, hidden: isClosed ? n.children.length : 0 }
}

function flat(l: LNode, out: LNode[] = []) {
  out.push(l)
  l.kids.forEach((k) => flat(k, out))
  return out
}

const KIND_LABEL: Record<string, string> = { bm25: 'BM25 term', sum: 'sum', max: 'dis_max', product: 'product', min: 'min', avg: 'avg', nested: 'nested', function: 'function', maxBoost: 'max_boost', constant: 'value', knn: 'kNN', rankFeature: 'rank feature', rrf: 'RRF', rrfSource: 'retriever', linear: 'linear', linearSource: 'retriever', wrapper: 'rank doc', noMatch: 'no match', opaque: 'unsupported' }

export function ExplainTree({ root, focus }: { root: ENode; focus?: string }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => initialCollapse(root))
  const [view, setView] = useState({ k: 0.8, x: 16, y: 16 })
  const [sel, setSel] = useState<string>(root.id)
  const box = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)
  const lay = useMemo(() => layout(root, collapsed), [root, collapsed])
  const nodes = useMemo(() => flat(lay), [lay])
  const w = Math.max(...nodes.map((n) => n.x)) + NW
  const h = Math.max(...nodes.map((n) => n.y)) + NH

  const fit = () => {
    const el = box.current
    if (!el) return
    const k = Math.min(1, (el.clientWidth - 32) / w, (el.clientHeight - 32) / h)
    setView({ k: Math.max(0.2, k), x: 16, y: 16 })
  }
  useLayoutEffect(() => {
    setCollapsed(initialCollapse(root))
    setSel(root.id)
  }, [root])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(fit, [w, h])
  useEffect(() => {
    const el = box.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const px = e.clientX - r.left
      const py = e.clientY - r.top
      setView((v) => {
        const k = Math.min(2.5, Math.max(0.2, v.k * Math.exp(-e.deltaY * 0.0016)))
        return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
  useEffect(() => {
    if (!focus) return
    setSel(focus)
    setCollapsed((c) => {
      const next = new Set(c)
      const parts = focus.split('.')
      for (let i = 1; i < parts.length; i++) next.delete(parts.slice(0, i).join('.'))
      return next
    })
  }, [focus])
  const zoom = (f: number) => setView((v) => ({ ...v, k: Math.min(2.5, Math.max(0.2, v.k * f)) }))
  const selected = nodes.find((l) => l.n.id === sel)?.n ?? root
  const toggle = (id: string) => setCollapsed((c) => {
    const next = new Set(c)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  return (
    <div className="tree-wrap">
      <div className="tree-tools">
        <span className="eyebrow plain">Scroll to zoom. Drag to pan. Click a node to expand.</span>
        <div className="seg">
          <button onClick={() => zoom(1.25)} aria-label="Zoom in">+</button>
          <button onClick={() => zoom(0.8)} aria-label="Zoom out">−</button>
          <button onClick={fit}>Fit</button>
          <button onClick={() => setCollapsed(new Set())}>Expand all</button>
          <button onClick={() => setCollapsed(initialCollapse(root))}>Reset</button>
        </div>
      </div>
      <div
        className="tree"
        ref={box}
        tabIndex={0}
        role="group"
        aria-label="Explanation tree. Arrow keys pan, plus and minus zoom."
        onKeyDown={(e) => {
          const step = 50
          if (e.key === 'ArrowLeft') setView((v) => ({ ...v, x: v.x + step }))
          else if (e.key === 'ArrowRight') setView((v) => ({ ...v, x: v.x - step }))
          else if (e.key === 'ArrowUp') setView((v) => ({ ...v, y: v.y + step }))
          else if (e.key === 'ArrowDown') setView((v) => ({ ...v, y: v.y - step }))
          else if (e.key === '+' || e.key === '=') zoom(1.2)
          else if (e.key === '-') zoom(0.83)
          else return
          e.preventDefault()
        }}
        onPointerDown={(e) => {
          if ((e.target as Element).closest('button')) return
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (d) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }))
        }}
        onPointerUp={() => { drag.current = null }}
      >
        <div className="tree-canvas" style={{ transform: `translate(${view.x}px,${view.y}px) scale(${view.k})`, width: w, height: h }}>
          <svg width={w} height={h} className="tree-links" aria-hidden="true">
            {nodes.flatMap((l) => l.kids.map((k) => (
              <path key={k.n.id} d={`M${l.x + NW},${l.y + NH / 2} C${l.x + NW + GX / 2},${l.y + NH / 2} ${k.x - GX / 2},${k.y + NH / 2} ${k.x},${k.y + NH / 2}`} />
            )))}
          </svg>
          {nodes.map((l) => (
            <button
              key={l.n.id}
              className={`tn k-${l.n.kind}${sel === l.n.id ? ' sel' : ''}${l.n.warning ? ' warn' : ''}`}
              style={{ left: l.x, top: l.y, width: NW, height: NH }}
              onClick={() => {
                setSel(l.n.id)
                if (l.n.children.length) toggle(l.n.id)
              }}
              aria-expanded={l.n.children.length ? !l.collapsed : undefined}
            >
              <span className="tn-top"><b>{fmt(l.n.value, 3)}</b><i>{KIND_LABEL[l.n.kind]}</i>{l.hidden > 0 && <u>+{l.hidden}</u>}</span>
              <span className="tn-label">{l.n.label}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="tree-detail">
        <code>{selected.description}</code>
        {selected.warning && <p className="tree-warn">{selected.warning}</p>}
      </div>
    </div>
  )
}

function initialCollapse(root: ENode) {
  const s = new Set<string>()
  const walk = (n: ENode) => {
    if (n.kind === 'bm25' || n.kind === 'function' || n.kind === 'rankFeature' || n.kind === 'constant') {
      if (n.children.length) s.add(n.id)
      return
    }
    n.children.forEach(walk)
  }
  walk(root)
  return s
}

// ---- Saturation curves ------------------------------------------------------------------

export function SaturationChart({ k1, b, k10, b0, terms, colorOf }: { k1: number; b: number; k10: number; b0: number; terms: Bm25[]; colorOf: (field: string) => string }) {
  const W = 520
  const H = 300
  const pad = { l: 54, r: 92, t: 12, b: 38 }
  const maxF = 20
  const X = (f: number) => pad.l + ((W - pad.l - pad.r) * f) / maxF
  const Y = (v: number) => H - pad.b - (H - pad.t - pad.b) * v
  const curve = (ratio: number, k: number, bb: number) => {
    let d = ''
    for (let f = 0; f <= maxF; f += 0.25) {
      const v = f / (f + k * (1 - bb + bb * ratio) || 1)
      d += `${d ? 'L' : 'M'}${X(f).toFixed(1)},${Y(f === 0 ? 0 : v).toFixed(1)}`
    }
    return d
  }
  const ratios: [number, string][] = [[0.25, 'dl = ¼ avg'], [1, 'dl = avg'], [4, 'dl = 4× avg']]
  const [hx, setHx] = useState<number | null>(null)
  const tfAt = (f: number, ratio: number) => (f ? f / (f + k1 * (1 - b + b * ratio)) : 0)
  // Keep end labels readable when curves converge.
  const labelYs = ratios.map(([r]) => Y(tfAt(maxF, r)))
  for (let i = 1; i < labelYs.length; i++) if (labelYs[i] - labelYs[i - 1] < 15) labelYs[i] = labelYs[i - 1] + 15
  return (
    <svg className="sat" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Term frequency saturation with k1 ${k1.toFixed(2)} and b ${b.toFixed(2)}`}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        const f = (((e.clientX - r.left) / r.width) * W - pad.l) / (W - pad.l - pad.r) * maxF
        setHx(f >= 0 && f <= maxF ? Math.round(f) : null)
      }}
      onPointerLeave={() => setHx(null)}
    >
      {[0, 0.25, 0.5, 0.75, 1].map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={W - pad.r} y1={Y(v)} y2={Y(v)} className="grid" />
          <text x={pad.l - 8} y={Y(v) + 4} textAnchor="end" className="tick">{v}</text>
        </g>
      ))}
      {[0, 5, 10, 15, 20].map((f) => <text key={f} x={X(f)} y={H - pad.b + 18} textAnchor="middle" className="tick">{f}</text>)}
      <text x={(pad.l + W - pad.r) / 2} y={H - 4} textAnchor="middle" className="axis-title">term frequency in the field</text>
      <text x={14} y={Y(0.5)} textAnchor="middle" transform={`rotate(-90 14 ${Y(0.5)})`} className="axis-title">tf share of ceiling</text>
      {ratios.map(([r, label], i) => (
        <g key={label}>
          <path d={curve(r, k10, b0)} className="sat-base" />
          <path d={curve(r, k1, b)} className="sat-line" style={{ stroke: `var(--c${[1, 3, 5][i]})` }} />
          <text x={W - pad.r + 8} y={labelYs[i] + 4} className="tick strong">{label}</text>
        </g>
      ))}
      {terms.slice(0, 16).map((t, i) => {
        const v = t.freq / (t.freq + k1 * (1 - b + (b * t.dl) / t.avgdl))
        return <circle key={i} cx={X(Math.min(maxF, t.freq))} cy={Y(v)} r={5} fill={colorOf(t.field)} stroke="var(--panel)" strokeWidth="2" data-tip={`${t.field}:${t.term}, freq ${t.freq}, dl ${t.dl} vs avg ${fmt(t.avgdl, 1)}: tf ${v.toFixed(3)}`} />
      })}
      {hx != null && (
        <g pointerEvents="none">
          <line x1={X(hx)} x2={X(hx)} y1={pad.t} y2={H - pad.b} className="cross" />
          <text x={X(hx) + (hx > 13 ? -8 : 8)} y={pad.t + 12} textAnchor={hx > 13 ? 'end' : 'start'} className="tick strong">freq {hx}: {ratios.map(([r]) => tfAt(hx, r).toFixed(2)).join(' / ')}</text>
        </g>
      )}
    </svg>
  )
}

// ---- RRF flow ---------------------------------------------------------------------------

export function RrfFlow({ lists, fused, window, topN = 10, titles, method }: { lists: RetrieverList[]; fused: FusedDoc[]; window: number; topN?: number; titles: Record<string, string>; method: 'rrf' | 'linear' }) {
  const [hover, setHover] = useState<string | null>(null)
  const rows = Math.min(topN, Math.max(...lists.map((l) => Math.min(l.items.length, window)), 1))
  const shown = fused.slice(0, topN)
  const W = 960
  const rowH = 34
  const H = 62 + rowH * Math.max(rows, shown.length)
  const colL = 150
  const colR = W - 150
  const cW = 230
  const midL = W / 2 - cW / 2
  const midR = W / 2 + cW / 2
  const yy = (rank: number) => 48 + rowH * (rank - 1) + rowH / 2
  const target = useMemo(() => Object.fromEntries(fused.map((d) => [d.id, d.rank])), [fused])
  const tween = useTween(target, 500)
  const maxC = Math.max(...fused.flatMap((d) => d.parts.map((p) => p.contribution)), 1e-9)
  const [left, right] = lists
  const series = (list: number) => `var(--c${list === 0 ? 1 : 3})`
  const box = (x: number, rank: number, id: string, score: string, side: 'l' | 'r') => {
    const dim = hover && hover !== id
    return (
      <g key={`${side}-${id}`} style={{ opacity: dim ? 0.3 : 1 }} onPointerEnter={() => setHover(id)} data-tip={`${titles[id] ?? id}: rank ${rank}, score ${score}`}>
        <rect x={x} y={yy(rank) - 13} width={150 - 12} height={26} rx={4} className="flow-node" />
        <text x={x + 8} y={yy(rank) + 4} className="flow-rank">{rank}</text>
        <text x={x + 26} y={yy(rank) + 4} className="flow-text">{clip(id, 15)}</text>
      </g>
    )
  }
  return (
    <svg className="flow" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${method} fusion flow from ${lists.length} retrievers to the fused list`} onPointerLeave={() => setHover(null)}>
      <text x={6} y={22} className="flow-head">{left?.name ?? ''}</text>
      <text x={W / 2} y={22} className="flow-head" textAnchor="middle">{method === 'rrf' ? 'Σ 1 / (rank_constant + rank)' : 'Σ weight × normalized score'}</text>
      <text x={W - 6} y={22} className="flow-head" textAnchor="end">{right?.name ?? ''}</text>
      {shown.flatMap((d) =>
        d.parts.map((p) => {
          const isLeft = p.list === 0
          const item = lists[p.list].items.find((i) => i.id === d.id)
          if (!item || item.rank > rows) return []
          const y1 = yy(item.rank)
          const y2 = yy(tween[d.id] ?? d.rank)
          const width = 2 + (Math.max(0, p.contribution) / maxC) * 11
          const x1 = isLeft ? colL - 6 : colR + 6 - 12 + 12
          const x2 = isLeft ? midL : midR
          const mx = (x1 + x2) / 2
          const dim = hover && hover !== d.id
          return [
            <path key={`${p.list}-${d.id}`} d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" stroke={series(p.list)} strokeWidth={width} strokeOpacity={dim ? 0.08 : hover ? 0.85 : 0.42} className="flow-ribbon" />,
          ]
        }),
      )}
      {left?.items.slice(0, rows).map((i) => box(6, i.rank, i.id, fmt(i.score, 3), 'l'))}
      {right?.items.slice(0, rows).map((i) => box(W - 144, i.rank, i.id, fmt(i.score, 3), 'r'))}
      {shown.map((d) => {
        const y = yy(tween[d.id] ?? d.rank)
        const dim = hover && hover !== d.id
        const tot = d.parts.reduce((a, p) => a + Math.max(0, p.contribution), 0) || 1
        let cx = midL + 8
        return (
          <g key={d.id} style={{ opacity: dim ? 0.3 : 1 }} onPointerEnter={() => setHover(d.id)} data-tip={`${titles[d.id] ?? d.id}: ${method === 'rrf' ? d.score.toFixed(4) : d.score.toFixed(3)}, ${d.parts.length > 1 ? 'found by both' : `only ${lists[d.parts[0].list].name}`}`}>
            <rect x={midL} y={y - 15} width={cW} height={30} rx={4} className="flow-node mid" />
            <text x={midL + 10} y={y - 1} className="flow-rank strong">{d.rank}</text>
            <text x={midL + 30} y={y - 1} className="flow-text strong">{clip(d.id, 18)}</text>
            <text x={midR - 8} y={y - 1} className="flow-score" textAnchor="end">{method === 'rrf' ? d.score.toFixed(4) : d.score.toFixed(3)}</text>
            {d.parts.map((p, i) => {
              const seg = ((Math.max(0, p.contribution) / tot) * (cW - 16))
              const x = cx
              cx += seg
              return <rect key={i} x={x} y={y + 6} width={Math.max(0, seg - 2)} height={4} rx={2} fill={series(p.list)} />
            })}
          </g>
        )
      })}
    </svg>
  )
}

// ---- Score strips: one shared axis, raw and normalized --------------------------------

export function ScoreStrip({ lists, window, normalizer, label }: { lists: RetrieverList[]; window: number; normalizer: Normalizer; label: string }) {
  const W = 560
  const rowH = 30
  const H = 34 + rowH * lists.length + 20
  const pad = { l: 86, r: 16 }
  const vals = lists.map((l) => {
    const items = l.items.slice(0, window)
    const n = normalize(items.map((i) => i.score), normalizer)
    return items.map((it, i) => ({ id: it.id, v: n[i], raw: it.score }))
  })
  const max = Math.max(...vals.flat().map((v) => v.v), 1e-9)
  const min = Math.min(0, ...vals.flat().map((v) => v.v))
  const X = (v: number) => pad.l + ((W - pad.l - pad.r) * (v - min)) / (max - min || 1)
  return (
    <svg className="strip" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}: score distribution per retriever on one axis`}>
      <text x={0} y={14} className="flow-head">{label}</text>
      {[0, 0.25, 0.5, 0.75, 1].map((t) => {
        const v = min + (max - min) * t
        return (
          <g key={t}>
            <line x1={X(v)} x2={X(v)} y1={26} y2={H - 18} className="grid" />
            <text x={X(v)} y={H - 4} textAnchor="middle" className="tick">{fmt(v)}</text>
          </g>
        )
      })}
      {vals.map((row, i) => (
        <g key={i}>
          <text x={pad.l - 10} y={34 + rowH * i + 12} textAnchor="end" className="tick strong">{lists[i].name}</text>
          {row.map((p) => (
            <circle key={p.id} cx={X(p.v)} cy={34 + rowH * i + 8} r={5} fill={`var(--c${i === 0 ? 1 : 3})`} fillOpacity={0.72} stroke="var(--panel)" strokeWidth="1.5" data-tip={`${p.id}: raw ${fmt(p.raw, 3)}${normalizer !== 'none' ? `, normalized ${p.v.toFixed(3)}` : ''}`} />
          ))}
        </g>
      ))}
    </svg>
  )
}

// ---- Isometric score stack: the landing page's score anatomy --------------------------

export interface IsoLayer { key: string; label: string; detail: string; value: number; color: string; side: string; dark: string }

export function IsoStack({ layers, total }: { layers: IsoLayer[]; total: number }) {
  const target = useMemo(() => Object.fromEntries(layers.map((l) => [l.key, l.value])), [layers])
  const tween = useTween(target, 620)
  const W = 620
  const H = 420
  const cx = 250
  const baseY = 330
  const hw = 138
  const hh = 72
  const maxH = 210
  const scale = maxH / Math.max(total, 1e-9)
  let y = baseY
  const iso = (top: number) => ({
    t: `${cx},${top - hh} ${cx + hw},${top} ${cx},${top + hh} ${cx - hw},${top}`,
  })
  const slabs = layers.map((l) => {
    const h = Math.max(4, (tween[l.key] ?? l.value) * scale)
    const bottom = y
    const top = y - h
    y = top - 3
    return { l, top, bottom }
  })
  const callouts = [...slabs].reverse()
  const gap = 56
  const startY = Math.min(baseY - 30, 96)
  return (
    <svg className="iso" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Score stack: ${layers.map((l) => `${l.label} ${fmt(l.value)}`).join(', ')}`}>
      <defs>
        <pattern id="iso-dots" width="9" height="9" patternUnits="userSpaceOnUse"><circle cx="1.4" cy="1.4" r="1.05" className="iso-dot" /></pattern>
      </defs>
      <polygon points={iso(baseY + 18).t} fill="url(#iso-dots)" />
      <polygon points={iso(baseY + 10).t} className="iso-plate" />
      {slabs.map(({ l, top, bottom }) => (
        <g key={l.key}>
          <polygon points={`${cx - hw},${top} ${cx},${top + hh} ${cx},${bottom + hh} ${cx - hw},${bottom}`} fill={l.side} />
          <polygon points={`${cx},${top + hh} ${cx + hw},${top} ${cx + hw},${bottom} ${cx},${bottom + hh}`} fill={l.dark} />
          <polygon points={iso(top).t} fill={l.color} />
          <polyline points={`${cx - hw},${top} ${cx},${top + hh} ${cx + hw},${top}`} fill="none" className="iso-edge" />
        </g>
      ))}
      {callouts.map(({ l, top, bottom }, i) => {
        const yc = startY + i * gap
        const ax = cx + hw
        const ay = Math.max(top, Math.min((top + bottom) / 2, bottom))
        return (
          <g key={l.key}>
            <polyline points={`${ax - 4},${ay} ${ax + 22},${ay} ${ax + 40},${yc} ${ax + 52},${yc}`} className="iso-lead" />
            <text x={ax + 58} y={yc - 3} className="iso-call">{clip(l.label, 22)}</text>
            <text x={ax + 58} y={yc + 13} className="iso-sub">{clip(l.detail, 24)}</text>
          </g>
        )
      })}
    </svg>
  )
}
