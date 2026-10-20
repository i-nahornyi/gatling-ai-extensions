#!/usr/bin/env node
'use strict';

/**
 * jmx_nav - explore a JMeter .jmx file as a tree, a few lines at a time.
 *
 * Built for LLM agents: every command prints a small, size-capped slice of the
 * plan, so a 1 MB+ .jmx never has to be read into context. Node.js stdlib only,
 * zero npm dependencies.
 *
 *   jmx_nav.js FILE stats                       overview: counts, thread groups, risks
 *   jmx_nav.js FILE tree  [ID] [--depth N]      outline (default depth 2)
 *   jmx_nav.js FILE show  ID [--prop RX]        one element: properties + children
 *   jmx_nav.js FILE find  [--kind K] [--type T] [--name RX] [--text RX]
 *   jmx_nav.js FILE vars                        defined / used variables, functions
 *   jmx_nav.js FILE scope ID                    configs, timers, extractors, assertions
 *                                               that apply to a sampler/controller
 *   jmx_nav.js FILE raw   ID [--subtree]        original XML of one element
 *   jmx_nav.js FILE export [--out DIR] [--budget N] [--force]
 *                                               size-capped on-disk dump for whole-plan conversion
 *
 * IDs are dotted child positions ("0.1.3"). A unique test-name fragment also works.
 * Every command accepts --max-chars (default 12000) as a hard cap on output size.
 */

const fs = require('fs');
const path = require('path');
const xml = require('./xml');

const PROP_TAGS = new Set(['stringProp', 'boolProp', 'intProp', 'longProp', 'doubleProp']);
const DEFAULT_MAX_CHARS = 12000;

class Node {
  constructor(el, hashEl, parent, nid) {
    this.el = el;
    this.hashEl = hashEl;
    this.parent = parent;
    this.id = nid;
    this.children = [];
    this._props = null;
  }

  get tag() {
    return this.el.tag;
  }

  get short() {
    return this.el.tag.split('.').pop();
  }

  get name() {
    return this.el.get('testname', '');
  }

  get ownEnabled() {
    return this.el.get('enabled', 'true') !== 'false';
  }

  get enabled() {
    return this.ownEnabled && (this.parent === null || this.parent.enabled);
  }

  get props() {
    if (this._props === null) this._props = flatProps(this.el);
    return this._props;
  }

  get(key, def = '') {
    for (const [k, v] of this.props) {
      if (k === key) return v;
    }
    return def;
  }

  breadcrumb() {
    const names = [];
    let a = this.parent;
    while (a !== null) {
      if (kind(a) !== 'plan') names.push(a.name || a.short);
      a = a.parent;
    }
    return names.reverse().join(' > ');
  }
}

function flatProps(el) {
  const out = [];
  for (const c of el) {
    if (PROP_TAGS.has(c.tag)) {
      out.push([c.get('name', ''), c.text || '']);
    } else if (c.tag === 'elementProp') {
      out.push(..._elemProp(c));
    } else if (c.tag === 'collectionProp') {
      out.push(..._collProp(c));
    }
  }
  return out;
}

function _elemProp(c) {
  const et = c.get('elementType', '');
  if (['HTTPArgument', 'Argument', 'Header', 'HTTPFileArg'].includes(et)) {
    const d = {};
    for (const p of c) {
      if (PROP_TAGS.has(p.tag)) d[p.get('name')] = p.text || '';
    }
    if (et === 'HTTPArgument') {
      const nm = d['Argument.name'] || '';
      const val = d['Argument.value'] || '';
      return nm ? [['@param', `${nm}=${val}`]] : [['@body', val]];
    }
    if (et === 'Argument') {
      return [['@var', `${d['Argument.name'] || ''}=${d['Argument.value'] || ''}`]];
    }
    if (et === 'Header') {
      return [['@header', `${d['Header.name'] || ''}: ${d['Header.value'] || ''}`]];
    }
    return [['@file', `${d['File.paramname'] || ''}=${d['File.path'] || ''}`]];
  }
  return flatProps(c);
}

function _collProp(c) {
  const out = [];
  const n = c.get('name', '');
  let i = 0;
  for (const k of c) {
    if (PROP_TAGS.has(k.tag)) {
      out.push([`${n}[${i}]`, k.text || '']);
    } else if (k.tag === 'elementProp') {
      out.push(..._elemProp(k));
    } else if (k.tag === 'collectionProp') {
      out.push(..._collProp(k));
    }
    i += 1;
  }
  return out;
}

const CONFIG_TAGS = new Set([
  'ConfigTestElement', 'Arguments', 'CSVDataSet', 'HeaderManager', 'CookieManager',
  'CacheManager', 'AuthManager', 'DNSCacheManager', 'KeystoreConfig', 'CounterConfig',
  'RandomVariableConfig', 'LoginConfig', 'LoginConfigElement',
]);

function kind(n) {
  const t = n.short;
  if (t === 'TestPlan') return 'plan';
  if (t === 'WorkBench') return 'workbench';
  if (t === 'TestFragment') return 'fragment';
  if (t.endsWith('ThreadGroup')) return 'threadgroup';
  if (t.endsWith('Sampler') || t.endsWith('SamplerProxy') || t === 'HTTPSampler' || t === 'HTTPSampler2') return 'sampler';
  if (t.endsWith('PreProcessor')) return 'pre';
  if (t.endsWith('PostProcessor') || t.endsWith('Extractor')) return 'post';
  if (t.endsWith('Assertion')) return 'assertion';
  if (t.endsWith('Timer')) return 'timer';
  if (['ResultCollector', 'BackendListener', 'Summariser'].includes(t) || t.endsWith('Listener') || t.endsWith('Visualizer')) return 'listener';
  if (t.endsWith('Controller')) return 'controller';
  if (CONFIG_TAGS.has(t) || t.endsWith('Config') || t.endsWith('Manager') || t.endsWith('DataSet') || t.endsWith('Defaults')) return 'config';
  return 'other';
}

class Ctx {
  constructor(filePath) {
    this.path = filePath;
    this.size = fs.statSync(filePath).size;
    let root;
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      root = xml.parseString(text);
    } catch (e) {
      if (e instanceof xml.XmlParseError) {
        die(`XML parse error in ${filePath}: ${e.message}`);
      }
      throw e;
    }
    if (root.tag !== 'jmeterTestPlan') die(`${filePath} is not a JMX file (root element is <${root.tag}>)`);
    const top = root.find('hashTree');
    if (top === null) die('JMX has no top-level <hashTree>');
    this.rootEl = root;
    this.roots = buildChildren(top, null, []);
    this.nodes = [];
    this.byId = new Map();
    const walk = (n) => {
      this.nodes.push(n);
      this.byId.set(n.id, n);
      for (const c of n.children) walk(c);
    };
    for (const r of this.roots) walk(r);
  }
}

function buildChildren(h, parent, pathSoFar) {
  const nodes = [];
  const kids = h.children;
  let i = 0;
  let idx = 0;
  while (i < kids.length) {
    const el = kids[i];
    if (el.tag === 'hashTree') {
      i += 1;
      continue;
    }
    let hashEl = null;
    let step = 1;
    if (i + 1 < kids.length && kids[i + 1].tag === 'hashTree') {
      hashEl = kids[i + 1];
      step = 2;
    }
    const nid = [...pathSoFar, idx].join('.');
    const n = new Node(el, hashEl, parent, nid);
    if (hashEl !== null) n.children = buildChildren(hashEl, n, [...pathSoFar, idx]);
    nodes.push(n);
    idx += 1;
    i += step;
  }
  return nodes;
}

function die(msg) {
  process.stderr.write(`jmx_nav: ${msg}\n`);
  process.exit(2);
}

function trunc(s, n) {
  s = (s || '').replace(/\r/g, '').replace(/\n/g, '\\n');
  if (n && s.length > n) return s.slice(0, n) + `…[+${s.length - n} chars]`;
  return s;
}

function human(nbytes) {
  if (nbytes >= 1 << 20) return `${(nbytes / (1 << 20)).toFixed(2)} MB`;
  return `${(nbytes / 1024).toFixed(1)} KB`;
}

function countSamplers(n) {
  let c = kind(n) === 'sampler' ? 1 : 0;
  for (const ch of n.children) c += countSamplers(ch);
  return c;
}

function resolve(ctx, ref) {
  if (/^\d+(\.\d+)*$/.test(ref)) {
    const n = ctx.byId.get(ref);
    if (n) return n;
    let hint = '';
    if (ref.includes('.')) {
      const p = ctx.byId.get(ref.slice(0, ref.lastIndexOf('.')));
      if (p) hint = ` (${p.id} has ${p.children.length} children, valid: 0..${p.children.length - 1})`;
    }
    return die(`no element with id ${ref}${hint}`);
  }
  const needle = ref.toLowerCase();
  const ms = ctx.nodes.filter((n) => n.name.toLowerCase().includes(needle));
  if (ms.length === 1) return ms[0];
  if (ms.length === 0) return die(`no element whose name contains ${JSON.stringify(ref)}`);
  const lines = ms.slice(0, 10).map((m) => `  ${line(m)}`);
  return die(`${JSON.stringify(ref)} matches ${ms.length} elements, use an id:\n` + lines.join('\n'));
}

function emit(lines, maxChars) {
  const text = lines.join('\n');
  if (maxChars && text.length > maxChars) {
    let cut = text.lastIndexOf('\n', maxChars);
    if (cut <= 0) cut = maxChars;
    const rest = text.length - cut;
    process.stdout.write(
      text.slice(0, cut) +
        `\n[output truncated: ${rest} more chars. Narrow with an ID, --depth, --limit, or raise --max-chars]\n`
    );
    return;
  }
  process.stdout.write(text + '\n');
}

const TIMER_KEYS = [
  ['ConstantTimer.delay', 'delay'],
  ['RandomTimer.range', 'range'],
  ['throughput', 'throughput'],
];

function summarize(n) {
  const t = n.short;
  const g = (key, def = '') => n.get(key, def);
  const k = kind(n);

  if (k === 'threadgroup') {
    const parts = [];
    for (const [key, label] of [
      ['ThreadGroup.num_threads', 'threads'], ['ThreadGroup.ramp_time', 'ramp'],
      ['TargetLevel', 'target'], ['RampUp', 'rampUp'], ['Steps', 'steps'],
      ['Hold', 'hold'], ['Unit', 'unit'],
    ]) {
      const v = g(key);
      if (v !== '') parts.push(`${label}=${v}`);
    }
    const loops = g('LoopController.loops');
    if (loops !== '') parts.push(loops === '-1' ? 'loops=forever' : `loops=${loops}`);
    if (g('ThreadGroup.scheduler') === 'true') {
      parts.push(`duration=${g('ThreadGroup.duration')}`);
      if (g('ThreadGroup.delay')) parts.push(`delay=${g('ThreadGroup.delay')}`);
    }
    return parts.join(' ');
  }

  if (['HTTPSamplerProxy', 'HTTPSampler', 'HTTPSampler2'].includes(t)) {
    const method = g('HTTPSampler.method') || 'GET';
    const host = g('HTTPSampler.domain');
    const p = g('HTTPSampler.path');
    const proto = g('HTTPSampler.protocol');
    const port = g('HTTPSampler.port');
    let url = p;
    if (host) url = `${proto ? proto + '://' : ''}${host}${port ? ':' + port : ''}${p}`;
    let s = `${method} ${trunc(url, 90)}`;
    if (g('HTTPSampler.follow_redirects') === 'false') s += ' noRedirect';
    if (g('HTTPSampler.postBodyRaw') === 'true') s += ' rawBody';
    const np = n.props.filter(([key]) => key === '@param').length;
    if (np) s += ` params=${np}`;
    return s;
  }

  if (t === 'TransactionController') return g('TransactionController.parent') === 'true' ? 'generateParent' : '';
  if (t === 'LoopController') return `loops=${g('LoopController.loops')}`;
  if (t === 'IfController') return 'if ' + trunc(g('IfController.condition'), 70);
  if (t === 'WhileController') return 'while ' + trunc(g('WhileController.condition'), 70);
  if (t === 'ForeachController') return `for ${g('ForeachController.returnVal')} in ${g('ForeachController.inputVal')}_N`;
  if (t === 'ThroughputController') {
    if (g('ThroughputController.style') === '1') return `percent=${g('ThroughputController.percentThroughput')}`;
    return `max=${g('ThroughputController.maxThroughput')}`;
  }
  if (t === 'CSVDataSet') {
    let s = `${g('filename')} vars=${g('variableNames') || '(from header)'}`;
    if (g('recycle') === 'false') s += ' noRecycle';
    if (g('stopThread') === 'true') s += ' stopThread';
    return s;
  }
  if (t === 'Arguments' || (t === 'TestPlan' && n.props.some(([key]) => key === '@var'))) {
    const names = n.props.filter(([key]) => key === '@var').map(([, v]) => v.split('=')[0]);
    return names.length ? `vars: ${names.join(', ')}` : '';
  }
  if (t === 'HeaderManager') {
    const names = n.props.filter(([key]) => key === '@header').map(([, v]) => v.split(':')[0]);
    return names.length ? `headers: ${names.join(', ')}` : '';
  }
  if (t === 'ConfigTestElement') {
    const host = g('HTTPSampler.domain');
    if (host || g('HTTPSampler.path')) {
      const proto = g('HTTPSampler.protocol');
      const port = g('HTTPSampler.port');
      return `defaults ${proto ? proto + '://' : ''}${host}${port ? ':' + port : ''}${g('HTTPSampler.path')}`;
    }
    return '';
  }
  if (t === 'ResponseAssertion') {
    const strings = n.props
      .filter(([key]) => key.startsWith('Asserion.test_strings') || key.startsWith('Assertion.test_strings'))
      .map(([, v]) => v);
    const field = g('Assertion.test_field').replaceAll('Assertion.', '');
    const rawTt = g('Assertion.test_type');
    const tt = rawTt ? parseInt(rawTt, 10) : 0;
    const masked = tt & ~4 & ~32;
    let op = { 1: 'matches', 2: 'contains', 8: 'equals', 16: 'substring' }[masked] ?? `type${tt}`;
    if (tt & 4) op = 'not ' + op;
    return `${field} ${op} ` + trunc(strings.join('|'), 50);
  }
  if (t === 'JSONPathAssertion') return `${g('JSON_PATH')} = ${trunc(g('EXPECTED_VALUE'), 40)}`;
  if (t === 'DurationAssertion') return `<= ${g('DurationAssertion.duration')}ms`;
  if (t.startsWith('JSR223') || t.startsWith('BeanShell')) {
    const script = g('script');
    const first = script.split('\n').map((ln) => ln.trim()).find((ln) => ln) || '';
    const lang = g('scriptLanguage') || (t.startsWith('BeanShell') ? 'beanshell' : '');
    const src = g('filename') ? `file=${g('filename')}` : `${script.length}ch`;
    return `${lang} ${src} ${trunc(first, 50)}`.trim();
  }
  if (k === 'post' && (t.endsWith('Extractor') || t === 'JSONPostProcessor')) {
    let ref = '';
    let expr = '';
    let lb = '';
    let rb = '';
    for (const [key, v] of n.props) {
      const kl = key.toLowerCase();
      if ((kl.endsWith('refname') || kl.endsWith('referencenames')) && !ref) {
        ref = v;
      } else if (kl.endsWith('regex') || kl.endsWith('xpathquery') || kl.endsWith('jsonpathexprs') || key === 'HtmlExtractor.expr') {
        expr = expr || v;
      } else if (kl.endsWith('lboundary')) {
        lb = v;
      } else if (kl.endsWith('rboundary')) {
        rb = v;
      }
    }
    if (lb || rb) expr = `${lb}…${rb}`;
    return `${ref} <- ${trunc(expr, 60)}`;
  }
  if (k === 'timer') {
    const parts = TIMER_KEYS.filter(([key]) => g(key) !== '').map(([key, label]) => `${label}=${g(key)}`);
    return parts.join(' ');
  }
  return '';
}

function line(n) {
  let s = `[${n.id}] ${n.short}`;
  if (n.name) s += ` "${trunc(n.name, 60)}"`;
  const sm = summarize(n);
  if (sm) s += `  ${sm}`;
  if (!n.ownEnabled) s += '  [disabled]';
  else if (!n.enabled) s += '  [disabled via parent]';
  return s;
}

function header(ctx) {
  const samplers = ctx.nodes.filter((n) => kind(n) === 'sampler').length;
  const ver = ctx.rootEl.get('jmeter', '?');
  return `# ${path.basename(ctx.path)}  ${human(ctx.size)}  JMeter ${ver}  ${ctx.nodes.length} elements, ${samplers} samplers`;
}

function cmdTree(ctx, a) {
  const out = [header(ctx)];
  const starts = a.id ? [resolve(ctx, a.id)] : ctx.roots;
  const depth = a.depth;

  function render(n, left, indent) {
    out.push('  '.repeat(indent) + line(n));
    if (n.children.length === 0) return;
    if (left <= 0) {
      const below = countSamplers(n) - (kind(n) === 'sampler' ? 1 : 0);
      out[out.length - 1] += `  ▸ ${n.children.length} child${n.children.length !== 1 ? 'ren' : ''}, ${below} sampler${below !== 1 ? 's' : ''} below`;
      return;
    }
    for (const c of n.children.slice(0, a.maxChildren)) render(c, left - 1, indent + 1);
    const extra = n.children.length - a.maxChildren;
    if (extra > 0) out.push('  '.repeat(indent + 1) + `… +${extra} more (tree ${n.id} --max-children N)`);
  }

  for (const s of starts) render(s, depth, 0);
  emit(out, a.maxChars);
}

function cmdShow(ctx, a) {
  const n = resolve(ctx, a.id);
  const out = [line(n)];
  const bc = n.breadcrumb();
  if (bc) out.push(`in: ${bc}`);
  out.push(`kind: ${kind(n)}   enabled: ${n.enabled}`);
  const rx = a.prop ? new RegExp(a.prop, 'i') : null;
  let shown = 0;
  for (const [key, v] of n.props) {
    if (v === '' && !a.all) continue;
    const label = key.startsWith('@') ? key.slice(1) : key;
    if (rx && !rx.test(label)) continue;
    out.push(`  ${label} = ${trunc(v, a.maxlen)}`);
    shown += 1;
  }
  if (shown === 0) out.push('  (no non-empty properties)');
  if (n.children.length && !a.noChildren) {
    out.push(`children (${n.children.length}):`);
    for (const c of n.children.slice(0, a.maxChildren)) out.push('  ' + line(c));
    if (n.children.length > a.maxChildren) out.push(`  … +${n.children.length - a.maxChildren} more`);
  }
  emit(out, a.maxChars);
}

function snippet(v, idx, matchLen, width = 45) {
  const s = Math.max(0, idx - width);
  const e = Math.min(v.length, idx + matchLen + width);
  return (s ? '…' : '') + v.slice(s, e).replace(/\n/g, '\\n') + (e < v.length ? '…' : '');
}

function cmdFind(ctx, a) {
  const rxName = a.name ? new RegExp(a.name, 'i') : null;
  const rxText = a.text ? new RegExp(a.text, 'i') : null;
  const types = (a.type || []).map((t) => t.toLowerCase());
  const out = [];
  let count = 0;
  for (const n of ctx.nodes) {
    if (types.length && !types.some((t) => n.tag.toLowerCase().includes(t))) continue;
    if (a.kind && kind(n) !== a.kind) continue;
    if (rxName && !rxName.test(n.name)) continue;
    if (a.enabledOnly && !n.enabled) continue;
    let hit = null;
    if (rxText) {
      for (const [key, v] of n.props) {
        const m = rxText.exec(v);
        if (m) {
          hit = [key, v, m];
          break;
        }
      }
      if (hit === null) continue;
    }
    count += 1;
    if (count > a.limit) continue;
    out.push(line(n));
    const bc = n.breadcrumb();
    if (bc) out.push(`    in: ${bc}`);
    if (hit) {
      const [key, v, m] = hit;
      out.push(`    match ${key.replace(/^@/, '')}: ${snippet(v, m.index, m[0].length)}`);
    }
  }
  const head = `${count} match(es)` + (count > a.limit ? `, showing first ${a.limit}` : '');
  emit([head, ...out], a.maxChars);
}

const VAR_REF = /\$\{([A-Za-z_][\w.-]*)\}/g;
const FUNC_REF = /\$\{(__\w+)/g;
const PROP_REF = /\$\{__(?:P|property|setProperty)\(\s*([^,)}\s]+)/g;
const SCRIPT_PUT = /vars\.(?:put|putObject)\(\s*["']([^"']+)["']/g;
const SCRIPT_GET = /vars\.(?:get|getObject)\(\s*["']([^"']+)["']/g;
const SUFFIX = /(_g\d+|_matchNr|_\d+)$/;
const BUILTIN = new Set(['JMeterThread.last_sample_ok', 'START.MS', 'START.YMD', 'START.HMS', 'TESTSTART.MS']);

const DEF_PROPS = new Map([
  ['RegexExtractor.refname', ['regex-extractor', null]],
  ['XPathExtractor.refname', ['xpath-extractor', null]],
  ['XPathExtractor2.refname', ['xpath2-extractor', null]],
  ['BoundaryExtractor.refname', ['boundary-extractor', null]],
  ['HtmlExtractor.refname', ['css-extractor', null]],
  ['JSONPostProcessor.referenceNames', ['json-extractor', ';']],
  ['CounterConfig.name', ['counter', null]],
  ['variableName', ['random-variable', null]],
  ['ForeachController.returnVal', ['foreach-var', null]],
]);

function partition(s, sep) {
  const idx = s.indexOf(sep);
  if (idx === -1) return [s, '', ''];
  return [s.slice(0, idx), sep, s.slice(idx + sep.length)];
}

function cmdVars(ctx, a) {
  const defined = new Map();
  const used = new Map();
  const funcs = new Map();
  const propsUsed = new Map();
  const csvFiles = [];

  function define(name, source, nid, detail = '') {
    name = name.trim();
    if (!name) return;
    if (!defined.has(name)) defined.set(name, []);
    defined.get(name).push([source, nid, detail]);
  }
  function addUsed(map, name, nid) {
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(nid);
  }

  for (const n of ctx.nodes) {
    for (const [key, v] of n.props) {
      if (key === '@var') {
        const [nm, , val] = partition(v, '=');
        define(nm, 'UDV', n.id, val);
      } else if (DEF_PROPS.has(key)) {
        const [src, sep] = DEF_PROPS.get(key);
        const parts = sep ? v.split(sep) : [v];
        for (const part of parts) define(part, src, n.id);
      }
      if (key === 'script' && (n.short.startsWith('JSR223') || n.short.startsWith('BeanShell'))) {
        for (const m of v.matchAll(SCRIPT_PUT)) define(m[1], 'script', n.id);
      }
      for (const m of v.matchAll(SCRIPT_GET)) addUsed(used, m[1], n.id);
      for (const m of v.matchAll(VAR_REF)) addUsed(used, m[1], n.id);
      for (const m of v.matchAll(FUNC_REF)) addUsed(funcs, m[1], n.id);
      for (const m of v.matchAll(PROP_REF)) addUsed(propsUsed, m[1], n.id);
    }
    if (n.short === 'CSVDataSet') {
      const names = n.get('variableNames').split(',').map((x) => x.trim()).filter(Boolean);
      for (const nm of names) define(nm, 'csv', n.id, n.get('filename'));
      csvFiles.push([n, names]);
    }
  }

  const isDef = (name) => defined.has(name) || defined.has(name.replace(SUFFIX, '')) || BUILTIN.has(name);
  const undefinedVars = [...used.keys()].filter((nm) => !isDef(nm));
  const lim = a.limit;
  const out = [header(ctx), `DEFINED (${defined.size})`];
  const definedEntries = [...defined.entries()];
  for (const [nm, srcs] of definedEntries.slice(0, lim)) {
    const [src, nid, detail] = srcs[0];
    const uses = (used.get(nm) || []).length;
    const extra = srcs.length > 1 ? ` (+${srcs.length - 1} more defs)` : '';
    const det = detail ? ` = ${trunc(detail, 40)}` : '';
    out.push(`  ${nm.padEnd(24)} ${src.padEnd(16)} [${nid}]${det}  used ${uses}x${extra}`);
  }
  if (defined.size > lim) out.push(`  … +${defined.size - lim} more (raise --limit)`);
  const unused = definedEntries
    .map(([nm]) => nm)
    .filter((nm) => !used.has(nm) && ![...used.keys()].some((u) => u.replace(SUFFIX, '') === nm));
  if (unused.length) out.push(`DEFINED BUT NEVER REFERENCED (${unused.length}): ` + unused.slice(0, lim).join(', '));
  out.push(`USED BUT NOT DEFINED (${undefinedVars.length})`);
  for (const nm of undefinedVars.slice(0, lim)) {
    const ids = used.get(nm);
    out.push(`  ${nm.padEnd(24)} used ${ids.length}x, first at [${ids[0]}]`);
  }
  if (undefinedVars.length > lim) out.push(`  … +${undefinedVars.length - lim} more`);
  if (csvFiles.length) {
    out.push('CSV DATA SETS');
    for (const [n, names] of csvFiles) {
      out.push(
        `  [${n.id}] ${n.get('filename')}  vars=${names.join(',') || '(from header)'}  ` +
          `recycle=${n.get('recycle') || 'true'} stopThread=${n.get('stopThread') || 'false'} ` +
          `share=${n.get('shareMode') || '-'}`
      );
    }
  }
  if (funcs.size) {
    out.push('FUNCTIONS (no direct Gatling equivalent for some; review)');
    const sortedFuncs = [...funcs.entries()].sort((x, y) => y[1].length - x[1].length).slice(0, lim);
    for (const [f, ids] of sortedFuncs) out.push(`  ${f.padEnd(20)} ${ids.length}x, first at [${ids[0]}]`);
  }
  if (propsUsed.size) out.push('JMETER PROPERTIES via __P/__property: ' + [...propsUsed.keys()].join(', '));
  emit(out, a.maxChars);
}

function cmdScope(ctx, a) {
  const n = resolve(ctx, a.id);
  const chain = [];
  let x = n;
  while (x !== null) {
    chain.push(x);
    x = x.parent;
  }
  chain.reverse();
  const applies = new Set(['config', 'timer', 'pre', 'post', 'assertion']);
  const out = [line(n), 'elements that apply here (outermost first):'];
  let any_ = false;
  for (const aNode of chain) {
    let label;
    if (aNode.parent === null && kind(aNode) === 'plan') label = 'test plan';
    else label = `[${aNode.id}] ${aNode.short} "${trunc(aNode.name, 40)}"`;
    const items = aNode.children.filter((c) => !chain.includes(c) && applies.has(kind(c)));
    if (items.length === 0) continue;
    any_ = true;
    out.push(`  at ${label}:`);
    for (const c of items) out.push(`    ${kind(c).padEnd(9)} ${line(c)}`);
  }
  if (!any_) out.push('  (none)');
  out.push(
    'note: timers/assertions/processors at a level apply to every sampler at or below it; ' +
      'config elements (headers, defaults, cookies, CSV) are inherited downward.'
  );
  emit(out, a.maxChars);
}

function cmdRaw(ctx, a) {
  const n = resolve(ctx, a.id);
  const parts = [xml.toXmlString(n.el)];
  if (a.subtree && n.hashEl !== null) parts.push(xml.toXmlString(n.hashEl));
  emit([parts.join('\n')], a.maxChars);
}

function cmdStats(ctx, a) {
  const nodes = ctx.nodes;
  const out = [header(ctx)];
  const depth = nodes.length ? Math.max(...nodes.map((n) => n.id.split('.').length - 1)) : 0;
  const disabled = nodes.filter((n) => !n.ownEnabled);
  out.push(`max depth: ${depth + 1}   disabled elements: ${disabled.length}`);
  out.push('THREAD GROUPS');
  for (const n of nodes) {
    if (kind(n) === 'threadgroup') out.push(`  ${line(n)}   (${countSamplers(n)} samplers)`);
  }
  const types = new Map();
  for (const n of nodes) types.set(n.short, (types.get(n.short) || 0) + 1);
  const typesSorted = [...types.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  out.push('TYPES: ' + typesSorted.map(([t, c]) => `${t} ${c}`).join(', '));
  const doms = new Map();
  for (const n of nodes) {
    if (kind(n) === 'sampler' && n.short.startsWith('HTTPSampler')) {
      const d = n.get('HTTPSampler.domain') || '(defaults)';
      doms.set(d, (doms.get(d) || 0) + 1);
    }
  }
  if (doms.size) {
    const domsSorted = [...doms.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    out.push('HTTP HOSTS: ' + domsSorted.map(([d, c]) => `${d} x${c}`).join(', '));
  }
  out.push('REVIEW CAREFULLY WHEN CONVERTING');
  const scripts = nodes.filter((n) => n.short.startsWith('JSR223') || n.short.startsWith('BeanShell'));
  if (scripts.length) {
    const total = scripts.reduce((s, n) => s + n.get('script').length, 0);
    const langs = new Map();
    for (const n of scripts) {
      const l = n.get('scriptLanguage') || 'beanshell';
      langs.set(l, (langs.get(l) || 0) + 1);
    }
    out.push(`  scripts: ${scripts.length} (${total} chars) languages: ` + [...langs.entries()].map(([l, c]) => `${l} ${c}`).join(', '));
  }
  const plugins = new Map();
  for (const n of nodes) if (n.tag.includes('.')) plugins.set(n.tag, (plugins.get(n.tag) || 0) + 1);
  if (plugins.size) out.push('  third-party/plugin elements: ' + [...plugins.entries()].map(([t, c]) => `${t} x${c}`).join(', '));
  const ctrl = new Map();
  for (const n of nodes) {
    if (kind(n) === 'controller' && !['TransactionController', 'GenericController'].includes(n.short)) {
      ctrl.set(n.short, (ctrl.get(n.short) || 0) + 1);
    }
  }
  if (ctrl.size) out.push('  logic controllers: ' + [...ctrl.entries()].map(([t, c]) => `${t} x${c}`).join(', '));
  const bigCandidates = [];
  for (const n of nodes) for (const [k, v] of n.props) bigCandidates.push([v.length, n, k]);
  bigCandidates.sort((a, b) => b[0] - a[0]);
  const big = bigCandidates.slice(0, 3);
  if (big.length && big[0][0] > 2000) {
    out.push('  largest property values: ' + big.map(([ln, n, k]) => `[${n.id}] ${k.replace(/^@/, '')} (${ln} chars)`).join(', '));
  }
  if (disabled.length) {
    out.push(
      '  disabled: ' +
        disabled.slice(0, 8).map((n) => `[${n.id}] ${n.short}`).join(', ') +
        (disabled.length > 8 ? ` … +${disabled.length - 8}` : '')
    );
  }
  out.push('next: `tree <ThreadGroupId>` for a group outline, `show <id>` for one element, `vars` for data flow.');
  emit(out, a.maxChars);
}

const COMMANDS = ['stats', 'tree', 'show', 'find', 'vars', 'scope', 'raw', 'export'];

const COMMAND_FLAGS = {
  stats: {},
  tree: {
    '--depth': { dest: 'depth', type: 'int', default: 2 },
    '--max-children': { dest: 'maxChildren', type: 'int', default: 20 },
  },
  show: {
    '--prop': { dest: 'prop', type: 'string', default: null },
    '--maxlen': { dest: 'maxlen', type: 'int', default: 300 },
    '--all': { dest: 'all', type: 'bool', default: false },
    '--no-children': { dest: 'noChildren', type: 'bool', default: false },
    '--max-children': { dest: 'maxChildren', type: 'int', default: 30 },
  },
  find: {
    '--kind': { dest: 'kind', type: 'string', default: null },
    '--type': { dest: 'type', type: 'list', default: null },
    '--name': { dest: 'name', type: 'string', default: null },
    '--text': { dest: 'text', type: 'string', default: null },
    '--enabled-only': { dest: 'enabledOnly', type: 'bool', default: false },
    '--limit': { dest: 'limit', type: 'int', default: 40 },
  },
  vars: {
    '--limit': { dest: 'limit', type: 'int', default: 60 },
  },
  scope: {},
  raw: {
    '--subtree': { dest: 'subtree', type: 'bool', default: false },
  },
  export: {
    '--out': { dest: 'out', type: 'string', default: null },
    '--budget': { dest: 'budget', type: 'int', default: 7000 },
    '--force': { dest: 'force', type: 'bool', default: false },
  },
};

const FIND_KINDS = new Set(['threadgroup', 'sampler', 'controller', 'config', 'timer', 'pre', 'post', 'assertion', 'listener']);

function parseIntOpt(v, name) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return die(`invalid integer for ${name}: ${v}`);
  return n;
}

function applyPositionals(cmd, a, positionals) {
  if (cmd === 'tree') {
    a.id = positionals[0] || null;
    return;
  }
  if (cmd === 'show' || cmd === 'scope' || cmd === 'raw') {
    if (!positionals[0]) die(`command "${cmd}" requires an id`);
    a.id = positionals[0];
  }
}

function parseArgs(argv) {
  if (argv.length < 2) {
    process.stderr.write('usage: jmx_nav.js FILE {' + COMMANDS.join(',') + '} [options]\n');
    process.exit(2);
  }
  const file = argv[0];
  const cmd = argv[1];
  const rest = argv.slice(2);
  if (!COMMANDS.includes(cmd)) die(`unknown command "${cmd}" (expected one of: ${COMMANDS.join(', ')})`);

  const a = { file, cmd, maxChars: DEFAULT_MAX_CHARS };
  const specs = COMMAND_FLAGS[cmd];
  for (const spec of Object.values(specs)) a[spec.dest] = spec.default;

  const positionals = [];
  let i = 0;
  while (i < rest.length) {
    const tok = rest[i];
    if (tok === '--max-chars') {
      a.maxChars = parseIntOpt(rest[i + 1], '--max-chars');
      i += 2;
      continue;
    }
    if (tok.startsWith('--')) {
      const spec = specs[tok];
      if (!spec) die(`unknown option ${tok} for command "${cmd}"`);
      if (spec.type === 'bool') {
        a[spec.dest] = true;
        i += 1;
        continue;
      }
      if (spec.type === 'list') {
        const vals = [];
        i += 1;
        while (i < rest.length && !rest[i].startsWith('--')) {
          vals.push(rest[i]);
          i += 1;
        }
        a[spec.dest] = vals;
        continue;
      }
      const val = rest[i + 1];
      if (val === undefined) die(`missing value for ${tok}`);
      a[spec.dest] = spec.type === 'int' ? parseIntOpt(val, tok) : val;
      i += 2;
      continue;
    }
    positionals.push(tok);
    i += 1;
  }
  if (cmd === 'find' && a.kind && !FIND_KINDS.has(a.kind)) {
    die(`invalid --kind "${a.kind}" (expected one of: ${[...FIND_KINDS].join(', ')})`);
  }
  applyPositionals(cmd, a, positionals);
  return a;
}

const DISPATCH = {
  stats: cmdStats,
  tree: cmdTree,
  show: cmdShow,
  find: cmdFind,
  vars: cmdVars,
  scope: cmdScope,
  raw: cmdRaw,
};

function main(argv) {
  const a = parseArgs(argv);
  if (!fs.existsSync(a.file) || !fs.statSync(a.file).isFile()) return die(`file not found: ${a.file}`);
  // required lazily: export.js requires this module back for Ctx/kind/etc., so by the
  // time this line runs (inside main, after this module has fully loaded) the circular
  // require resolves cleanly instead of seeing a half-populated module.exports.
  if (a.cmd === 'export') return require('./export').cmdExport(a);
  const ctx = new Ctx(a.file);
  DISPATCH[a.cmd](ctx, a);
}

module.exports = {
  main,
  Ctx,
  Node,
  kind,
  resolve,
  line,
  header,
  emit,
  trunc,
  human,
  countSamplers,
  flatProps,
  buildChildren,
  die,
  DEFAULT_MAX_CHARS,
};

if (require.main === module) {
  main(process.argv.slice(2));
}
