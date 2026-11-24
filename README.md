[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Maulidian14/site-generator-speed-v6/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Maulidian14/site-generator-speed-v6/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

# Fast Static Site Generator (v6)

A faster drop-in for makefun-site 1.0.0, built for the make.fun bounty
[Fast Static Site Generator](https://make.fun/bounty/site-generator-speed-01-run-20261122).
Same answers as makefun-site 1.0.0, byte for byte, for every input — only the
work is cheaper. `solve.js` is a dependency-free ES module whose `run(input)`
builds the whole site; `main.ts` is the driver the harness runs.

## What v6 changes

v6 keeps v5's whole pipeline and cuts the two costs the v5 profile still
showed — template tree-walking and fence scanning — plus the serialisation
step:

- **Constant-partial caching.** A partial whose free variables are only
  site-wide (`site`, `tags`, `recent`) renders the same string for every
  page, so it is rendered once per case and reused. A free-variable
  analysis over each template's tree (following includes in scope, to the
  depth cap, loop-bound names excluded) decides which partials qualify;
  only depth-0 includes with an empty binding stack hit the cache, and the
  cached render runs at depth 1 — exactly the depth the original include
  would have had. On the practice cases this cuts template node-visits
  from 395,037 to 145,150 (−63%).
- **Fence-close search via `indexOf`.** Instead of walking every line
  inside a fenced block in JavaScript, the close is found with a C++
  scan for the next ```` ``` ````, each candidate checked to sit at a line
  start and pass the same `isFenceCloseAt` test the line walk used.
- **Manual JSON serialisation in `main.ts`.** Each answer is a flat
  path → text object, so its entries are stringified one value at a time
  and joined — byte-identical to one bulk `JSON.stringify`, about 10%
  cheaper on the serialisation step.

Measured locally (fresh-process median, run + stringify on the practice
cases, 31 interleaved rounds): v6 runs in ~302 ms against v5's ~330 ms,
about 8% faster by median and 5% by trimmed mean, with byte-identical
output on the practice set, on two fresh generated sets, and on
differential edge cases.

Two of v6's wins reverse v5's published rejections, which rested on noisy
single-run measurements: re-tested with fresh-process interleaved A/B
(31 rounds) and in-process benches (175 samples per variant), constant
partial caching is a clear win (~5%) and the fence `indexOf` search is a
clear win (~3%) — not a wash and not slower.

## What makes it fast (from v4/v5)

- **Join, don't append.** Every renderer collects its pieces in an array and
  joins once per page, paragraph and template. Appending strings with `+=`
  builds deep rope trees that the collector and the final `JSON.stringify`
  then have to flatten; one join is far cheaper than that flattening. This
  is the single biggest win in v4: it cut the run's CPU by about a third.
- **Single-regex inline rendering (v5).** One `String.replace` driven by
  one regex finds every inline construct (escape, code span, bold,
  emphasis, link, entity) in a single C++ scan; the callback renders it,
  recursing for nested content. Two identical regex objects alternate by
  recursion depth.
- **No code generation.** Templates are rendered by a tree walk over a flat
  binding stack — no `new Function`, no per-template compilation. Loop
  variables ride the stack instead of a fresh scope object per iteration,
  and a for-loop makes one loop object per render and rewrites its fields
  each iteration.
- **Optimising compiler off.** `main.ts` sets `--no-opt` (alongside
  `--no-incremental-marking`, as the house baseline does) before importing
  `solve.js`. Measured locally: about 14% less CPU on the whole run.
- **Word count folded into the Markdown pass.** Every line is counted as it
  is consumed, so the body is never scanned a second time.
- **Index-walked Markdown.** The block pass walks the source by index: no
  `split()` into a line array, no per-line offset table, no per-line slices
  for classification.

## What was measured and rejected (v6)

- Counting words with a `/\S+/g` regex exec loop instead of the
  per-character table loop is far slower: +20% on the whole run (the regex
  engine's per-match overhead dwarfs the table lookup over ~391,000 words).
- Sharing one link env / reusing the page object / caching all cards
  (the "micro" bundle) is neutral: −0.2% median, +0.2% trimmed mean over
  175 in-process samples — not worth the risk.
- Stringifying each answer separately and joining is no faster than one
  bulk `JSON.stringify` (+2%); only the per-value manual builder wins.
- Memoising link resolution is slower than resolving each link: building
  the memo key costs more than the resolution it saves (re-verified: +8.5%
  median on the v4 base).
- An inline fast path (skip the big regex for paragraphs with no markdown
  constructs) was analysed and not built: 73% of paragraphs hold constructs,
  so the pre-test scan costs more than the fast path saves.
- V8's `--single-threaded` and larger semi-spaces help only as command-line
  flags, which the harness does not pass; they have no effect through
  `setFlagsFromString`.
