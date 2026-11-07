# Relevance Lab

Understand and tune why Elasticsearch ranked results the way it did, across keyword and hybrid (keyword + vector) search.

Live: LIVE_URL

## The pain

Explain output is long and nested, and it stops at the numbers. Practitioners still have to work out why document A beat B, what to change, and whether the change helped. Hybrid search adds its own problems: score scales that do not match, normalization choices, and retrievers that miss each other's documents. Tools like Splainer simplify the tree. This one goes on to comparison, tuning and hybrid debugging.

## Features

- **Parser** for `explain: true` responses, `_explain` output and bare nodes: BM25 (current `boost * idf * tf` and older `tfNorm`), sum, max, dis_max tie breaker, function_score, constant_score, nested, rank_feature, kNN, RRF and linear retrievers. Unsupported shapes get a clear error. Unknown nodes are flagged and held fixed, never guessed.
- **Plain-English verdicts**: each field and term's share, with boost, IDF, TF saturation and length norm. It separates your real boost from the (k1 + 1) that ES folds into the Lucene `boost` node.
- **Compare**: term-by-term differences that add up exactly, split into boost, IDF, frequency and length, plus the smallest change that flips the order.
- **BM25 replay**: live k1, b, per-field boosts, tie_breaker and max_boost, with a bump chart per knob and a check that replay matches ES.
- **Hybrid debugger**: replay RRF and linear fusion with minmax or l2_norm. Shows who wins and why, score distribution mismatch, and what each retriever alone would miss.
- **Judgments**: nDCG@k, MRR and precision@k before and after, a fit-to-judgments search, and a tuned query to copy.
- **Lints**: dominant field, boost swamping, function_score swamping, IDF skew (dfs_query_then_fetch hint), summed-score hybrid scale, analyzer mismatch.
- **Mini index**: upload JSON docs and get real BM25 ranking in the browser, including Lucene's norm encoding, with no cluster.
- **Shareable URLs**: state is compressed into the hash. Nothing is uploaded.

## Run locally

```sh
npm install
npm run dev
npm test
npm run build
```
