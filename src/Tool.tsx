import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { attribute, describeTerm, ExplainParseError, fmt, parseResponse, termFacts, verdict, type Bm25, type Contribution, type Hit, type ParsedResponse } from './engine/explain.ts'
import { bumpColumns, compare, fieldStats, observedParams, replay, sanity, type Params } from './engine/replay.ts'
import { coverage, diagnose, explainWinner, linear, listsFromHits, parseList, rrf, type Normalizer, type RetrieverList } from './engine/hybrid.ts'
import { lints, metrics, parseAnalyze, parseMapping, SIMILARITY_NOTE, suggestParams, tunedQuery, type Judgments } from './engine/insights.ts'
import { buildIndex, parseDocs, search, type Analyzer } from './engine/miniindex.ts'
import { decodeState, encodeState } from './engine/share.ts'
import { HERO_CORPUS, SAMPLES } from './engine/samples.ts'
import { SearchIcon } from './icons.tsx'
import { BumpChart, ExplainTree, RrfFlow, SaturationChart, ScoreStrip, Waterfall } from './charts.tsx'

type Tab = 'explain' | 'compare' | 'tune' | 'hybrid' | 'lints' | 'mini'

interface HybridState { method: 'rrf' | 'linear'; rankConstant: number; window: number; alpha: number; normalizer: Normalizer }
interface MiniState { docs: string; query: string; boosts: Record<string, number>; analyzer: Analyzer; type: 'best_fields' | 'most_fields'; k1: number; b: number }

interface Workspace {
  sample?: string
  response: string
  analyze: string
  mapping: string
  query: string
  keyword: string
  vector: string
  queryText: string
  judgments: Judgments
  params: Params
  hybrid: HybridState
  mini: MiniState
  tab: Tab
}

const KEY = 'relevance-lab:v1'
const defaultMini: MiniState = { docs: JSON.stringify(HERO_CORPUS, null, 1), query: 'search relevance', boosts: { title: 2, body: 1 }, analyzer: 'english', type: 'best_fields', k1: 1.2, b: 0.75 }
const blank: Workspace = {
  response: '', analyze: '', mapping: '', query: '', keyword: '', vector: '', queryText: '', judgments: {}, params: {},
  hybrid: { method: 'rrf', rankConstant: 60, window: 10, alpha: 0.5, normalizer: 'minmax' }, mini: defaultMini, tab: 'explain',
}

function fromSample(id: string, prev: Workspace): Workspace {
  const s = SAMPLES.find((x) => x.id === id) ?? SAMPLES[0]
  return {
    ...prev, sample: s.id, response: s.response, analyze: s.analyze ?? '', mapping: s.mapping ?? '', query: s.query ?? '', keyword: s.keyword ?? '', vector: s.vector ?? '',
    queryText: s.queryText ?? '', judgments: s.judgments, params: {}, tab: s.id === 'docs-rrf' ? 'hybrid' : prev.tab === 'mini' || prev.tab === 'hybrid' ? 'explain' : prev.tab,
    hybrid: blank.hybrid,
  }
}

function loadInitial(): Workspace {
  const q = new URLSearchParams(location.search)
  let ws = blank
  try {
    const saved = localStorage.getItem(KEY)
    if (saved) ws = { ...blank, ...JSON.parse(saved) }
  } catch { /* corrupted storage falls back to a clean workspace */ }
  const sample = q.get('sample')
  if (sample) ws = fromSample(sample, ws)
  const tab = q.get('tab') as Tab | null
  if (tab) ws = { ...ws, tab }
  return ws
}

const SHARE_KEYS: (keyof Workspace)[] = ['params', 'judgments', 'hybrid', 'tab']

export default function Tool() {
  const [ws, setWs] = useState<Workspace>(loadInitial)
  const [dataOpen, setDataOpen] = useState(false)
  const [toast, setToast] = useState('')
  const patch = useCallback((p: Partial<Workspace>) => setWs((w) => ({ ...w, ...p })), [])

  useEffect(() => {
    const h = location.hash.match(/^#s=(.+)$/)
    if (!h) return
    decodeState<Partial<Workspace>>(h[1])
      .then((state) => setWs((w) => {
        const base = state.sample ? fromSample(state.sample, w) : w
        return { ...base, ...state }
      }))
      .catch(() => setToast('That share link is damaged and could not be opened.'))
  }, [])
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(KEY, JSON.stringify(ws))
      } catch { /* over quota: the workspace still works for this session */ }
    }, 250)
    return () => clearTimeout(t)
  }, [ws])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 2600)
    return () => clearTimeout(t)
  }, [toast])

  const parsed = useMemo<{ data?: ParsedResponse; error?: ExplainParseError | Error }>(() => {
    if (!ws.response.trim()) return {}
    try {
      return { data: parseResponse(ws.response) }
    } catch (e) {
      return { error: e as Error }
    }
  }, [ws.response])

  const hits = parsed.data?.hits
  const share = async () => {
    const state: Record<string, unknown> = {}
    if (ws.sample) state.sample = ws.sample
    else Object.assign(state, { response: ws.response, analyze: ws.analyze, mapping: ws.mapping, query: ws.query, keyword: ws.keyword, vector: ws.vector, queryText: ws.queryText })
    for (const k of SHARE_KEYS) state[k] = ws[k]
    if (ws.tab === 'mini') state.mini = ws.mini
    const code = await encodeState(state)
    const url = `${location.origin}/app#s=${code}`
    history.replaceState({}, '', url)
    const big = url.length > 60000
    try {
      await navigator.clipboard.writeText(url)
      setToast(big ? 'Link copied, but it is long. Some apps truncate URLs over 60 KB.' : 'Share link copied.')
    } catch {
      setToast('Link is in the address bar. Clipboard access was blocked.')
    }
  }

  const tabs: { id: Tab; label: string; needs?: boolean }[] = [
    { id: 'explain', label: 'Explain', needs: true },
    { id: 'compare', label: 'Compare', needs: true },
    { id: 'tune', label: 'Tune', needs: true },
    { id: 'hybrid', label: 'Hybrid' },
    { id: 'lints', label: 'Lints', needs: true },
    { id: 'mini', label: 'Mini index' },
  ]
  const lintCount = useMemo(() => (hits ? buildLints(hits, ws).filter((l) => l.severity !== 'info').length : 0), [hits, ws.analyze, ws.mapping])
  const activeSample = SAMPLES.find((s) => s.id === ws.sample)

  return (
    <div className="lab">
      <div className="lab-bar">
        <div className="lab-bar-in">
          <div className="lab-source">
            <span className="eyebrow plain">Workspace</span>
            <select aria-label="Load a sample" value={ws.sample ?? ''} onChange={(e) => e.target.value && setWs((w) => fromSample(e.target.value, w))}>
              <option value="">{ws.response ? 'Your response' : 'Choose a sample'}</option>
              {SAMPLES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            {hits && <span className="pill">{hits.length} hits{parsed.data?.total ? ` of ${parsed.data.total.toLocaleString('en-US')}` : ''}</span>}
          </div>
          <div className="lab-actions">
            <button className="btn ghost sm" onClick={() => setDataOpen(true)}>Paste or upload</button>
            <button className="btn ghost sm" onClick={share}>Copy share link</button>
          </div>
        </div>
        <div className="tabs" role="tablist" aria-label="Lab views">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={ws.tab === t.id}
              aria-controls="lab-panel"
              tabIndex={ws.tab === t.id ? 0 : -1}
              disabled={t.needs && !hits}
              className="tab"
              onClick={() => patch({ tab: t.id })}
              onKeyDown={(e) => {
                const enabled = tabs.filter((x) => !(x.needs && !hits))
                const at = enabled.findIndex((x) => x.id === t.id)
                const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
                if (!d) return
                e.preventDefault()
                const next = enabled[(at + d + enabled.length) % enabled.length]
                patch({ tab: next.id })
                document.getElementById(`tab-${next.id}`)?.focus()
              }}
            >
              {t.label}
              {t.id === 'lints' && lintCount > 0 && <span className="count">{lintCount}</span>}
            </button>
          ))}
        </div>
      </div>

      <div id="lab-panel" role="tabpanel" aria-labelledby={`tab-${ws.tab}`} className="lab-panel">
        {parsed.error && ws.tab !== 'mini' && (
          <ErrorCard error={parsed.error} onFix={() => setDataOpen(true)} />
        )}
        {parsed.data?.notes.map((n) => <p className="note" key={n}>{n}</p>)}
        {activeSample && ws.tab !== 'mini' && <p className="sample-note"><b>{activeSample.name}.</b> {activeSample.blurb}</p>}
        {!hits && !parsed.error && ws.tab !== 'mini' && ws.tab !== 'hybrid' && (
          <Empty onSample={(id) => setWs((w) => fromSample(id, w))} onPaste={() => setDataOpen(true)} onMini={() => patch({ tab: 'mini' })} />
        )}
        {hits && ws.tab === 'explain' && <ExplainView hits={hits} />}
        {hits && ws.tab === 'compare' && <CompareView hits={hits} ws={ws} onApply={(params) => patch({ params, tab: 'tune' })} />}
        {hits && ws.tab === 'tune' && <TuneView hits={hits} ws={ws} patch={patch} toast={setToast} goHybrid={() => patch({ tab: 'hybrid' })} />}
        {ws.tab === 'hybrid' && <HybridView hits={hits} ws={ws} patch={patch} toast={setToast} />}
        {hits && ws.tab === 'lints' && <LintView hits={hits} ws={ws} openData={() => setDataOpen(true)} />}
        {ws.tab === 'mini' && <MiniView ws={ws} patch={patch} send={(response, queryText) => setWs((w) => ({ ...w, sample: undefined, response, queryText, analyze: '', mapping: '', query: '', keyword: '', vector: '', judgments: {}, params: {}, tab: 'explain' }))} />}
      </div>

      <DataDialog open={dataOpen} onClose={() => setDataOpen(false)} ws={ws} commit={(p) => { setWs((w) => ({ ...w, sample: undefined, judgments: p.response !== w.response ? {} : w.judgments, params: p.response !== w.response ? {} : w.params, ...p })); setDataOpen(false) }} />
      <div className={`toast${toast ? ' on' : ''}`} role="status" aria-live="polite">{toast}</div>
    </div>
  )
}

function buildLints(hits: Hit[], ws: Workspace) {
  let analyzeTokens: string[] | undefined
  let mapping: ReturnType<typeof parseMapping> | undefined
  try { if (ws.analyze.trim()) analyzeTokens = parseAnalyze(ws.analyze) } catch { /* surfaced in LintView */ }
  try { if (ws.mapping.trim()) mapping = parseMapping(ws.mapping) } catch { /* surfaced in LintView */ }
  return lints(hits, { analyzeTokens, mapping })
}

// ---- States ---------------------------------------------------------------------------

function ErrorCard({ error, onFix }: { error: Error; onFix: () => void }) {
  const hint = error instanceof ExplainParseError ? error.hint : undefined
  return (
    <div className="err-card" role="alert">
      <span className="sev critical">Unsupported input</span>
      <h2>{error.message}</h2>
      {hint && <p>{hint}</p>}
      <p className="muted">Nothing was guessed from this input. Scores stay unavailable until the shape is one the parser fully understands.</p>
      <button className="btn secondary sm" onClick={onFix}>Edit the input</button>
    </div>
  )
}

function Empty({ onSample, onPaste, onMini }: { onSample: (id: string) => void; onPaste: () => void; onMini: () => void }) {
  return (
    <div className="empty">
      <div className="empty-head">
        <p className="eyebrow">Start here</p>
        <h1>Show me a response with <code>explain: true</code>.</h1>
        <p>Paste one from your cluster, load a sample, or build a small index right here with no cluster at all.</p>
        <div className="row">
          <button className="btn primary" onClick={onPaste}>Paste a response</button>
          <button className="btn secondary" onClick={onMini}>Try the mini index</button>
        </div>
      </div>
      <div className="cards three">
        {SAMPLES.map((s, i) => (
          <button key={s.id} className={`card accent-${['teal', 'pink', 'blue'][i]}`} onClick={() => onSample(s.id)}>
            <span className="eyebrow plain">{s.problem}</span>
            <h3>{s.name}</h3>
            <p>{s.blurb}</p>
            <span className="arrow-link">Load sample <i aria-hidden="true">⟶</i></span>
          </button>
        ))}
      </div>
    </div>
  )
}

function DataDialog({ open, onClose, ws, commit }: { open: boolean; onClose: () => void; ws: Workspace; commit: (p: Pick<Workspace, 'response' | 'analyze' | 'mapping' | 'query'>) => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [draft, setDraft] = useState({ response: ws.response, analyze: ws.analyze, mapping: ws.mapping, query: ws.query })
  const [err, setErr] = useState<string>('')
  const [drag, setDrag] = useState(false)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      setDraft({ response: ws.response, analyze: ws.analyze, mapping: ws.mapping, query: ws.query })
      setErr('')
      d.showModal()
    } else if (!open && d.open) d.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const field = (k: keyof typeof draft, label: string, hint: string, rows: number, required = false) => (
    <label className="field">
      <span className="field-head"><b>{label}</b>{required ? <em>required</em> : <em>optional</em>}<small>{hint}</small></span>
      <textarea rows={rows} spellCheck={false} value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
    </label>
  )
  const readFile = (file: File) => file.text().then((t) => setDraft((d) => ({ ...d, response: t })))
  return (
    <dialog ref={ref} className="dlg" onClose={onClose} onCancel={onClose}>
      <form method="dialog" onSubmit={(e) => {
        e.preventDefault()
        try {
          if (draft.analyze.trim()) parseAnalyze(draft.analyze)
          if (draft.mapping.trim()) parseMapping(draft.mapping)
          if (draft.query.trim()) JSON.parse(draft.query)
          setErr('')
          commit(draft)
        } catch (x) {
          setErr(`Optional input problem: ${(x as Error).message}`)
        }
      }}>
        <header className="dlg-head">
          <h2>Bring your own response</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button>
        </header>
        <div className={`dlg-body${drag ? ' drag' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) void readFile(f) }}
        >
          {field('response', 'Search or _explain response', 'hits.hits[]._explanation, _explain output, or a bare explanation node', 9, true)}
          <div className="row">
            <label className="btn ghost sm file">Upload JSON
              <input type="file" accept=".json,application/json,text/plain" onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f) }} />
            </label>
            <span className="muted small">or drop a file anywhere here. It stays in this browser.</span>
          </div>
          <div className="two">
            {field('analyze', '_analyze output', 'tokens[] or detail{}', 5)}
            {field('mapping', 'Mapping', 'GET <index>/_mapping', 5)}
          </div>
          {field('query', 'Original query body', 'lets the tuned query patch your real request', 4)}
          <details className="tip-box">
            <summary>How to capture this</summary>
            <pre>{`POST /my-index/_search
{
  "explain": true,
  "size": 20,
  "query": { "match": { "title": "my query" } }
}

POST /my-index/_analyze
{ "field": "title", "text": "my query" }`}</pre>
          </details>
          {err && <p className="field-err" role="alert">{err}</p>}
        </div>
        <footer className="dlg-foot">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary">Analyze</button>
        </footer>
      </form>
    </dialog>
  )
}

// ---- Colors ---------------------------------------------------------------------------

function useColors(hits: Hit[]) {
  return useMemo(() => {
    const fields = [...new Set(fieldStats(hits).map((f) => f.field))]
    const slot = (field: string) => {
      const i = fields.indexOf(field)
      return i >= 0 && i < 4 ? `var(--c${i + 1})` : 'var(--flat)'
    }
    const contrib = (c: Contribution) => {
      if (c.kind === 'function') return 'var(--c5)'
      if (c.kind === 'retriever') return `var(--c${c.source?.index === 0 ? 1 : 3})`
      if (c.kind === 'opaque') return 'var(--flat)'
      return c.field ? slot(c.field) : 'var(--flat)'
    }
    return { slot, contrib }
  }, [hits])
}

const titleOf = (h: Hit) => (typeof h.source?.title === 'string' ? h.source.title : typeof h.source?.name === 'string' ? h.source.name : h.id)

// ---- Explain --------------------------------------------------------------------------

function ExplainView({ hits }: { hits: Hit[] }) {
  const [id, setId] = useState(hits[0].id)
  const [focus, setFocus] = useState<string>()
  const hit = hits.find((h) => h.id === id) ?? hits[0]
  const v = useMemo(() => verdict(hit), [hit])
  const contribs = useMemo(() => attribute(hit.root), [hit])
  const colors = useColors(hits)
  const terms = contribs.filter((c) => c.bm25)
  const maxScore = Math.max(...hits.map((h) => h.score), 1e-9)
  return (
    <div className="explain">
      <aside className="hit-rail" aria-label="Hits">
        {hits.map((h) => {
          const parts = attribute(h.root).filter((c) => c.value > 0)
          return (
            <button key={h.id} className={`hit${h.id === hit.id ? ' on' : ''}`} onClick={() => { setId(h.id); setFocus(undefined) }} aria-pressed={h.id === hit.id}>
              <span className="hit-rank">{h.rank}</span>
              <span className="hit-main">
                <span className="hit-title">{titleOf(h)}</span>
                <span className="hit-bar" style={{ width: `${(h.score / maxScore) * 100}%` }}>
                  {parts.map((c) => <i key={c.key + c.nodeId} style={{ flexGrow: c.value, background: colors.contrib(c) }} />)}
                </span>
                <span className="hit-meta">{h.id}{h.shard ? ` · ${h.shard.replace(/^\[[^\]]*\]/, 'shard ').replace(/[[\]]/g, '')}` : ''}</span>
              </span>
              <span className="hit-score">{fmt(h.score)}</span>
            </button>
          )
        })}
      </aside>
      <div className="explain-main">
        <section className="panel verdict">
          <p className="eyebrow">Verdict for rank {hit.rank}</p>
          <h2>{v.headline}</h2>
          <div className="by-field">
            {v.byField.map((f) => (
              <span key={f.field} className="legend-chip" data-tip={`${fmt(f.value, 3)} points`}>
                <i style={{ background: f.field === 'function_score' ? 'var(--c5)' : /vector/.test(f.field) ? 'var(--c3)' : /keyword/.test(f.field) ? 'var(--c1)' : colors.slot(f.field) }} />
                {f.field} <b>{Math.round(f.pct)}%</b>
              </span>
            ))}
          </div>
          <ul className="bullets">{v.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>
          {hit.warnings.length > 0 && <div className="warn-box" role="alert"><span className="sev warning">Partly unsupported</span>{hit.warnings.map((w) => <p key={w}>{w}</p>)}</div>}
        </section>
        <section className="panel">
          <h3 className="panel-title">Score waterfall</h3>
          <p className="panel-sub">Additive steps from zero to _score. Multipliers appear as the points they add.</p>
          <Waterfall contribs={contribs} score={hit.score} colorOf={colors.contrib} onSelect={setFocus} />
        </section>
        {terms.length > 0 && (
          <section className="panel">
            <h3 className="panel-title">BM25 factors</h3>
            <div className="scroll-x">
              <table className="tbl">
                <thead><tr><th>Clause</th><th className="num">Boost</th><th className="num">IDF</th><th className="num">freq</th><th className="num">TF / ceiling</th><th className="num">dl / avgdl</th><th className="num">Length effect</th><th className="num">Points</th></tr></thead>
                <tbody>
                  {terms.map((c) => {
                    const t = c.bm25!
                    const facts = termFacts(t)
                    const e = Math.round((facts.lengthEffect - 1) * 100)
                    return (
                      <tr key={c.nodeId} className={c.shadowed ? 'dimmed' : ''} data-tip={describeTerm(c.shadowed ? { ...c, value: c.shadowed } : c, hit.score)}>
                        <td><code>{c.label}</code></td>
                        <td className="num">×{fmt(t.queryBoost)}</td>
                        <td className="num">{fmt(t.idf)}</td>
                        <td className="num">{t.freq}</td>
                        <td className="num"><span className="meter"><i style={{ width: `${facts.saturation * 100}%` }} /></span>{Math.round(facts.saturation * 100)}%</td>
                        <td className="num">{t.dl}{t.dlApprox ? '≈' : ''} / {fmt(t.avgdl, 1)}</td>
                        <td className="num">{e >= 0 ? '+' : ''}{e}%</td>
                        <td className="num strong">{c.shadowed ? <span data-tip="dis_max discarded this clause">0 <s>{fmt(c.shadowed)}</s></span> : fmt(c.value, 3)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="panel-note">ES folds k1 + 1 into the Lucene <code>boost</code> node, so an unboosted clause explains as boost 2.2. The table shows your real boost. Lucene stores long field lengths lossily in one byte, so those are marked ≈.</p>
          </section>
        )}
        <section className="panel">
          <h3 className="panel-title">Explanation tree</h3>
          <ExplainTree root={hit.root} focus={focus} />
        </section>
      </div>
    </div>
  )
}

// ---- Compare --------------------------------------------------------------------------

function HitSelect({ hits, value, onChange, label }: { hits: Hit[]; value: string; onChange: (id: string) => void; label: string }) {
  return (
    <label className="select-field">
      <span className="eyebrow plain">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {hits.map((h) => <option key={h.id} value={h.id}>#{h.rank} {titleOf(h)}</option>)}
      </select>
    </label>
  )
}

function CompareView({ hits, ws, onApply }: { hits: Hit[]; ws: Workspace; onApply: (p: Params) => void }) {
  const relevantBelow = [...hits.slice(1)].sort((x, y) => (ws.judgments[y.id] ?? 0) - (ws.judgments[x.id] ?? 0) || x.rank - y.rank).find((h) => (ws.judgments[h.id] ?? 0) > (ws.judgments[hits[0].id] ?? 0))
  const [a, setA] = useState(hits[0].id)
  const [b, setB] = useState((relevantBelow ?? hits[1] ?? hits[0]).id)
  const colors = useColors(hits)
  const valid = hits.some((h) => h.id === a) && hits.some((h) => h.id === b)
  if (hits.length < 2) return <p className="note">Compare needs at least two hits. Paste a search response rather than a single _explain.</p>
  if (!valid || a === b) {
    return (
      <div className="panel">
        <div className="compare-pick">
          <HitSelect hits={hits} value={hits.some((h) => h.id === a) ? a : hits[0].id} onChange={setA} label="Document A" />
          <HitSelect hits={hits} value={hits.some((h) => h.id === b) ? b : hits[1].id} onChange={setB} label="Document B" />
        </div>
        <p className="note">Pick two different documents.</p>
      </div>
    )
  }
  const c = compare(hits, a, b)
  const scale = Math.max(...c.terms.flatMap((t) => [t.a?.value ?? 0, t.b?.value ?? 0, t.a?.shadowed ?? 0, t.b?.shadowed ?? 0]), 1e-9)
  const best = c.flips[0]
  const isFusion = c.terms.some((t) => t.a?.kind === 'retriever' || t.b?.kind === 'retriever')
  return (
    <div className="compare">
      <section className="panel compare-head">
        <div className="compare-pick">
          <HitSelect hits={hits} value={a} onChange={setA} label="Document A" />
          <button className="icon-btn" aria-label="Swap documents" data-tip="Swap" onClick={() => { setA(b); setB(a) }}>⇄</button>
          <HitSelect hits={hits} value={b} onChange={setB} label="Document B" />
        </div>
        <p className="big-claim">{c.summary}</p>
      </section>

      <section className="panel">
        <h3 className="panel-title">Term by term</h3>
        <div className="diff-head"><span>{c.winner.id} <b>{fmt(c.winner.score, 3)}</b></span><span>Clause</span><span>{c.loser.id} <b>{fmt(c.loser.score, 3)}</b></span></div>
        <div className="diff">
          {c.terms.map((t) => {
            const color = colors.contrib((t.a ?? t.b)!)
            return (
              <div className="diff-row" key={t.key}>
                <div className="diff-bar left">
                  <span className="diff-num">{t.a ? (t.a.shadowed ? <s>{fmt(t.a.shadowed)}</s> : fmt(t.a.value, 3)) : '–'}</span>
                  <span className="diff-track"><i style={{ width: `${((t.a?.value ?? 0) / scale) * 100}%`, background: color }} />{t.a?.shadowed ? <i className="ghost" style={{ width: `${(t.a.shadowed / scale) * 100}%`, borderColor: color }} /> : null}</span>
                </div>
                <div className="diff-mid">
                  <code>{t.label}</code>
                  {Math.abs(t.delta) < 1e-6 ? <span className="delta">no effect on the gap</span> : <span className={`delta ${t.delta >= 0 ? 'pos' : 'neg'}`}>{t.delta >= 0 ? '+' : ''}{fmt(t.delta, 3)} for {t.delta >= 0 ? c.winner.id : c.loser.id}</span>}
                  <small>{t.cause}</small>
                  {t.effects && (
                    <span className="effects">
                      {(['boost', 'idf', 'freq', 'length'] as const).filter((k) => Math.abs(t.effects![k]) > 0.005).map((k) => (
                        <em key={k} data-tip={`Share of this difference explained by ${k}`}>{k} {t.effects![k] >= 0 ? '+' : ''}{fmt(t.effects![k])}</em>
                      ))}
                    </span>
                  )}
                </div>
                <div className="diff-bar right">
                  <span className="diff-track"><i style={{ width: `${((t.b?.value ?? 0) / scale) * 100}%`, background: color }} />{t.b?.shadowed ? <i className="ghost" style={{ width: `${(t.b.shadowed / scale) * 100}%`, borderColor: color }} /> : null}</span>
                  <span className="diff-num">{t.b ? (t.b.shadowed ? <s>{fmt(t.b.shadowed)}</s> : fmt(t.b.value, 3)) : '–'}</span>
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section className="panel">
        <h3 className="panel-title">Smallest change that flips the order</h3>
        {isFusion ? (
          <p className="panel-sub">RRF uses only ranks, so document content cannot be tuned here. Change rank_constant or rank_window_size, or move a retriever's ranks, in the Hybrid tab.</p>
        ) : !c.flips.length ? (
          <p className="panel-sub">No single boost, k1, b or tie_breaker change in range puts {c.loser.id} ahead. The gap is structural: the document lacks the terms that matter.</p>
        ) : (
          <>
            <p className="panel-sub">Best bet: <b>{best.title}</b>. Every option below was tested with a full replay of all {hits.length} hits.</p>
            <ul className="flips">
              {c.flips.slice(0, 7).map((f, i) => (
                <li key={f.title} className={i === 0 ? 'top' : ''}>
                  <span className={`flip-type t-${f.type}`}>{f.type}</span>
                  <div>
                    <b>{f.title}</b>
                    <p>{f.detail}</p>
                  </div>
                  <span className="flip-side">{f.params ? (f.sideEffects ? `moves ${f.sideEffects} other hit${f.sideEffects > 1 ? 's' : ''}` : 'no other hits move') : f.estimate ? 'estimate' : 'edit document'}</span>
                  {f.params && <button className="btn ghost sm" onClick={() => onApply(f.params!)}>Replay</button>}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  )
}

// ---- Tune -----------------------------------------------------------------------------

function Slider({ label, value, min, max, step, onChange, base, display, hint }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; base?: number; display?: string; hint?: string }) {
  const pct = ((value - min) / (max - min)) * 100
  const basePct = base != null ? ((base - min) / (max - min)) * 100 : undefined
  return (
    <label className="slider">
      <span className="slider-head"><span>{label}</span><output>{display ?? value.toFixed(2)}</output></span>
      <span className="slider-track">
        <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} style={{ '--p': `${pct}%` } as React.CSSProperties} />
        {basePct != null && <i className="slider-base" style={{ left: `${basePct}%` }} aria-hidden="true" />}
      </span>
      {hint && <small>{hint}</small>}
    </label>
  )
}

function JudgeButtons({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  return (
    <span className="judge" role="group" aria-label={`Judgment for ${label}`}>
      {[['No', 0], ['Rel', 1], ['High', 2]].map(([t, v]) => (
        <button key={v} className={`g${v}${value === v ? ' on' : ''}`} aria-pressed={value === v} onClick={() => onChange(v as number)}>{t}</button>
      ))}
    </span>
  )
}

function MetricCell({ label, before, after }: { label: string; before: number; after: number }) {
  const d = after - before
  return (
    <div className="metric">
      <span className="eyebrow plain">{label}</span>
      <b>{after.toFixed(3)}</b>
      <span className={`metric-d ${d > 0.0005 ? 'up' : d < -0.0005 ? 'down' : ''}`}>{Math.abs(d) < 0.0005 ? 'no change' : `${d > 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(3)} from ${before.toFixed(3)}`}</span>
    </div>
  )
}

function CopyBlock({ text, label, toast }: { text: string; label: string; toast: (s: string) => void }) {
  return (
    <div className="copyblock">
      <button className="btn ghost sm" onClick={() => navigator.clipboard.writeText(text).then(() => toast(`${label} copied.`), () => toast('Clipboard access was blocked.'))}>Copy</button>
      <pre tabIndex={0} aria-label={label}>{text}</pre>
    </div>
  )
}

function TuneView({ hits, ws, patch, toast, goHybrid }: { hits: Hit[]; ws: Workspace; patch: (p: Partial<Workspace>) => void; toast: (s: string) => void; goHybrid: () => void }) {
  const obs = useMemo(() => observedParams(hits), [hits])
  const stats = useMemo(() => fieldStats(hits), [hits])
  const check = useMemo(() => sanity(hits), [hits])
  const p = ws.params
  const set = (next: Params) => patch({ params: { ...p, ...next } })
  const k1 = p.k1 ?? obs.k1
  const b = p.b ?? obs.b
  const rows = useMemo(() => replay(hits, p), [hits, p])
  const cols = useMemo(() => bumpColumns(hits, p), [hits, p])
  const titles = useMemo(() => Object.fromEntries(hits.map((h) => [h.id, titleOf(h)])), [hits])
  const colors = useColors(hits)
  const [k, setK] = useState(5)
  const before = metrics(hits.map((h) => h.id), ws.judgments, k)
  const after = metrics(rows.map((r) => r.id), ws.judgments, k)
  const judged = Object.values(ws.judgments).some((v) => v > 0)
  const terms = useMemo(() => {
    const seen = new Set<string>()
    const out: Bm25[] = []
    for (const r of rows.slice(0, 5)) {
      for (const c of attribute(r.hit.root)) {
        if (c.bm25 && !seen.has(r.id + c.key)) {
          seen.add(r.id + c.key)
          out.push(c.bm25)
        }
      }
    }
    return out
  }, [rows])
  const fit = useCallback(() => {
    const out = suggestParams(hits, ws.judgments, k)
    patch({ params: out.params })
    toast(out.changed.length ? `Fitted ${out.changed.join(', ')}: nDCG@${k} ${out.before.toFixed(3)} to ${out.after.toFixed(3)}.` : 'No knob in range improved these judgments.')
  }, [hits, ws.judgments, k, patch, toast])
  useEffect(() => {
    if (new URLSearchParams(location.search).get('fix') !== '1' || !judged || Object.keys(ws.params).length) return
    // Deep links play the fix after a beat, so the bump lines visibly move.
    const t = setTimeout(fit, 700)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const dirty = Object.keys(p).some((key) => (p as Record<string, unknown>)[key] != null)
  const query = useMemo(() => tunedQuery(hits, p, { queryText: ws.queryText, original: ws.query }), [hits, p, ws.queryText, ws.query])

  if (!check.replayable) {
    return (
      <div className="panel">
        <span className="sev warning">Nothing to replay</span>
        <h2 className="panel-h2">This response has no BM25 clauses at the top level of its scoring.</h2>
        <p>RRF and linear retrievers fuse ranks or normalized scores, so k1 and b do not change them directly. Tune fusion in the Hybrid tab, or paste each retriever's own response here.</p>
        <button className="btn primary sm" onClick={goHybrid}>Open the hybrid debugger</button>
      </div>
    )
  }
  return (
    <div className="tune">
      <aside className="panel tune-side">
        <div className="row spread">
          <h3 className="panel-title">Replay controls</h3>
          <button className="btn text sm" disabled={!dirty} onClick={() => patch({ params: {} })}>Reset</button>
        </div>
        {judged && <button className="btn secondary sm" onClick={fit} data-tip="Searches boosts, tie_breaker, max_boost, k1 and b for the best nDCG on these judgments">Fit knobs to my judgments</button>}
        <div className={`sanity ${check.ok ? 'ok' : 'bad'}`} role="status">
          <b>{check.ok ? '✓ Replay matches ES' : '✕ Replay disagrees with ES'}</b>
          <span>Largest error {check.maxErrorPct.toFixed(4)}% over {check.checked} hits. Tolerance 0.5%.</span>
          {check.fixedShare > 0.005 && <span>{Math.round(check.fixedShare * 100)}% of score mass comes from functions, constants or kNN. Replay holds those fixed, apart from max_boost.</span>}
          {!check.ok && check.worst && <span>Worst: {check.worst.id}, ES {check.worst.es.toFixed(3)}, replay {check.worst.replay.toFixed(3)}. Rank changes below are unreliable.</span>}
        </div>
        <Slider label="k1 · saturation" value={k1} min={0} max={3} step={0.01} base={obs.k1} onChange={(v) => set({ k1: v })} />
        <Slider label="b · length norm" value={b} min={0} max={1} step={0.01} base={obs.b} onChange={(v) => set({ b: v })} />
        {obs.hasTie && <Slider label="tie_breaker" value={p.tie ?? obs.tie} min={0} max={1} step={0.01} base={obs.tie} onChange={(v) => set({ tie: v })} />}
        {obs.hasFunctions && <Slider label="max_boost" value={Math.min(p.maxBoost ?? obs.maxUplift, Math.ceil(obs.maxUplift))} min={1} max={Math.ceil(obs.maxUplift)} step={0.05} base={obs.maxUplift} onChange={(v) => set({ maxBoost: v })} hint="Caps the function_score multiplier." />}
        <div className="slider-group">
          <span className="eyebrow plain">Per-field boosts</span>
          {stats.map((f) => {
            const m = p.fieldBoost?.[f.field] ?? 1
            const eff = f.observedBoost * m
            const max = Math.max(5, f.observedBoost * 2)
            return <Slider key={f.field} label={f.field} value={eff} min={0} max={max} step={max > 10 ? 0.1 : 0.05} base={f.observedBoost} display={`^${eff.toFixed(2)}`} onChange={(v) => set({ fieldBoost: { ...p.fieldBoost, [f.field]: v / f.observedBoost } })} />
          })}
        </div>
        <div className="warn-box soft">
          <span className="sev info">Changing k1 or b on a real index</span>
          <p>{SIMILARITY_NOTE} <a href="https://www.elastic.co/docs/reference/elasticsearch/index-settings/similarity" target="_blank" rel="noreferrer">Similarity docs</a></p>
        </div>
      </aside>
      <div className="tune-main">
        <section className="panel">
          <div className="row spread">
            <div>
              <h3 className="panel-title">Rank shift, knob by knob</h3>
              <p className="panel-sub">Each column applies one more change, so you can see which knob moved which document.</p>
            </div>
            <span className="legend-row"><span className="legend-chip"><i style={{ background: 'var(--up)' }} />rises</span><span className="legend-chip"><i style={{ background: 'var(--down)' }} />falls</span><span className="legend-chip"><i style={{ background: 'var(--flat)' }} />flat</span></span>
          </div>
          <div className="scroll-x"><div className="min-chart"><BumpChart columns={cols} titles={titles} /></div></div>
        </section>
        <div className="grid-2">
          <section className="panel">
            <h3 className="panel-title">BM25 saturation</h3>
            <p className="panel-sub">Solid: live k1 and b. Dashed: as returned. Dots: terms in the top five.</p>
            <SaturationChart k1={k1} b={b} k10={obs.k1} b0={obs.b} terms={terms} colorOf={colors.slot} />
          </section>
          <section className="panel">
            <div className="row spread">
              <h3 className="panel-title">Before and after</h3>
              <label className="inline-select">k <select value={k} onChange={(e) => setK(+e.target.value)}>{[3, 5, 10].map((x) => <option key={x}>{x}</option>)}</select></label>
            </div>
            {judged ? (
              <div className="metrics">
                <MetricCell label={`nDCG@${k}`} before={before.ndcg} after={after.ndcg} />
                <MetricCell label="MRR" before={before.mrr} after={after.mrr} />
                <MetricCell label={`P@${k}`} before={before.precision} after={after.precision} />
              </div>
            ) : <p className="panel-sub">Mark results below to light up nDCG, MRR and precision.</p>}
            {judged && dirty && <p className="panel-note">Measured on this one query. Check tuned values against a wider judgment list with the _rank_eval API before shipping them.</p>}
            <h4 className="mini-h">Tuned query</h4>
            <CopyBlock text={query} label="Tuned query" toast={toast} />
          </section>
        </div>
        <section className="panel">
          <h3 className="panel-title">Results and judgments</h3>
          <div className="scroll-x">
            <table className="tbl">
              <thead><tr><th className="num">Rank</th><th className="num">Was</th><th>Document</th><th className="num">ES score</th><th className="num">Replay</th><th>Relevant?</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="num strong">{r.rank}</td>
                    <td className="num">{r.shift === 0 ? <span className="muted">{r.originalRank}</span> : <span className={r.shift > 0 ? 'mv up' : 'mv down'}>{r.originalRank} {r.shift > 0 ? '▲' : '▼'}{Math.abs(r.shift)}</span>}</td>
                    <td><span className="doc-title">{titleOf(r.hit)}</span><small className="muted block">{r.id}</small></td>
                    <td className="num">{fmt(r.hit.score, 3)}</td>
                    <td className="num strong">{fmt(r.score, 3)}</td>
                    <td><JudgeButtons value={ws.judgments[r.id] ?? 0} label={r.id} onChange={(v) => patch({ judgments: { ...ws.judgments, [r.id]: v } })} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  )
}

// ---- Hybrid ---------------------------------------------------------------------------

function HybridView({ hits, ws, patch, toast }: { hits?: Hit[]; ws: Workspace; patch: (p: Partial<Workspace>) => void; toast: (s: string) => void }) {
  const h = ws.hybrid
  const setH = (next: Partial<HybridState>) => patch({ hybrid: { ...h, ...next } })
  const [kw, setKw] = useState(ws.keyword)
  const [vec, setVec] = useState(ws.vector)
  useEffect(() => { setKw(ws.keyword); setVec(ws.vector) }, [ws.keyword, ws.vector])
  const source = useMemo<{ lists?: RetrieverList[]; error?: string; from: string; rankConstant?: number; method?: string }>(() => {
    try {
      if (ws.keyword.trim() && ws.vector.trim()) return { lists: [parseList(ws.keyword, 'keyword'), parseList(ws.vector, 'vector')], from: 'pasted lists' }
      if (hits) {
        const r = listsFromHits(hits)
        if (r && r.lists.length >= 2) return { lists: r.lists, from: `${r.method} response`, rankConstant: r.rankConstant, method: r.method }
      }
      return { from: 'none' }
    } catch (e) {
      return { error: (e as Error).message, from: 'none' }
    }
  }, [ws.keyword, ws.vector, hits])
  const lists = source.lists
  const weights = [h.alpha, 1 - h.alpha]
  const fused = useMemo(() => {
    if (!lists) return []
    return h.method === 'rrf' ? rrf(lists, { rankConstant: h.rankConstant, windowSize: h.window }) : linear(lists, { normalizer: h.normalizer, windowSize: h.window, weights })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lists, h.method, h.rankConstant, h.window, h.normalizer, h.alpha])
  const titles = useMemo(() => Object.fromEntries((lists ?? []).flatMap((l) => l.items.map((i) => [i.id, i.title ?? i.id]))), [lists])
  const maxWindow = Math.max(10, ...(lists ?? []).map((l) => l.items.length))
  const editor = (
    <details className="panel hybrid-input" open={!lists}>
      <summary><b>Result lists</b> <span className="muted">{lists ? `from ${source.from}` : 'keyword and vector lists, or load a combined response'}</span></summary>
      <div className="two">
        <label className="field"><span className="field-head"><b>Keyword (BM25) list</b><small>search response, [{'{'}_id, _score{'}'}], or "id score" lines</small></span><textarea rows={6} spellCheck={false} value={kw} onChange={(e) => setKw(e.target.value)} /></label>
        <label className="field"><span className="field-head"><b>Vector (kNN) list</b><small>same formats</small></span><textarea rows={6} spellCheck={false} value={vec} onChange={(e) => setVec(e.target.value)} /></label>
      </div>
      <div className="row">
        <button className="btn secondary sm" onClick={() => patch({ keyword: kw, vector: vec })}>Replay these lists</button>
        <button className="btn text sm" onClick={() => patch({ sample: 'docs-rrf', ...(() => { const s = SAMPLES[1]; return { keyword: s.keyword!, vector: s.vector!, response: s.response, judgments: s.judgments, query: s.query ?? '', mapping: s.mapping ?? '', analyze: '', queryText: s.queryText ?? '' } })() })}>Load the RRF sample</button>
      </div>
      {source.error && <p className="field-err" role="alert">{source.error}</p>}
    </details>
  )
  if (!lists) {
    return (
      <div className="stack">
        {editor}
        {!source.error && <div className="note">Paste both lists above, or load a response whose explain output has an rrf, linear or query-plus-knn shape.{hits ? ' The current response has none of these.' : ''}</div>}
      </div>
    )
  }
  const size = 10
  const cov = coverage(lists, fused, h.window, size)
  const findings = diagnose(lists, h.window, size)
  const judged = Object.values(ws.judgments).some((v) => v > 0)
  const retriever = h.method === 'rrf'
    ? { retriever: { rrf: { retrievers: [{ standard: { query: { match: { body: ws.queryText || '<query>' } } } }, { knn: { field: 'body_vector', k: h.window, num_candidates: Math.max(100, h.window * 2) } }], rank_constant: h.rankConstant, rank_window_size: h.window } }, size }
    : { retriever: { linear: { retrievers: [{ retriever: { standard: { query: { match: { body: ws.queryText || '<query>' } } } }, weight: +weights[0].toFixed(2) }, { retriever: { knn: { field: 'body_vector', k: h.window, num_candidates: Math.max(100, h.window * 2) } }, weight: +weights[1].toFixed(2) }], normalizer: h.normalizer, rank_window_size: h.window } }, size }
  return (
    <div className="stack">
      {editor}
      <div className="hybrid-grid">
        <aside className="panel tune-side">
          <h3 className="panel-title">Fusion replay</h3>
          <div className="seg wide" role="radiogroup" aria-label="Fusion method">
            <button role="radio" aria-checked={h.method === 'rrf'} className={h.method === 'rrf' ? 'on' : ''} onClick={() => setH({ method: 'rrf' })}>RRF</button>
            <button role="radio" aria-checked={h.method === 'linear'} className={h.method === 'linear' ? 'on' : ''} onClick={() => setH({ method: 'linear' })}>Linear</button>
          </div>
          <Slider label="rank_window_size" value={h.window} min={1} max={maxWindow} step={1} display={String(h.window)} onChange={(v) => setH({ window: v })} hint={h.window < size ? 'Below size: Elasticsearch would reject this.' : undefined} />
          {h.method === 'rrf' ? (
            <Slider label="rank_constant" value={h.rankConstant} min={1} max={120} step={1} base={60} display={String(h.rankConstant)} onChange={(v) => setH({ rankConstant: v })} hint="Default 60. Lower values reward top ranks more." />
          ) : (
            <>
              <Slider label={`Weight: ${lists[0].name} vs ${lists[1].name}`} value={h.alpha} min={0} max={1} step={0.01} display={`${h.alpha.toFixed(2)} / ${(1 - h.alpha).toFixed(2)}`} onChange={(v) => setH({ alpha: v })} hint="Convex combination: weights sum to 1." />
              <div className="seg wide" role="radiogroup" aria-label="Normalizer">
                {(['minmax', 'l2_norm', 'none'] as Normalizer[]).map((n) => <button key={n} role="radio" aria-checked={h.normalizer === n} className={h.normalizer === n ? 'on' : ''} onClick={() => setH({ normalizer: n })}>{n}</button>)}
              </div>
            </>
          )}
          <div className="win-card">
            <span className="eyebrow plain">Who wins</span>
            <p>{explainWinner(fused, lists, h.method, h.rankConstant)}</p>
          </div>
          {judged && (
            <div className="compare-metrics">
              <span className="eyebrow plain">nDCG@{size}</span>
              {[{ name: h.method.toUpperCase(), ids: fused.map((d) => d.id) }, ...lists.map((l) => ({ name: `${l.name} alone`, ids: l.items.slice(0, h.window).map((i) => i.id) }))].map((row) => {
                const v = metrics(row.ids, ws.judgments, size).ndcg
                return <div key={row.name} className="cm-row"><span>{row.name}</span><span className="meter wide"><i style={{ width: `${v * 100}%` }} /></span><b>{v.toFixed(3)}</b></div>
              })}
            </div>
          )}
        </aside>
        <section className="panel">
          <div className="row spread">
            <div>
              <h3 className="panel-title">{h.method === 'rrf' ? 'RRF flow' : 'Linear combination flow'}</h3>
              <p className="panel-sub">Ribbon width shows each retriever's contribution. Hover a document to trace it.</p>
            </div>
            <span className="legend-row">{lists.map((l, i) => <span className="legend-chip" key={l.name}><i style={{ background: `var(--c${i === 0 ? 1 : 3})` }} />{l.name}</span>)}</span>
          </div>
          <div className="scroll-x"><div className="min-chart"><RrfFlow lists={lists} fused={fused} window={h.window} titles={titles} method={h.method} /></div></div>
        </section>
      </div>

      <div className="grid-2">
        <section className="panel">
          <h3 className="panel-title">Score distribution mismatch</h3>
          <p className="panel-sub">The same axis for both retrievers, before and after the normalizer.</p>
          <ScoreStrip lists={lists} window={h.window} normalizer="none" label="Raw scores" />
          {h.method === 'linear' && h.normalizer !== 'none' && <ScoreStrip lists={lists} window={h.window} normalizer={h.normalizer} label={`After ${h.normalizer}`} />}
          {h.method === 'rrf' && <p className="panel-note">RRF ignores these scores and uses ranks only, which is why this gap cannot hurt it.</p>}
          <ul className="findings">
            {findings.map((f) => <li key={f.title}><span className={`sev ${f.severity}`}>{f.severity}</span><b>{f.title}</b><p>{f.detail}</p></li>)}
          </ul>
        </section>
        <section className="panel">
          <h3 className="panel-title">What each retriever alone would miss</h3>
          <p className="panel-sub">{Math.round(cov.overlap * 100)}% overlap within a window of {h.window}.</p>
          <div className="venn">
            {[{ title: `Only ${lists[0].name}`, ids: cov.onlyIn[0], c: 'var(--c1)' }, { title: 'Both', ids: cov.both, c: 'var(--flat)' }, { title: `Only ${lists[1].name}`, ids: cov.onlyIn[1], c: 'var(--c3)' }].map((g) => (
              <div key={g.title} className="venn-col" style={{ borderTopColor: g.c }}>
                <span className="eyebrow plain">{g.title} <b>{g.ids.length}</b></span>
                <ul>{g.ids.map((id) => <li key={id} data-tip={titles[id]}>{id}</li>)}</ul>
              </div>
            ))}
          </div>
          {cov.lostFromTop.map((l) => l.ids.length > 0 && (
            <p key={l.list} className="panel-note"><b>{lists[l.list].name} alone</b> loses {l.ids.length} of the fused top {size}: {l.ids.slice(0, 5).join(', ')}{l.ids.length > 5 ? '…' : ''}.</p>
          ))}
          <h4 className="mini-h">Retriever request</h4>
          <CopyBlock text={JSON.stringify(retriever, null, 2)} label="Retriever request" toast={toast} />
        </section>
      </div>
      <section className="panel">
        <h3 className="panel-title">Fused results</h3>
        <div className="scroll-x">
          <table className="tbl">
            <thead><tr><th className="num">Rank</th><th>Document</th>{lists.map((l) => <th key={l.name} className="num">{l.name}</th>)}<th className="num">Score</th><th>Relevant?</th></tr></thead>
            <tbody>
              {fused.slice(0, 15).map((d) => (
                <tr key={d.id}>
                  <td className="num strong">{d.rank}</td>
                  <td><span className="doc-title">{d.title ?? d.id}</span><small className="muted block">{d.id}</small></td>
                  {lists.map((_, i) => {
                    const part = d.parts.find((x) => x.list === i)
                    return <td key={i} className="num">{part ? <>#{part.rank} <small className="muted">{h.method === 'rrf' ? `+${part.contribution.toFixed(4)}` : `${fmt(part.raw ?? 0, 3)} → ${part.contribution.toFixed(3)}`}</small></> : <span className="miss">missed</span>}</td>
                  })}
                  <td className="num strong">{d.score.toFixed(4)}</td>
                  <td><JudgeButtons value={ws.judgments[d.id] ?? 0} label={d.id} onChange={(v) => patch({ judgments: { ...ws.judgments, [d.id]: v } })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

// ---- Lints ----------------------------------------------------------------------------

function LintView({ hits, ws, openData }: { hits: Hit[]; ws: Workspace; openData: () => void }) {
  const all = useMemo(() => buildLints(hits, ws), [hits, ws.analyze, ws.mapping])
  return (
    <div className="stack">
      {!ws.analyze.trim() && !ws.mapping.trim() && (
        <div className="note row spread">
          <span>Analyzer lints need <code>_analyze</code> output or a mapping.</span>
          <button className="btn ghost sm" onClick={openData}>Add them</button>
        </div>
      )}
      {all.length === 0 && (
        <div className="panel lint-clean">
          <span className="sev good">Clean</span>
          <h2 className="panel-h2">No lints fired on this response.</h2>
          <p>Boosts are not swamping, no field dominates, and IDF is stable across these hits. That does not prove the order is right: add judgments in Tune to measure it.</p>
        </div>
      )}
      <div className="lint-list">
        {all.map((l) => (
          <article key={l.id} className={`lint s-${l.severity}`}>
            <span className={`sev ${l.severity}`}>{l.severity}</span>
            <h3>{l.title}</h3>
            <p>{l.detail}</p>
            {l.fix && <p className="fix"><b>Try:</b> {l.fix}</p>}
          </article>
        ))}
      </div>
    </div>
  )
}

// ---- Mini index -----------------------------------------------------------------------

function MiniView({ ws, patch, send }: { ws: Workspace; patch: (p: Partial<Workspace>) => void; send: (response: string, queryText: string) => void }) {
  const m = ws.mini
  const set = (next: Partial<MiniState>) => patch({ mini: { ...m, ...next } })
  const built = useMemo(() => {
    try {
      return { ix: buildIndex(parseDocs(m.docs), m.analyzer) }
    } catch (e) {
      return { error: (e as Error).message }
    }
  }, [m.docs, m.analyzer])
  const ix = built.ix
  const fields = useMemo(() => {
    if (!ix) return {}
    return Object.fromEntries(ix.fields.map((f) => [f, m.boosts[f] ?? 1]))
  }, [ix, m.boosts])
  const res = useMemo(() => (ix && m.query.trim() ? search(ix, { query: m.query, fields, type: m.type, k1: m.k1, b: m.b, size: 20 }) : null), [ix, m.query, fields, m.type, m.k1, m.b])
  const parsed = useMemo(() => (res && res.hits.hits.length ? parseResponse(res) : null), [res])
  const colors = useColors(parsed?.hits ?? [])
  const max = parsed ? Math.max(...parsed.hits.map((h) => h.score)) : 1
  return (
    <div className="mini">
      <section className="panel">
        <h3 className="panel-title">Your documents</h3>
        <p className="panel-sub">A JSON array, NDJSON or a search response. String fields are indexed. Nothing leaves the browser.</p>
        <textarea className="docs-area" rows={13} spellCheck={false} value={m.docs} aria-label="Documents" onChange={(e) => set({ docs: e.target.value })} />
        <div className="row">
          <label className="btn ghost sm file">Upload JSON<input type="file" accept=".json,.ndjson,application/json,text/plain" onChange={(e) => { const f = e.target.files?.[0]; if (f) f.text().then((t) => set({ docs: t })) }} /></label>
          {ix && <span className="muted small">{ix.docs.length} docs · {ix.fields.length} text fields · {Object.values(ix.stats).reduce((a, s) => a + s.df.size, 0).toLocaleString('en-US')} terms</span>}
        </div>
        {built.error && <p className="field-err" role="alert">{built.error}</p>}
        <div className="mini-controls">
          <label className="select-field"><span className="eyebrow plain">Analyzer</span>
            <select value={m.analyzer} onChange={(e) => set({ analyzer: e.target.value as Analyzer })}><option value="standard">standard</option><option value="english">english (minimal stem)</option></select>
          </label>
          <label className="select-field"><span className="eyebrow plain">multi_match type</span>
            <select value={m.type} onChange={(e) => set({ type: e.target.value as MiniState['type'] })}><option value="best_fields">best_fields</option><option value="most_fields">most_fields</option></select>
          </label>
        </div>
        <Slider label="k1" value={m.k1} min={0} max={3} step={0.01} base={1.2} onChange={(v) => set({ k1: v })} />
        <Slider label="b" value={m.b} min={0} max={1} step={0.01} base={0.75} onChange={(v) => set({ b: v })} />
        {ix?.fields.map((f) => <Slider key={f} label={`${f} boost`} value={fields[f] ?? 1} min={0} max={10} step={0.1} base={1} display={`^${(fields[f] ?? 1).toFixed(1)}`} onChange={(v) => set({ boosts: { ...m.boosts, [f]: v } })} />)}
      </section>
      <section className="panel">
        <label className="searchbox">
          <span className="sr">Search query</span>
          <SearchIcon />
          <input value={m.query} onChange={(e) => set({ query: e.target.value })} placeholder="Type a query" />
        </label>
        {res && <p className="panel-sub">{res.hits.total.value} matches. Real BM25 with Lucene norm encoding, in explain format.</p>}
        {!m.query.trim() && <p className="empty-line">Type a query to rank these documents.</p>}
        {res && !res.hits.hits.length && <p className="empty-line">No document matches those tokens with the {m.analyzer} analyzer.</p>}
        {parsed && (
          <>
            <ol className="mini-results">
              {parsed.hits.map((h) => (
                <li key={h.id}>
                  <span className="hit-rank">{h.rank}</span>
                  <div className="hit-main">
                    <span className="hit-title">{titleOf(h)}</span>
                    <span className="hit-bar" style={{ width: `${(h.score / max) * 100}%` }}>
                      {attribute(h.root).filter((c) => c.value > 0).map((c) => <i key={c.nodeId} style={{ flexGrow: c.value, background: colors.contrib(c) }} data-tip={`${c.label}: ${fmt(c.value, 3)}`} />)}
                    </span>
                  </div>
                  <span className="hit-score">{fmt(h.score)}</span>
                </li>
              ))}
            </ol>
            <button className="btn primary" onClick={() => send(JSON.stringify(res, null, 1), m.query)}>Open these results in the lab</button>
          </>
        )}
      </section>
    </div>
  )
}
