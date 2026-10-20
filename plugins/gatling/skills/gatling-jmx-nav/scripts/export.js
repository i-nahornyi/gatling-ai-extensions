'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const core = require('./jmx_nav');

const { Ctx, kind, line, header, trunc, die, DEFAULT_MAX_CHARS } = core;

const TOOL_VERSION = '1.0.0';
const BIG_THRESHOLD = 200; // chars; above this a property value moves to big/ and gets pointerized

function slug(n) {
  const base = (n.name || n.short).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return base || n.short.toLowerCase();
}

function bigFileName(id, key) {
  const k = key.replace(/^@/, '').replace(/[^A-Za-z0-9_.-]/g, '_');
  return `${id}.${k}.txt`;
}

function planName(filePath) {
  return path.basename(filePath).replace(/\.jmx$/i, '').replace(/[^A-Za-z0-9_.-]/g, '_') || 'plan';
}

function extractBigValues(ctx, bigDir) {
  const display = new Map(); // `${id}::${key}` -> string to render inline
  const tsvValue = new Map(); // `${id}::${key}` -> value for the props.tsv cell (<=200 chars, newline-safe)
  for (const n of ctx.nodes) {
    for (const [key, v] of n.props) {
      if (v === '') continue;
      const k = `${n.id}::${key}`;
      if (v.length > BIG_THRESHOLD) {
        const fname = bigFileName(n.id, key);
        fs.writeFileSync(path.join(bigDir, fname), v);
        display.set(k, `[big/${fname}, ${v.length} chars]`);
        tsvValue.set(k, trunc(v, 200).replace(/\t/g, ' ') + ` [big/${fname}]`);
      } else {
        display.set(k, v);
        tsvValue.set(k, v.replace(/\r/g, '').replace(/\n/g, '\\n').replace(/\t/g, ' '));
      }
    }
  }
  return { display, tsvValue };
}

function elementBlockLines(n, state) {
  const lines = [line(n)];
  for (const [key, v] of n.props) {
    if (v === '') continue;
    const label = key.startsWith('@') ? key.slice(1) : key;
    const shown = state.display.get(`${n.id}::${key}`);
    lines.push(`  ${label} = ${shown}`);
  }
  if (n.short === 'ModuleController') {
    const res = state.moduleCalls.get(n.id);
    if (res) {
      lines.push(res.target ? `  -> calls [${res.target.id}] "${res.target.name || res.target.short}"` : `  -> WARNING: ${res.error}`);
    }
  }
  if (n.short === 'IncludeController') {
    const p = n.get('IncludeController.includepath') || n.get('includepath');
    lines.push(`  -> external file: ${p || '(path not set)'}, not inspected, convert separately`);
  }
  return lines;
}

function renderSubtree(n, state, memo) {
  if (memo.has(n)) return memo.get(n);
  const lines = [...elementBlockLines(n, state)];
  for (const c of n.children) {
    lines.push('');
    lines.push(...renderSubtree(c, state, memo));
  }
  memo.set(n, lines);
  return lines;
}

function subtreeSize(n, state, memo) {
  return renderSubtree(n, state, memo).join('\n').length;
}

// Reuses the `scope` command's ancestor-chain logic.
const SCOPE_KINDS = new Set(['config', 'timer', 'pre', 'post', 'assertion']);

function buildScopeLines(n) {
  const chain = [];
  let x = n;
  while (x !== null) {
    chain.push(x);
    x = x.parent;
  }
  chain.reverse();
  const out = [];
  let any = false;
  for (const aNode of chain) {
    let label;
    if (aNode.parent === null && kind(aNode) === 'plan') label = 'test plan';
    else label = `[${aNode.id}] ${aNode.short} "${trunc(aNode.name, 40)}"`;
    const items = aNode.children.filter((c) => !chain.includes(c) && SCOPE_KINDS.has(kind(c)));
    if (items.length === 0) continue;
    any = true;
    out.push(`  at ${label}:`);
    for (const c of items) out.push(`    ${kind(c).padEnd(9)} ${line(c)}`);
  }
  if (!any) out.push('  (none)');
  return out;
}

function modulePathSegments(n) {
  const rx = /^ModuleController\.node_path\[(\d+)\]$/;
  const segs = [];
  for (const [key, v] of n.props) {
    const m = rx.exec(key);
    if (m) segs.push([parseInt(m[1], 10), v]);
  }
  segs.sort((a, b) => a[0] - b[0]);
  return segs.map(([, v]) => v);
}

function resolveModulePath(ctx, segments) {
  if (!segments.length) return { error: 'empty node path' };
  let candidates = ctx.roots.filter((r) => kind(r) === 'plan' && r.name === segments[0]);
  if (candidates.length === 0) candidates = ctx.roots.filter((r) => kind(r) === 'plan');
  if (candidates.length !== 1) return { error: `ambiguous or missing test plan root for path segment "${segments[0]}"` };
  let current = candidates[0];
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const matches = current.children.filter((c) => c.name === seg);
    if (matches.length === 0) return { error: `no child named "${seg}" under [${current.id}] (path: ${segments.join(' > ')})` };
    if (matches.length > 1) return { error: `ambiguous child named "${seg}" under [${current.id}], ${matches.length} matches (path: ${segments.join(' > ')})` };
    current = matches[0];
  }
  return { node: current };
}

function owningTopLevel(n) {
  let x = n;
  while (x !== null) {
    if (kind(x) === 'fragment' || kind(x) === 'threadgroup') return x;
    x = x.parent;
  }
  return null;
}

function buildReferences(ctx) {
  const fragments = ctx.nodes.filter((n) => kind(n) === 'fragment');
  const fragmentIds = new Set(fragments.map((f) => f.id));
  const edges = new Map();
  const warnings = [];
  const moduleCalls = new Map(); // moduleControllerId -> {target|null, error?}
  for (const f of fragments) edges.set(f.id, new Set());

  for (const n of ctx.nodes) {
    if (n.short === 'ModuleController') {
      const segs = modulePathSegments(n);
      const resolved = resolveModulePath(ctx, segs);
      if (resolved.error) {
        warnings.push(`[${n.id}] ModuleController: unresolved target (${resolved.error})`);
        moduleCalls.set(n.id, { target: null, error: resolved.error });
        continue;
      }
      moduleCalls.set(n.id, { target: resolved.node });
      const owner = owningTopLevel(n);
      if (owner && fragmentIds.has(resolved.node.id)) {
        if (!edges.has(owner.id)) edges.set(owner.id, new Set());
        edges.get(owner.id).add(resolved.node.id);
      }
    }
    if (n.short === 'IncludeController') {
      const p = n.get('IncludeController.includepath') || n.get('includepath');
      warnings.push(`[${n.id}] IncludeController: external file: ${p || '(path not set)'}, not inspected, convert separately`);
    }
  }
  return { fragments, fragmentIds, edges, warnings, moduleCalls };
}

function topoSortFragments(fragments, edges) {
  const order = [];
  const cycles = [];
  const state = new Map();
  const byId = new Map(fragments.map((f) => [f.id, f]));

  function visit(id, stack) {
    const st = state.get(id) || 0;
    if (st === 2) return;
    if (st === 1) {
      const idx = stack.indexOf(id);
      cycles.push(stack.slice(idx).concat(id));
      return;
    }
    state.set(id, 1);
    stack.push(id);
    for (const dep of edges.get(id) || []) {
      if (byId.has(dep)) visit(dep, stack);
    }
    stack.pop();
    state.set(id, 2);
    order.push(id);
  }
  for (const f of fragments) visit(f.id, []);
  return { order: order.map((id) => byId.get(id)), cycles };
}

// Sizing is decided with the exact same renderer that writes the file (buildMergedFile),
// so there is no separate size estimate that can drift from what actually gets written.
function chunkSiblings(nodeList, budget, state, memo) {
  const units = [];
  let bucket = [];
  const flush = () => {
    if (bucket.length) units.push({ type: 'merged', nodes: bucket });
    bucket = [];
  };
  for (const n of nodeList) {
    const soloLen = buildMergedFile([n], state, memo).join('\n').length;
    if (soloLen > budget) {
      flush();
      units.push({ type: 'split', node: n, children: chunkSiblings(n.children, budget, state, memo) });
      continue;
    }
    const candidate = [...bucket, n];
    const candidateLen = buildMergedFile(candidate, state, memo).join('\n').length;
    if (candidateLen > budget && bucket.length) {
      flush();
      bucket = [n];
    } else {
      bucket = candidate;
    }
  }
  flush();
  return units;
}

function unitHeaderLines(nodes) {
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const idRange = nodes.length === 1 ? first.id : `${first.id}..${last.id}`;
  const bc = first.parent ? first.parent.breadcrumb() + (first.parent.name ? ` > ${first.parent.name}` : '') : '';
  const out = [`UNIT ids=${idRange}`];
  if (bc) out.push(`in: ${bc}`);
  out.push('inherited context (outermost first):');
  out.push(...buildScopeLines(first));
  out.push('');
  return out;
}

function buildMergedFile(nodes, state, memo) {
  const out = unitHeaderLines(nodes);
  for (const n of nodes) {
    out.push(...renderSubtree(n, state, memo));
    out.push('');
  }
  return out;
}

function buildSplitOwnFile(node, childEntries, state) {
  const out = unitHeaderLines([node]);
  out.push(...elementBlockLines(node, state));
  out.push('');
  out.push(`children (${childEntries.length}):`);
  for (const e of childEntries) {
    const label = e.kind === 'dir-file' ? `[split] ${e.label}` : e.label;
    out.push(`  -> ${e.relPath}  ${label}`);
  }
  return out;
}

function materializeUnits(units, dirAbsPath, dirRelPath, state, memo) {
  fs.mkdirSync(dirAbsPath, { recursive: true });
  const entries = [];
  let seq = 0;
  for (const u of units) {
    const seqStr = String(seq).padStart(2, '0');
    if (u.type === 'split') {
      const dirName = `${seqStr}_${slug(u.node)}`;
      const childRel = `${dirRelPath}/${dirName}`;
      const childEntries = materializeUnits(u.children, path.join(dirAbsPath, dirName), childRel, state, memo);
      const fileName = `${dirName}.md`;
      const fileLines = buildSplitOwnFile(u.node, childEntries, state);
      fs.writeFileSync(path.join(dirAbsPath, fileName), fileLines.join('\n') + '\n');
      entries.push({ relPath: `${dirRelPath}/${fileName}`, node: u.node, label: `[${u.node.id}] ${u.node.short} "${u.node.name}"`, kind: 'dir-file' });
    } else {
      const nodes = u.nodes;
      const fileName = nodes.length === 1 ? `${seqStr}_${slug(nodes[0])}.md` : `${seqStr}_${slug(nodes[0])}_etc.md`;
      const lines = buildMergedFile(nodes, state, memo);
      fs.writeFileSync(path.join(dirAbsPath, fileName), lines.join('\n') + '\n');
      const label = nodes.length === 1
        ? `[${nodes[0].id}] ${nodes[0].short} "${nodes[0].name}"`
        : `${nodes.length} elements [${nodes[0].id}..${nodes[nodes.length - 1].id}]`;
      entries.push({ relPath: `${dirRelPath}/${fileName}`, nodes, label, kind: 'file' });
    }
    seq += 1;
  }
  return entries;
}

function captureStdout(fn) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    chunks.push(chunk);
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join('');
}

function renderVarsFull(ctx) {
  return captureStdout(() => {
    const { main } = core;
    // run `vars` with an effectively unlimited --max-chars and --limit so vars.txt is complete
    main([ctx.path, 'vars', '--limit', '1000000', '--max-chars', '0']);
  });
}

function flattenEntries(entries, depthLeft, indent, out) {
  for (const e of entries) {
    out.push('  '.repeat(indent) + `- ${e.relPath}  ${e.label}`);
  }
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readIndex(outDir) {
  const p = path.join(outDir, 'index.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

function cmdExport(a) {
  const filePath = a.file;
  const sha = sha256File(filePath);
  const size = fs.statSync(filePath).size;
  const outDir = a.out || path.join(path.dirname(filePath), '.jmx-nav', planName(filePath));

  const existing = readIndex(outDir);
  if (existing && !a.force) {
    if (existing.sha256 === sha && existing.budget === a.budget) {
      process.stdout.write(`export up to date at ${outDir} (sha256 unchanged); use --force to re-export anyway\n`);
      return;
    }
    return die(`export at ${outDir} is stale (source or budget changed since last export); re-run with --force to overwrite`);
  }

  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const unitsDir = path.join(outDir, 'units');
  const bigDir = path.join(outDir, 'big');
  fs.mkdirSync(unitsDir, { recursive: true });
  fs.mkdirSync(bigDir, { recursive: true });

  const ctx = new Ctx(filePath);
  const { display, tsvValue } = extractBigValues(ctx, bigDir);
  const refs = buildReferences(ctx);
  const state = { display, moduleCalls: refs.moduleCalls };
  const memo = new Map();

  // props.tsv
  const tsvLines = [];
  for (const n of ctx.nodes) {
    const bc = n.breadcrumb();
    for (const [key, v] of n.props) {
      if (v === '') continue;
      tsvLines.push([n.id, bc, key.startsWith('@') ? key.slice(1) : key, tsvValue.get(`${n.id}::${key}`)].join('\t'));
    }
  }
  fs.writeFileSync(path.join(outDir, 'props.tsv'), tsvLines.join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'vars.txt'), renderVarsFull(ctx));

  // Top-level units: every plan's non-config, non-listener children. Fragments and thread
  // groups are chunked the same way here; dependency order is recorded separately below.
  const topLevel = [];
  for (const root of ctx.roots) {
    if (kind(root) !== 'plan') continue;
    for (const c of root.children) {
      if (kind(c) === 'config' || kind(c) === 'listener') continue;
      topLevel.push(c);
    }
  }
  const unitPlan = chunkSiblings(topLevel, a.budget, state, memo);
  const topEntries = materializeUnits(unitPlan, unitsDir, 'units', state, memo);

  const { order: fragmentOrder, cycles } = topoSortFragments(refs.fragments, refs.edges);
  const cycleWarnings = cycles.map(
    (c) => `reference cycle: ${c.map((id) => `[${id}]`).join(' -> ')}`
  );
  const allWarnings = [...refs.warnings, ...cycleWarnings];

  const outline = [];
  outline.push(header(ctx));
  outline.push(`export budget: ${a.budget} chars/unit   sha256: ${sha.slice(0, 12)}…   generated: ${new Date().toISOString()}`);
  outline.push('');
  outline.push('UNITS (document order; see props.tsv/vars.txt for data flow, big/ for long values):');
  flattenEntries(topEntries, 0, 1, outline);
  outline.push('');
  if (allWarnings.length) {
    outline.push(`WARNINGS (${allWarnings.length}):`);
    for (const w of allWarnings) outline.push(`  - ${w}`);
    outline.push('');
  }
  outline.push('CONVERSION ORDER (fragments and referenced controllers before their callers):');
  if (fragmentOrder.length === 0) {
    outline.push('  (no test fragments in this plan)');
  } else {
    for (const f of fragmentOrder) {
      const entry = topEntries.find((e) => (e.node && e.node.id === f.id) || (e.nodes && e.nodes[0].id === f.id));
      outline.push(`  [${f.id}] fragment "${f.name}" (runs only via reference) -> ${entry ? entry.relPath : '(not chunked)'}`);
    }
  }
  for (const root of ctx.roots) {
    if (kind(root) !== 'plan') continue;
    for (const c of root.children) {
      if (kind(c) !== 'threadgroup') continue;
      const entry = topEntries.find((e) => (e.node && e.node.id === c.id) || (e.nodes && e.nodes[0].id === c.id));
      outline.push(`  [${c.id}] ${c.short} "${c.name}" -> ${entry ? entry.relPath : '(not chunked)'}`);
    }
  }
  fs.writeFileSync(path.join(outDir, 'outline.txt'), outline.join('\n') + '\n');

  const index = {
    source: path.resolve(filePath),
    sha256: sha,
    size,
    toolVersion: TOOL_VERSION,
    budget: a.budget,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');

  process.stdout.write(`exported to ${outDir}\n`);
  process.stdout.write(`  outline.txt (${outline.join('\n').length} chars), props.tsv (${tsvLines.length} rows), units/ (${topEntries.length} top-level entries)\n`);
  if (allWarnings.length) process.stdout.write(`  ${allWarnings.length} warning(s) — see outline.txt\n`);
}

module.exports = {
  cmdExport,
  slug,
  chunkSiblings,
  subtreeSize,
  renderSubtree,
  buildReferences,
  resolveModulePath,
  modulePathSegments,
  topoSortFragments,
  BIG_THRESHOLD,
};
