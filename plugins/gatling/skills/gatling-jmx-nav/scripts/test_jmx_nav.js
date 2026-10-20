#!/usr/bin/env node
'use strict';

/**
 * Checks for jmx_nav.js and export.js. Run: node test_jmx_nav.js [sample.jmx]
 * Generates its own fixtures into the OS temp dir (nothing is committed to the repo).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const j = require(path.join(HERE, 'jmx_nav.js'));
const gen = require(path.join(HERE, 'gen_sample_jmx.js'));
const xml = require(path.join(HERE, 'xml.js'));

const fails = [];

function check(cond, msg) {
  console.log((cond ? 'ok   ' : 'FAIL ') + msg);
  if (!cond) fails.push(msg);
}

function captureStdout(fn) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
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

function run(samplePath, ...args) {
  return captureStdout(() => j.main([samplePath, ...args]));
}

function runCli(samplePath, args) {
  try {
    const out = execFileSync(process.execPath, [path.join(HERE, 'jmx_nav.js'), samplePath, ...args], { encoding: 'utf8' });
    return { status: 0, stdout: out, stderr: '' };
  } catch (e) {
    return { status: e.status, stdout: e.stdout ? e.stdout.toString() : '', stderr: e.stderr ? e.stderr.toString() : '' };
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmx-nav-test-'));
const SAMPLE = process.argv[2] || path.join(tmpDir, 'ecomm_large.jmx');
if (!process.argv[2]) {
  fs.writeFileSync(SAMPLE, gen.buildLarge(1050000));
}

// Independent element count: anything with a testclass attr that is not an inline elementProp.
const rootEl = xml.parseString(fs.readFileSync(SAMPLE, 'utf8'));
let expected = 0;
for (const e of rootEl.iter()) {
  if (e.get('testclass', '') && e.tag !== 'elementProp') expected += 1;
}
const ctx = new j.Ctx(SAMPLE);
check(ctx.nodes.length === expected, `element count matches independent walk (${ctx.nodes.length} == ${expected})`);
check(new Set(ctx.nodes.map((n) => n.id)).size === ctx.nodes.length, 'ids are unique');
let samplerCountExpected = 0;
for (const e of rootEl.iter()) if (e.tag === 'HTTPSamplerProxy') samplerCountExpected += 1;
check(ctx.nodes.filter((n) => j.kind(n) === 'sampler').length === samplerCountExpected, `sampler count == ${samplerCountExpected}`);

const bad = ctx.nodes.filter((n) => j.resolve(ctx, n.id) !== n).map((n) => n.id);
check(bad.length === 0, 'every id resolves to its own node');

const off = ctx.nodes.find((n) => n.name.startsWith('Legacy soak'));
check(!off.enabled && off.children.every((c) => !c.enabled), 'disabled parent disables children');

// Every command stays well under the output cap on a 1 MB plan.
const sizes = {};
const commandCases = {
  stats: ['stats'],
  tree: ['tree'],
  'tree TG depth3': ['tree', '0.4', '--depth', '3', '--max-children', '5'],
  'show sampler': ['show', '0.4.1.0'],
  find: ['find', '--kind', 'sampler', '--text', '/api/'],
  vars: ['vars'],
  scope: ['scope', '0.4.1.0'],
  raw: ['raw', '0.4.1.0'],
};
for (const [name, args] of Object.entries(commandCases)) {
  const out = run(SAMPLE, ...args);
  sizes[name] = out.length;
  check(out.length <= j.DEFAULT_MAX_CHARS + 200, `${name}: ${out.length.toLocaleString()} chars (cap ${j.DEFAULT_MAX_CHARS.toLocaleString()})`);
}
const fsize = fs.statSync(SAMPLE).size;
console.log(
  `\nfile ${fsize.toLocaleString()} bytes; typical outline (stats+tree) ${(sizes.stats + sizes.tree).toLocaleString()} chars ` +
    `= ${((100 * (sizes.stats + sizes.tree)) / fsize).toFixed(1)}% of the file`
);

// vars.get() inside an IfController condition should count as a reference too, not just ${...}.
const v = run(SAMPLE, 'vars');
const afterUnused = v.includes('NEVER REFERENCED') ? v.split('NEVER REFERENCED')[1].split('\n')[0] : '';
check(v.includes('bigCart') && v.includes('NEVER REFERENCED') && !afterUnused.includes('bigCart'), 'bigCart referenced from __groovy() condition is not reported unused');
check(v.includes('USED BUT NOT DEFINED (0)'), 'no false "undefined" variables');

// Edge cases on a tiny hand-written JMX.
const TINY = `<?xml version="1.0"?>
<jmeterTestPlan version="1.2" jmeter="5.6.3"><hashTree>
<TestPlan guiclass="TestPlanGui" testclass="TestPlan" testname="t" enabled="true"/><hashTree>
  <ThreadGroup guiclass="ThreadGroupGui" testclass="ThreadGroup" testname="g" enabled="true">
    <stringProp name="ThreadGroup.num_threads">3</stringProp></ThreadGroup><hashTree>
    <BeanShellSampler guiclass="BeanShellSamplerGui" testclass="BeanShellSampler" testname="bs" enabled="true">
      <stringProp name="BeanShellSampler.query">x</stringProp></BeanShellSampler><hashTree/>
    <HTTPSamplerProxy guiclass="HttpTestSampleGui" testclass="HTTPSamplerProxy" testname="s" enabled="true">
      <stringProp name="HTTPSampler.path">/a?b=\${undef}</stringProp></HTTPSamplerProxy><hashTree/>
  </hashTree>
</hashTree>
<WorkBench guiclass="WorkBenchGui" testclass="WorkBench" testname="WorkBench" enabled="true"/><hashTree/>
</hashTree></jmeterTestPlan>`;
const tinyPath = path.join(tmpDir, 'tiny.jmx');
fs.writeFileSync(tinyPath, TINY);
const t = new j.Ctx(tinyPath);
check(t.roots.map((r) => r.id).join(',') === '0,1', 'WorkBench becomes a second root');
check(t.byId.get('0.0.1').short === 'HTTPSamplerProxy', 'empty <hashTree/> siblings are skipped correctly');
const tinyVars = runCli(tinyPath, ['vars']).stdout;
check(tinyVars.split('USED BUT NOT DEFINED')[1].includes('undef'), 'undefined variable detected');

const badXml = tinyPath + '.bad';
fs.writeFileSync(badXml, '<jmeterTestPlan><hashTree>');
let r = runCli(badXml, ['stats']);
check(r.status === 2 && r.stderr.includes('parse error'), 'malformed XML gives a clean error, exit 2');
fs.writeFileSync(badXml, '<html/>');
r = runCli(badXml, ['stats']);
check(r.status === 2 && r.stderr.includes('not a JMX'), 'non-JMX file is rejected');

function collectUnitFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectUnitFiles(full));
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function headingIds(text) {
  const ids = [];
  const rx = /^\[(\d+(?:\.\d+)*)\]\s/gm;
  let m;
  while ((m = rx.exec(text))) ids.push(m[1]);
  return ids;
}

function expectedExportIds(exportCtx) {
  const ids = new Set();
  for (const root of exportCtx.roots) {
    if (j.kind(root) !== 'plan') continue;
    for (const c of root.children) {
      if (j.kind(c) === 'config' || j.kind(c) === 'listener') continue;
      for (const n of walk(c)) ids.add(n.id);
    }
  }
  return ids;
}

function walk(n) {
  const out = [n];
  for (const c of n.children) out.push(...walk(c));
  return out;
}

const refsPath = path.join(tmpDir, 'refs.jmx');
fs.writeFileSync(refsPath, gen.buildReferencesFixture());
const exportDir = path.join(tmpDir, 'refs.jmx-nav');
// Large enough that every unit comfortably fits (budget compliance is checked below);
// a separate, much smaller budget is used further down purely to exercise deep splitting.
const BUDGET = 1500;
let exp = runCli(refsPath, ['export', '--out', exportDir, '--budget', String(BUDGET)]);
check(exp.status === 0, 'export succeeds on the references fixture');

const unitFiles = collectUnitFiles(path.join(exportDir, 'units'));
const overBudget = unitFiles.filter((f) => fs.readFileSync(f, 'utf8').length > BUDGET + 50);
check(overBudget.length === 0, `every unit file <= budget (${overBudget.length} over out of ${unitFiles.length})`);

const foundIds = new Set();
const dupIds = [];
for (const f of unitFiles) {
  for (const id of headingIds(fs.readFileSync(f, 'utf8'))) {
    if (foundIds.has(id)) dupIds.push(id);
    foundIds.add(id);
  }
}
const exportCtx = new j.Ctx(refsPath);
const expectedIds = expectedExportIds(exportCtx);
const missing = [...expectedIds].filter((id) => !foundIds.has(id));
const extra = [...foundIds].filter((id) => !expectedIds.has(id));
check(dupIds.length === 0, `no element id appears in more than one unit file (${dupIds.length} dup)`);
check(missing.length === 0 && extra.length === 0, `every exported element id appears in exactly one unit file (missing=${missing.length}, extra=${extra.length})`);

// staleness: unchanged source -> reuse; changed source without --force -> refuse
const reuse = runCli(refsPath, ['export', '--out', exportDir, '--budget', String(BUDGET)]);
check(reuse.status === 0 && reuse.stdout.includes('up to date'), 'unchanged source reuses the existing export');
fs.appendFileSync(refsPath, '<!-- touch -->');
const stale = runCli(refsPath, ['export', '--out', exportDir, '--budget', String(BUDGET)]);
check(stale.status === 2 && stale.stderr.includes('stale'), 'changed source without --force is refused');
const forced = runCli(refsPath, ['export', '--out', exportDir, '--budget', String(BUDGET), '--force']);
check(forced.status === 0, '--force re-exports a changed source');

// determinism: exporting twice (both forced) produces byte-identical files
function snapshotDir(dir) {
  const out = {};
  for (const f of collectUnitFiles(dir).concat([path.join(dir, 'props.tsv'), path.join(dir, 'vars.txt')])) {
    out[path.relative(dir, f)] = fs.readFileSync(f, 'utf8');
  }
  return out;
}
const snap1 = snapshotDir(exportDir);
runCli(refsPath, ['export', '--out', exportDir, '--budget', String(BUDGET), '--force']);
const snap2 = snapshotDir(exportDir);
const sameKeys = Object.keys(snap1).length === Object.keys(snap2).length;
const sameContent = sameKeys && Object.keys(snap1).every((k) => snap1[k] === snap2[k]);
check(sameContent, 'exporting twice (both forced) produces byte-identical unit/props/vars files');

// references: fragments, module controller resolution, include controller, cycle
const outline = fs.readFileSync(path.join(exportDir, 'outline.txt'), 'utf8');
check(outline.includes('IncludeController: external file: legacy/checkout.jmx'), 'IncludeController is flagged as an external file, not inspected');
check(outline.includes('ambiguous child named "Checkout"'), 'ambiguous ModuleController path is flagged, not guessed');
check(/reference cycle: \[0\.\d+\] -> \[0\.\d+\] -> \[0\.\d+\]/.test(outline), 'fragment reference cycle is detected and reported');
const loginUnitFile = unitFiles.find((f) => fs.readFileSync(f, 'utf8').includes('Call Login'));
check(
  !!loginUnitFile && /-> calls \[0\.\d+\] "Login Fragment"/.test(fs.readFileSync(loginUnitFile, 'utf8')),
  'resolved ModuleController target is linked, not duplicated'
);

// deep splitting: a much smaller budget on the same fixture forces the nested
// Transaction Controllers through several levels of split directories
const deepExportDir = path.join(tmpDir, 'refs-deep.jmx-nav');
runCli(refsPath, ['export', '--out', deepExportDir, '--budget', '500', '--force']);
const deepUnitFiles = collectUnitFiles(path.join(deepExportDir, 'units'));
const maxDepth = Math.max(...deepUnitFiles.map((f) => path.relative(deepExportDir, f).split(path.sep).length));
check(maxDepth >= 4, `tiny budget forces multi-level directory splitting (deepest file at depth ${maxDepth})`);

// grep round-trip on the large sample: a variable defined (extractor) and used (${...}) is findable via its id + breadcrumb
const largeExportDir = path.join(tmpDir, 'large.jmx-nav');
runCli(SAMPLE, ['export', '--out', largeExportDir, '--budget', '7000']);
const propsTsv = fs.readFileSync(path.join(largeExportDir, 'props.tsv'), 'utf8');
const cartIdLines = propsTsv.split('\n').filter((l) => l.includes('cartId'));
const definesCartId = cartIdLines.some((l) => l.includes('JSONPostProcessor.referenceNames') && l.split('\t')[3] === 'cartId');
const usesCartId = cartIdLines.some((l) => l.split('\t')[3].includes('${cartId}'));
check(definesCartId && usesCartId, 'grep round-trip on props.tsv finds both the definition and a use of ${cartId}, each with its own id');

console.log('\n' + (fails.length === 0 ? 'ALL PASSED' : `${fails.length} FAILED`));
process.exitCode = fails.length ? 1 : 0;
