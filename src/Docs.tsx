import { link } from './App.tsx'

const SOURCES: [string, string, string][] = [
  ['Explain API response example (ES 8/9)', 'https://github.com/elastic/elasticsearch-specification/blob/main/specification/_global/explain/examples/response/ExplainResponseExample1.yaml', 'Apache-2.0. Stored as fixtures/es-explain-api-8.json; parsed and replayed to 1e-6.'],
  ['Explain API example, tfNorm era (ES 6.8)', 'https://github.com/elastic/elasticsearch/blob/6.8/docs/reference/search/explain.asciidoc', 'Apache-2.0. Stored as fixtures/es-explain-api-6.8.json; gives the same 1.6943599 score.'],
  ['RRF explain examples, plain and named query', 'https://github.com/elastic/elasticsearch/blob/main/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion.md', 'Stored as fixtures/es-rrf-explain*.json with the "..." placeholders removed.'],
  ['RRF description strings (RRFRankDoc.explain)', 'https://github.com/elastic/elasticsearch/blob/main/x-pack/plugin/rank-rrf/src/main/java/org/elasticsearch/xpack/rank/rrf/RRFRankDoc.java', 'The per-retriever node value is the rank; the contribution is in the description.'],
  ['Linear retriever strings (LinearRankDoc.explain)', 'https://github.com/elastic/elasticsearch/blob/main/x-pack/plugin/rank-rrf/src/main/java/org/elasticsearch/xpack/rank/linear/LinearRankDoc.java', 'weight * normalized score per retriever, with the normalizer name.'],
  ['BM25 explain and norm table (Lucene BM25Similarity)', 'https://github.com/apache/lucene/blob/main/lucene/core/src/java/org/apache/lucene/search/similarities/BM25Similarity.java', 'idf = ln(1 + (N - n + 0.5) / (n + 0.5)); tf = freq / (freq + k1 (1 - b + b dl / avgdl)); dl from a one-byte norm, "approximate" above byte 39.'],
  ['(k1 + 1) folded into boost (ES LegacyBM25Similarity)', 'https://github.com/elastic/elasticsearch/blob/main/server/src/main/java/org/elasticsearch/lucene/similarity/LegacyBM25Similarity.java', 'Why an unboosted clause explains as boost = 2.2.'],
  ['function_score and script_score strings', 'https://github.com/elastic/elasticsearch/tree/main/server/src/main/java/org/elasticsearch/common/lucene/search/function', 'CombineFunction, FunctionScoreQuery, FieldValueFactorFunction, ScriptScoreQuery ("Boosted score, product of:").'],
]

const FORMATS = [
  ['Search response with "explain": true', 'hits.hits[]._explanation. Also the abbreviated {"hits": [...]} form used in Elastic docs, and a single-search _msearch.'],
  ['_explain API response', '{ _id, matched, explanation }.'],
  ['Bare explanation node or an array of hits', '{ value, description, details } or [{ _id, _score, _explanation }].'],
  ['Retriever responses', 'rrf (with or without _name on sub-retrievers) and linear with minmax, l2_norm or none.'],
  ['Hybrid lists', 'A search response, [{ _id, _score }] or "id score" lines, for the keyword and vector sides.'],
]

export default function Docs() {
  return (
    <section className="section">
      <div className="sec-in docs">
        <span className="eyebrow">Docs</span>
        <h2>What it reads, and what it was checked against</h2>
        <h3>Input formats</h3>
        <dl>{FORMATS.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
        <p>ES 5 to 9 BM25 output is supported. Classic TF-IDF (removed in ES 7) is refused rather than replayed. Unrecognised nodes keep their reported value and are flagged.</p>
        <h3>Test fixtures and references</h3>
        <p>Checked on 16 Nov 2026. Real responses below are copied into the test suite; description strings were matched against the source that emits them.</p>
        <ul className="docs-src">
          {SOURCES.map(([t, u, note]) => <li key={u}><a href={u} target="_blank" rel="noreferrer">{t}</a><span>{note}</span></li>)}
        </ul>
        <h3>Samples</h3>
        <p>The three workspace samples are synthetic: realistic index statistics run through the same BM25 code as the mini index, emitted in the exact ES 8 explain format. They are not exports from a real cluster.</p>
        <h3>Limits</h3>
        <ul>
          <li>Replay can only reorder the hits that were returned. Raise "size" to see documents entering from below.</li>
          <li>Rescore, collapse and post-processing steps are not in the explain tree; a mismatch between _score and the tree is reported, not modelled.</li>
          <li>The mini index tokenizer is a close regex approximation of the standard analyzer for Latin text.</li>
        </ul>
        <p><a className="btn primary" {...link('/app')}>Open the lab</a></p>
      </div>
    </section>
  )
}
