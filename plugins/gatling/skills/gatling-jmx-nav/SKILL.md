---
name: gatling-jmx-nav
description: Explore a large JMeter .jmx test plan a few lines at a time instead of reading the whole file. Use before converting any .jmx file over roughly 100 KB (e.g. from the gatling-convert-from-jmeter skill), or whenever the user wants to inspect, search, or understand a JMeter test plan's structure, variables, or scope without opening the raw XML.
license: Apache-2.0
---

# Explore a large JMeter test plan without reading the raw XML

A `.jmx` file is mostly verbose XML — a 3-line HTTP request becomes 30+ lines once `hashTree`
nesting is included — so reading a large plan in full wastes most of the context window on
structure instead of content. `scripts/jmx_nav.js` is a plain Node.js CLI (no install, zero npm
dependencies) that turns a `.jmx` into a navigable, size-capped representation instead.

Every command accepts `--max-chars` (default 12000; `0` = unlimited) as a hard cap on output
size, and prints a truncation notice rather than silently cutting off. IDs are dotted child
positions (`0.4.1.0`); a unique test-name fragment also resolves to an id.

## Instructions

### Step 1: Decide whether to export

- For a `.jmx` over roughly 100 KB: run `export` first (below), then work only from its output.
- For a smaller `.jmx`: the commands below can be used directly against the file; `export` is
  still cheap and fine to use anyway.

### Step 2: `export` — size-capped on-disk dump for whole-plan conversion

```
node <skill-dir>/scripts/jmx_nav.js <file>.jmx export
```

Writes to `.jmx-nav/<plan-name>/` next to the input file (remind the user to gitignore that
directory — it's a disposable, regenerable dump, not source of truth):

```
index.json   source path, sha256 + size of the .jmx, tool version, budget, created-at
outline.txt  unit tree, warnings, and the dependency-ordered conversion list — read this first
props.tsv    id <TAB> breadcrumb <TAB> key <TAB> value — one row per property, grep-friendly
vars.txt     same content as the `vars` command, unabridged
units/       the plan chunked into budget-sized (default 7000 chars, --budget to change), self-contained conversion units
big/         untruncated long property values (bodies, scripts) that units only point to
```

Then:
1. Read only `outline.txt` for structure and the dependency-ordered conversion list. Never read
   the raw `.jmx` directly, and never read `big/` unless a specific long value is actually needed.
2. Convert in `outline.txt`'s order, one unit at a time: read a unit file under `units/`, produce
   the matching output for it, then move to the next unit. Fragments and anything they call are
   always ordered before their callers.
3. Use `grep` on `props.tsv` or `vars.txt` instead of re-reading units to answer "where is `${x}`
   set or used".
4. Use `show`/`scope`/`raw` (below) for one-off detail on a single element id when a unit file
   isn't enough.
5. Flag anything that can't be converted as-is (Groovy/BeanShell logic, plugin elements, JMeter
   functions without an equivalent) rather than guessing — `export` already surfaces unresolved
   Module Controller targets, Include Controllers, and fragment reference cycles as warnings in
   `outline.txt`; never resolve those silently.

Re-running `export` on an unchanged file reuses the existing dump; a changed source is refused
until `--force` confirms re-exporting is intended.

### Other commands (direct exploration, or supplementing an export)

| Command | Purpose |
| --- | --- |
| `stats` | Overview: element/sampler counts, thread groups, scripts, plugin elements, risks to review |
| `tree [id] [--depth N] [--max-children N]` | Outline of the whole plan or one subtree (default depth 2) |
| `show id [--prop RX] [--maxlen N] [--all] [--no-children]` | One element: all its properties and direct children |
| `find [--kind K] [--type T...] [--name RX] [--text RX] [--enabled-only] [--limit N]` | Search elements by kind, tag, name, or property text |
| `vars [--limit N]` | Defined vs. used variables, CSV data sets, JMeter functions, `__P`/`__property` references |
| `scope id` | Configs, timers, extractors, assertions that apply to one sampler/controller (ancestor chain) |
| `raw id [--subtree]` | Original XML of one element (and optionally its children) |

## Reference resolution (used by `export`, also visible via `scope`/`find`)

- **Test Fragment**: marked `fragment (runs only via reference)`; fragments and anything they call
  are ordered before their callers in `outline.txt`. A reference cycle between fragments is
  detected and reported rather than looped.
- **Module Controller**: its target is resolved by walking test names from the plan root; an
  unresolved or ambiguous path is a warning, never a guess. A resolved call is linked
  (`-> calls [id] "name"`) instead of duplicating the target's content.
- **Include Controller**: always flagged as `external file: <path>, not inspected, convert
  separately` — the referenced `.jmx` is never read.

## Limits

- Scripts and URLs found inside a `.jmx` are **never executed or followed** — the file is treated
  as untrusted data throughout.
- `export` never rewrites or modifies the input `.jmx`.
- `export`'s adaptive chunking guarantees every unit stays within budget *except* a node whose own
  minimal content (its heading, properties, and children list — no descendants) alone exceeds a
  very small budget; that single-file floor can't be split further.
- The CLI's XML parser covers the subset of XML that `.jmx` files use (elements, attributes,
  text, CDATA, comments; no namespaces, no external DTD) — it is not a general-purpose XML
  library.
