import { useMemo, useState } from 'react'
import { link } from './App.tsx'
import { attribute, fmt, parseResponse } from './engine/explain.ts'
import { bumpColumns, replay } from './engine/replay.ts'
import { buildIndex, search } from './engine/miniindex.ts'
import { HERO_CORPUS, SAMPLES } from './engine/samples.ts'
import { BumpChart, IsoStack, type IsoLayer } from './charts.tsx'
import { SearchIcon } from './icons.tsx'

const INDEX = buildIndex(HERO_CORPUS, 'english')
const QUERIES = ['search relevance', 'vector search', 'boost title', 'bm25 length']
const TITLES = Object.fromEntries(HERO_CORPUS.map((d) => [d.id, d.title]))

const ISO: Record<string, [string, string, string]> = {
  title: ['#02BCB7', '#029C98', '#00857F'],
  body: ['#0B64DD', '#094DAB', '#153385'],
}

function useHero() {
  const [query, setQuery] = useState('search relevance')
  // Opens away from the defaults so the bump lines are already crossing.
  const [k1, setK1] = useState(2.2)
  const [b, setB] = useState(0.1)
  const [boost, setBoost] = useState(0.5)
  const base = useMemo(() => {
    if (!query.trim()) return null
    const res = search(INDEX, { query, fields: { title: 1, body: 1 }, size: 7, type: 'most_fields' })
    return res.hits.hits.length ? parseResponse(res).hits : null
  }, [query])
  const params = useMemo(() => ({ k1, b, fieldBoost: { title: boost } }), [k1, b, boost])
  const rows = useMemo(() => (base ? replay(base, params) : []), [base, params])
  const columns = useMemo(() => {
    if (!base) return []
    return bumpColumns(base, params).map((c, i) => ({ ...c, label: ['default', 'k1', 'b', 'title^'][i] ?? c.label }))
  }, [base, params])
  return { query, setQuery, k1, setK1, b, setB, boost, setBoost, base, rows, columns, params }
}

function Knob({ label, value, min, max, step, set, base }: { label: string; value: number; min: number; max: number; step: number; set: (v: number) => void; base: number }) {
  return (
    <label className="knob">
      <span><i>{label}</i><output>{value.toFixed(2)}</output></span>
      <span className="slider-track">
        <input type="range" value={value} min={min} max={max} step={step} onChange={(e) => set(+e.target.value)} style={{ '--p': `${((value - min) / (max - min)) * 100}%` } as React.CSSProperties} />
        <i className="slider-base" style={{ left: `${((base - min) / (max - min)) * 100}%` }} aria-hidden="true" />
      </span>
    </label>
  )
}

export default function Landing() {
  const h = useHero()
  const rowH = 44
  const top = h.rows[0]
  const layers: IsoLayer[] = useMemo(() => {
    const out: IsoLayer[] = []
    if (!top) return out
    const byField = new Map<string, { value: number; terms: string[] }>()
    // Sizes follow the live replay, so the stack moves with the sliders.
    for (const c of attribute(top.hit.root)) {
      if (!c.bm25) continue
      const t = c.bm25
      const nextK1 = h.k1
      const tf = t.freq / (t.freq + nextK1 * (1 - h.b + (h.b * t.dl) / t.avgdl))
      const v = (c.field === 'title' ? h.boost : 1) * (nextK1 + 1) * t.idf * tf
      const e = byField.get(c.field!) ?? { value: 0, terms: [] }
      e.value += v
      e.terms.push(t.term)
      byField.set(c.field!, e)
    }
    for (const [field, e] of [...byField].sort((a, b) => (a[0] === 'body' ? -1 : b[0] === 'body' ? 1 : 0))) {
      const [color, side, dark] = ISO[field] ?? ISO.body
      out.push({ key: field, label: `${field.toUpperCase()} ${fmt(e.value)}`, detail: e.terms.join(' + ').toUpperCase(), value: e.value, color, side, dark })
    }
    return out
  }, [top, h.k1, h.b, h.boost])

  return (
    <div className="land">
      <section className="hero">
        <div className="dots" aria-hidden="true" />
        <div className="hero-in">
          <div className="hero-copy">
            <p className="eyebrow">Elasticsearch relevance debugger</p>
            <h1>Why did it rank that way?</h1>
            <p className="lede">Turn explain output into plain-English answers. See which term earned the points, what would flip two results, and why your hybrid search misbehaves. Then tune it and prove it helped.</p>
            <div className="row">
              <a className="btn primary lg" {...link('/app?sample=ecommerce')}>Debug a sample</a>
              <a className="btn secondary lg" {...link('/app')}>Paste your response</a>
            </div>
            <p className="hero-foot">Free. No cluster or signup needed. Your responses stay in your browser.</p>
          </div>

          <div className="console" aria-label="Live BM25 demo">
            <div className="console-bar"><span className="live"><i />LIVE BM25</span><span className="console-meta">{HERO_CORPUS.length} docs in this tab · drag a slider</span></div>
            <label className="searchbox hero-search">
              <span className="sr">Search the demo corpus</span>
              <SearchIcon />
              <input value={h.query} onChange={(e) => h.setQuery(e.target.value)} placeholder="Search the demo corpus" />
            </label>
            <div className="chips" role="group" aria-label="Example queries">
              {QUERIES.map((q) => <button key={q} className={q === h.query ? 'on' : ''} onClick={() => h.setQuery(q)}>{q}</button>)}
            </div>
            <div className="knobs">
              <Knob label="k1" value={h.k1} min={0} max={3} step={0.01} set={h.setK1} base={1.2} />
              <Knob label="b" value={h.b} min={0} max={1} step={0.01} set={h.setB} base={0.75} />
              <Knob label="title^" value={h.boost} min={0} max={8} step={0.1} set={h.setBoost} base={1} />
            </div>
            {h.base ? (
              <div className="console-body">
                <div className="live-bump"><BumpChart columns={h.columns} titles={TITLES} compact /></div>
                <ol className="live-list" style={{ height: rowH * h.rows.length }}>
                  {[...h.rows].sort((a, b) => a.id.localeCompare(b.id)).map((r) => (
                    <li key={r.id} style={{ transform: `translateY(${(r.rank - 1) * rowH}px)` }} aria-posinset={r.rank} aria-setsize={h.rows.length}>
                      <span className="hit-rank">{r.rank}</span>
                      <span className="live-title">{TITLES[r.id]}</span>
                      <span className="live-score">{fmt(r.score)}</span>
                      {r.shift !== 0 && <span className={`mv ${r.shift > 0 ? 'up' : 'down'}`}>{r.shift > 0 ? '▲' : '▼'}{Math.abs(r.shift)}</span>}
                    </li>
                  ))}
                </ol>
                              </div>
            ) : (
              <p className="empty-line">{h.query.trim() ? `No document in this corpus matches "${h.query}".` : 'Type a query to see BM25 at work.'}</p>
            )}
          </div>
        </div>
      </section>

      <section className="section anatomy" id="how">
        <div className="sec-in anatomy-in">
          <div>
            <p className="eyebrow">Score anatomy</p>
            <h2>Every score is a stack of decisions.</h2>
            <p>This is the current top hit from the search above, rebuilt from its explain tree: <b>{top ? TITLES[top.id] : 'no result yet'}</b>. Move the sliders and the layers change size, because each one is recomputed from the same statistics Elasticsearch reports.</p>
            <ul className="formula">
              <li><code>score = boost × idf × tf</code></li>
              <li><code>idf = ln(1 + (N − n + 0.5) / (n + 0.5))</code></li>
              <li><code>tf = freq / (freq + k1 × (1 − b + b × dl / avgdl))</code></li>
            </ul>
            <p className="muted small">In explain output, ES folds (k1 + 1) into <code>boost</code>, which is why an unboosted clause reads 2.2. Relevance Lab separates them for you.</p>
          </div>
          {layers.length > 0 ? <IsoStack layers={layers} total={Math.max(7, layers.reduce((a, l) => a + l.value, 0))} /> : <div className="iso-empty">Search for something to build a stack.</div>}
        </div>
      </section>

      <section className="section soft">
        <div className="sec-in">
          <p className="eyebrow center">Beyond the explain tree</p>
          <h2 className="center">Reading a tree is step one. Fixing the ranking is the job.</h2>
          <div className="cards four">
            <article className="card accent-teal static">
              <h3>Compare any two hits</h3>
              <p>Term by term, split into boost, IDF, frequency and length. Then the smallest boost, k1, b or tie_breaker change that flips them, tested with a full replay.</p>
              <a className="arrow-link" {...link('/app?sample=ecommerce&tab=compare')}>Why did the cable win <i aria-hidden="true">⟶</i></a>
            </article>
            <article className="card accent-blue static">
              <h3>Replay BM25 locally</h3>
              <p>Move k1, b, boosts and max_boost. Watch ranks shift, knob by knob, with a sanity check that the replay matches what Elasticsearch reported.</p>
              <a className="arrow-link" {...link('/app?sample=field-dominance&tab=tune&fix=1')}>Tune title vs body <i aria-hidden="true">⟶</i></a>
            </article>
            <article className="card accent-pink static">
              <h3>Debug hybrid search</h3>
              <p>Replay RRF and linear fusion with minmax or l2_norm. See score scale mismatch, who wins and why, and which documents each retriever alone would miss.</p>
              <a className="arrow-link" {...link('/app?sample=docs-rrf&tab=hybrid')}>Open the RRF flow <i aria-hidden="true">⟶</i></a>
            </article>
            <article className="card accent-yellow static">
              <h3>Prove it helped</h3>
              <p>Mark results relevant to get nDCG, MRR and precision before and after. Copy the tuned query. Lints catch boost swamping, IDF skew and analyzer mismatch.</p>
              <a className="arrow-link" {...link('/app?sample=ecommerce&tab=lints')}>See the lints <i aria-hidden="true">⟶</i></a>
            </article>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="sec-in">
          <p className="eyebrow center">Three ways rankings go wrong</p>
          <h2 className="center">Start from a realistic failure.</h2>
          <div className="sample-list">
            {SAMPLES.map((s, i) => (
              <a key={s.id} className="sample-row" {...link(`/app?sample=${s.id}`)}>
                <span className="sample-n">0{i + 1}</span>
                <span className="sample-main"><b>{s.name}</b><span>{s.blurb}</span></span>
                <span className="sample-tag">{s.problem}</span>
                <i aria-hidden="true">⟶</i>
              </a>
            ))}
            <a className="sample-row" {...link('/app?tab=mini')}>
              <span className="sample-n">04</span>
              <span className="sample-main"><b>No cluster? Use the mini index.</b><span>Upload JSON documents, type a query and get real BM25 ranking in explain format, right in the browser.</span></span>
              <span className="sample-tag">bring docs</span>
              <i aria-hidden="true">⟶</i>
            </a>
          </div>
        </div>
      </section>
    </div>
  )
}
