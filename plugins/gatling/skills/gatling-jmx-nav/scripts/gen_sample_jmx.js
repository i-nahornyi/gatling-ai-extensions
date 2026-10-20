#!/usr/bin/env node
'use strict';

/**
 * Generates test fixtures for test_jmx_nav.js: a large ecommerce plan, a small plan,
 * and a dedicated fixture for the `export` command's reference handling (nested
 * Transaction Controllers, a Module Controller + Test Fragment pair, an Include
 * Controller, an ambiguous Module Controller path, and a fragment reference cycle).
 *
 * Usage:
 *   gen_sample_jmx.js OUT.jmx [target_bytes]   large ~1MB ecommerce plan (default)
 *   gen_sample_jmx.js OUT.jmx --small          small (<20KB) plan
 *   gen_sample_jmx.js OUT.jmx --refs           dedicated references/export fixture
 */

const fs = require('fs');

let seed = 42;
function rnd() {
  // xorshift32 with a fixed seed: same output every run, for reproducible fixtures.
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed |= 0;
  return ((seed >>> 0) % 1000000) / 1000000;
}
function rndInt(lo, hi) {
  return lo + Math.floor(rnd() * (hi - lo + 1));
}
function rndChoice(arr) {
  return arr[Math.floor(rnd() * arr.length)];
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sp(name, val) {
  return `<stringProp name="${name}">${escapeXml(val)}</stringProp>`;
}
function bp(name, val) {
  return `<boolProp name="${name}">${String(val).toLowerCase()}</boolProp>`;
}
function ip(name, val) {
  return `<intProp name="${name}">${val}</intProp>`;
}
function ht(children = '') {
  return children ? `<hashTree>${children}</hashTree>` : '<hashTree/>';
}

function saveCfg() {
  return (
    '<objProp><name>saveConfig</name><value class="SampleSaveConfiguration">' +
    '<time>true</time><latency>true</latency><timestamp>true</timestamp><success>true</success>' +
    '<label>true</label><code>true</code><message>true</message><threadName>true</threadName>' +
    '<dataType>true</dataType><encoding>false</encoding><assertions>true</assertions>' +
    '<subresults>true</subresults><responseData>false</responseData><samplerData>false</samplerData>' +
    '<xml>false</xml><fieldNames>true</fieldNames><responseHeaders>false</responseHeaders>' +
    '<requestHeaders>false</requestHeaders><responseDataOnError>false</responseDataOnError>' +
    '<saveAssertionResultsFailureMessage>true</saveAssertionResultsFailureMessage>' +
    '<assertionsResultsToSave>0</assertionsResultsToSave><bytes>true</bytes><sentBytes>true</sentBytes>' +
    '<url>true</url><threadCounts>true</threadCounts><idleTime>true</idleTime><connectTime>true</connectTime>' +
    '</value></objProp>'
  );
}

function el(tag, gui, testclass, name, body = '', enabled = true) {
  return `<${tag} guiclass="${gui}" testclass="${testclass}" testname="${escapeXml(name)}" enabled="${String(enabled).toLowerCase()}">${body}</${tag}>`;
}

function http(name, method, pathStr, params, body, enabled = true, children = '', redirects = true, domain = '') {
  let args = '';
  if (body !== undefined && body !== null) {
    args =
      '<elementProp name="HTTPsampler.Arguments" elementType="Arguments">' +
      '<collectionProp name="Arguments.arguments">' +
      '<elementProp name="" elementType="HTTPArgument">' +
      bp('HTTPArgument.always_encode', false) + sp('Argument.value', body) + sp('Argument.metadata', '=') +
      '</elementProp></collectionProp></elementProp>';
  } else if (params) {
    const inner = Object.entries(params)
      .map(
        ([k, v]) =>
          `<elementProp name="${escapeXml(k)}" elementType="HTTPArgument">` +
          bp('HTTPArgument.always_encode', true) + sp('Argument.value', v) + sp('Argument.metadata', '=') +
          bp('HTTPArgument.use_equals', true) + sp('Argument.name', k) + '</elementProp>'
      )
      .join('');
    args =
      '<elementProp name="HTTPsampler.Arguments" elementType="Arguments" guiclass="HTTPArgumentsPanel" ' +
      `testclass="Arguments" enabled="true"><collectionProp name="Arguments.arguments">${inner}</collectionProp></elementProp>`;
  }
  let b =
    args + sp('HTTPSampler.domain', domain) + sp('HTTPSampler.port', '') + sp('HTTPSampler.protocol', '') +
    sp('HTTPSampler.contentEncoding', '') + sp('HTTPSampler.path', pathStr) + sp('HTTPSampler.method', method) +
    bp('HTTPSampler.follow_redirects', redirects) + bp('HTTPSampler.auto_redirects', false) +
    bp('HTTPSampler.use_keepalive', true) + bp('HTTPSampler.DO_MULTIPART_POST', false) +
    sp('HTTPSampler.embedded_url_re', '') + sp('HTTPSampler.connect_timeout', '') + sp('HTTPSampler.response_timeout', '');
  if (body !== undefined && body !== null) b = bp('HTTPSampler.postBodyRaw', true) + b;
  return el('HTTPSamplerProxy', 'HttpTestSampleGui', 'HTTPSamplerProxy', name, b, enabled) + ht(children);
}

function jsonExtractor(varName, expr) {
  return (
    el('JSONPostProcessor', 'JSONPostProcessorGui', 'JSONPostProcessor', `Extract ${varName}`,
      sp('JSONPostProcessor.referenceNames', varName) + sp('JSONPostProcessor.jsonPathExprs', expr) +
        sp('JSONPostProcessor.match_numbers', '1') + sp('JSONPostProcessor.defaultValues', 'NOT_FOUND')) + ht()
  );
}

function regexExtractor(varName, regex, match = '1') {
  return (
    el('RegexExtractor', 'RegexExtractorGui', 'RegexExtractor', `Regex ${varName}`,
      sp('RegexExtractor.useHeaders', 'false') + sp('RegexExtractor.refname', varName) +
        sp('RegexExtractor.regex', regex) + sp('RegexExtractor.template', '$1$') +
        sp('RegexExtractor.default', 'NOT_FOUND') + sp('RegexExtractor.match_number', match)) + ht()
  );
}

function statusAssert(code = '200') {
  return (
    el('ResponseAssertion', 'AssertionGui', 'ResponseAssertion', `Assert ${code}`,
      '<collectionProp name="Asserion.test_strings">' + sp('49586', code) + '</collectionProp>' +
        sp('Assertion.custom_message', '') + sp('Assertion.test_field', 'Assertion.response_code') +
        bp('Assertion.assume_success', false) + ip('Assertion.test_type', 8)) + ht()
  );
}

function bodyAssert(text) {
  return (
    el('ResponseAssertion', 'AssertionGui', 'ResponseAssertion', 'Assert body contains',
      '<collectionProp name="Asserion.test_strings">' + sp('1234567', text) + '</collectionProp>' +
        sp('Assertion.test_field', 'Assertion.response_data') + bp('Assertion.assume_success', false) +
        ip('Assertion.test_type', 2)) + ht()
  );
}

function timer(lo = 500, rng = 1500) {
  return el('UniformRandomTimer', 'UniformRandomTimerGui', 'UniformRandomTimer', 'Think time',
    sp('ConstantTimer.delay', lo) + sp('RandomTimer.range', rng)) + ht();
}

function constTimer(ms) {
  return el('ConstantTimer', 'ConstantTimerGui', 'ConstantTimer', 'Pause', sp('ConstantTimer.delay', ms)) + ht();
}

const GROOVY = `import groovy.json.JsonSlurper

def resp = new JsonSlurper().parseText(prev.getResponseDataAsString())
def total = resp.items?.sum { it.price * it.qty } ?: 0
vars.put("cartTotal", String.valueOf(total))
if (total > 500) {
    vars.put("bigCart", "true")
}
log.info("cart total {} for user {}", total, vars.get("username"))
`;

function jsr223(name, script = GROOVY, kindTag = 'JSR223PostProcessor', gui = 'TestBeanGUI') {
  return el(kindTag, gui, kindTag, name, sp('cacheKey', 'true') + sp('filename', '') + sp('parameters', '') +
    sp('script', script) + sp('scriptLanguage', 'groovy')) + ht();
}

function ifController(name, cond, children, enabled = true) {
  return el('IfController', 'IfControllerPanel', 'IfController', name,
    sp('IfController.condition', cond) + bp('IfController.evaluateAll', false) + bp('IfController.useExpression', true), enabled) + ht(children);
}

function tx(name, children, parent = false) {
  return el('TransactionController', 'TransactionControllerGui', 'TransactionController', name,
    bp('TransactionController.includeTimers', false) + bp('TransactionController.parent', parent)) + ht(children);
}

function loop(name, n, children) {
  return el('LoopController', 'LoopControlPanel', 'LoopController', name,
    bp('LoopController.continue_forever', true) + sp('LoopController.loops', n)) + ht(children);
}

function orderBody(nItems) {
  const items = Array.from({ length: nItems }, () => ({
    sku: `SKU-${rndInt(1000, 9999)}`,
    qty: rndInt(1, 4),
    price: Math.round(rnd() * 245 * 100 + 500) / 100,
    currency: 'EUR',
    gift: rnd() < 0.1,
    note: 'x'.repeat(rndInt(0, 40)),
    attributes: { color: rndChoice(['red', 'blue', 'green']), size: rndChoice(['S', 'M', 'L']) },
  }));
  return JSON.stringify(
    {
      customerId: '${userId}', cartId: '${cartId}', items,
      shipping: { method: 'express', address: { street: '1 Main St', zip: '10115', city: 'Berlin' } },
      token: '${token}', traceId: '${__UUID()}', ts: "${__time(yyyy-MM-dd'T'HH:mm:ss)}",
    },
    null,
    2
  );
}

function flow(i) {
  const kinds = ['browse', 'cart', 'checkout', 'account', 'search'];
  const k = kinds[i % kinds.length];
  const s = [];
  if (k === 'browse') {
    s.push(http(`GET /api/products?page=${i}`, 'GET', '/api/products', { page: String(i), size: '24', sort: 'price' },
      undefined, true, statusAssert() + jsonExtractor('productId', '$.items[0].id') + timer()));
    s.push(http('GET /api/products/{id}', 'GET', '/api/products/${productId}', undefined, undefined, true,
      statusAssert() + bodyAssert('sku') + regexExtractor('csrf', 'name="csrf" value="(.+?)"')));
    s.push(http('GET /static/img', 'GET', '/static/img/${productId}.jpg', undefined, undefined, true,
      statusAssert('200') + constTimer(300), false));
  } else if (k === 'cart') {
    s.push(http('POST /api/cart', 'POST', '/api/cart', undefined, orderBody(rndInt(8, 18)), true,
      statusAssert('201') + jsonExtractor('cartId', '$.cartId') + jsr223('Compute total')));
    s.push(ifController('If big cart', '${__groovy(vars.get("bigCart") == "true")}',
      http('POST /api/cart/coupon', 'POST', '/api/cart/coupon', undefined,
        JSON.stringify({ code: 'BIG10', cartId: '${cartId}' }), true, statusAssert())));
    s.push(loop('Add 3 more', 3, http('PUT /api/cart/items', 'PUT', '/api/cart/items', undefined, orderBody(2), true, statusAssert())));
  } else if (k === 'checkout') {
    s.push(http('POST /api/orders', 'POST', '/api/orders', undefined, orderBody(rndInt(10, 22)), true,
      statusAssert('201') + jsonExtractor('orderId', '$.id') + timer(1000, 2000)));
    s.push(http('POST /api/payments', 'POST', '/api/payments', undefined,
      JSON.stringify({ orderId: '${orderId}', method: 'card', amount: '${cartTotal}' }), true,
      statusAssert() + bodyAssert('APPROVED')));
    s.push(http('GET /api/orders/{id}', 'GET', '/api/orders/${orderId}', undefined, undefined, i % 3 !== 0, statusAssert()));
  } else if (k === 'account') {
    s.push(http('GET /api/account', 'GET', '/api/account', undefined, undefined, true, statusAssert() + jsonExtractor('email', '$.email')));
    s.push(http('POST /api/account/address', 'POST', '/api/account/address', undefined, orderBody(1), true, statusAssert()));
  } else {
    s.push(http(`GET /search?q=${i}`, 'GET', '/search', { q: `term${i}`, lang: 'en' }, undefined, true,
      statusAssert() + regexExtractor('hits', '"total":(\\d+)')));
    s.push(http('GET /api/suggest', 'GET', '/api/suggest', { q: 'te' }, undefined, true, statusAssert()));
  }
  return tx(`TC${String(i).padStart(3, '0')}_${k[0].toUpperCase()}${k.slice(1)}`, s.join(''), true);
}

function buildLarge(target) {
  const udv =
    '<elementProp name="TestPlan.user_defined_variables" elementType="Arguments" guiclass="ArgumentsPanel" ' +
    'testclass="Arguments" testname="User Defined Variables" enabled="true"><collectionProp name="Arguments.arguments">' +
    [
      ['baseUrl', 'shop.example.com'], ['users', '${__P(users,50)}'], ['rampUp', '${__P(rampup,120)}'], ['env', 'staging'],
    ]
      .map(([k, v]) => `<elementProp name="${k}" elementType="Argument">${sp('Argument.name', k)}${sp('Argument.value', v)}${sp('Argument.metadata', '=')}</elementProp>`)
      .join('') +
    '</collectionProp></elementProp>';
  const plan = el('TestPlan', 'TestPlanGui', 'TestPlan', 'Ecomm Load Test',
    sp('TestPlan.comments', 'Generated sample') + bp('TestPlan.functional_mode', false) +
      bp('TestPlan.serialize_threadgroups', false) + udv + sp('TestPlan.user_define_classpath', ''));

  const defaults = el('ConfigTestElement', 'HttpDefaultsGui', 'ConfigTestElement', 'HTTP Request Defaults',
    '<elementProp name="HTTPsampler.Arguments" elementType="Arguments" guiclass="HTTPArgumentsPanel" ' +
      'testclass="Arguments" enabled="true"><collectionProp name="Arguments.arguments"/></elementProp>' +
      sp('HTTPSampler.domain', '${baseUrl}') + sp('HTTPSampler.protocol', 'https') +
      sp('HTTPSampler.connect_timeout', '5000') + sp('HTTPSampler.response_timeout', '30000')) + ht();
  const hdr = el('HeaderManager', 'HeaderPanel', 'HeaderManager', 'HTTP Header Manager',
    '<collectionProp name="HeaderManager.headers">' +
      [
        ['Content-Type', 'application/json'], ['Accept', 'application/json'],
        ['Authorization', 'Bearer ${token}'], ['X-Trace', '${__UUID()}'],
      ]
        .map(([k, v]) => `<elementProp name="" elementType="Header">${sp('Header.name', k)}${sp('Header.value', v)}</elementProp>`)
        .join('') +
      '</collectionProp>') + ht();
  const cookies = el('CookieManager', 'CookiePanel', 'CookieManager', 'HTTP Cookie Manager',
    '<collectionProp name="CookieManager.cookies"/>' + bp('CookieManager.clearEachIteration', true)) + ht();
  const csv = el('CSVDataSet', 'TestBeanGUI', 'CSVDataSet', 'Users CSV',
    sp('delimiter', ',') + sp('fileEncoding', 'UTF-8') + sp('filename', 'data/users.csv') +
      bp('ignoreFirstLine', true) + bp('quotedData', false) + bp('recycle', false) + bp('stopThread', true) +
      sp('shareMode', 'shareMode.all') + sp('variableNames', 'username,password,userId')) + ht();

  const login = http('POST /auth/login', 'POST', '/auth/login', undefined,
    JSON.stringify({ username: '${username}', password: '${password}' }), true,
    statusAssert() + jsonExtractor('token', '$.access_token') + constTimer(200));
  const setupTg = el('SetupThreadGroup', 'SetupThreadGroupGui', 'SetupThreadGroup', 'setUp - seed',
    sp('ThreadGroup.on_sample_error', 'continue') +
      '<elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" ' +
      'testclass="LoopController" testname="Loop Controller" enabled="true">' +
      bp('LoopController.continue_forever', false) + ip('LoopController.loops', 1) + '</elementProp>' +
      sp('ThreadGroup.num_threads', '1') + sp('ThreadGroup.ramp_time', '1')) + ht(tx('Seed_Login', login, false));

  function tg(name, threads, ramp, duration, flows, enabled = true) {
    return el('ThreadGroup', 'ThreadGroupGui', 'ThreadGroup', name,
      sp('ThreadGroup.on_sample_error', 'continue') +
        '<elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" ' +
        'testclass="LoopController" testname="Loop Controller" enabled="true">' +
        bp('LoopController.continue_forever', false) + ip('LoopController.loops', -1) + '</elementProp>' +
        sp('ThreadGroup.num_threads', threads) + sp('ThreadGroup.ramp_time', ramp) +
        bp('ThreadGroup.scheduler', true) + sp('ThreadGroup.duration', duration) +
        sp('ThreadGroup.delay', ''), enabled) + ht(csv + flows);
  }

  const flowsMain = [];
  const flowsB = [];
  let size = 0;
  let i = 0;
  const base = plan.length + 20000;
  while (base + size < target) {
    const f = flow(i);
    (i % 3 ? flowsMain : flowsB).push(f);
    size += f.length;
    i += 1;
  }
  const tgMain = tg('Browse and Buy', '${users}', '${rampUp}', '600', flowsMain.join(''));
  const cstg =
    '<com.blazemeter.jmeter.threads.concurrency.ConcurrencyThreadGroup guiclass="com.blazemeter.jmeter.threads.' +
    'concurrency.ConcurrencyThreadGroupGui" testclass="com.blazemeter.jmeter.threads.concurrency.' +
    'ConcurrencyThreadGroup" testname="bzm - Concurrency Thread Group" enabled="true">' +
    sp('TargetLevel', '100') + sp('RampUp', '300') + sp('Steps', '5') + sp('Hold', '900') + sp('Unit', 'S') +
    '</com.blazemeter.jmeter.threads.concurrency.ConcurrencyThreadGroup>';
  const vtt =
    '<kg.apc.jmeter.timers.VariableThroughputTimer guiclass="kg.apc.jmeter.timers.VariableThroughputTimerGui" ' +
    'testclass="kg.apc.jmeter.timers.VariableThroughputTimer" testname="Throughput Shaping Timer" enabled="true">' +
    '</kg.apc.jmeter.timers.VariableThroughputTimer>';
  const tgB = cstg + ht(csv + flowsB.join('') + vtt + ht());
  const listeners =
    el('ResultCollector', 'ViewResultsFullVisualizer', 'ResultCollector', 'View Results Tree',
      bp('ResultCollector.error_logging', false) + saveCfg() + sp('filename', ''), false) + ht() +
    el('ResultCollector', 'SummaryReport', 'ResultCollector', 'Summary Report',
      bp('ResultCollector.error_logging', false) + saveCfg() + sp('filename', 'results/summary.csv')) + ht();
  const tgOff = tg('Legacy soak (disabled)', '10', '10', '3600', flow(999), false);

  const planChildren = defaults + hdr + cookies + setupTg + tgMain + tgB + tgOff + listeners;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">\n' +
    `<hashTree>${plan}${ht(planChildren)}</hashTree></jmeterTestPlan>\n`
  );
}

function modulePathProp(segments) {
  return '<collectionProp name="ModuleController.node_path">' + segments.map((s) => `<stringProp name="">${escapeXml(s)}</stringProp>`).join('') + '</collectionProp>';
}

function moduleController(name, segments) {
  return el('ModuleController', 'ModuleControllerGui', 'ModuleController', name, modulePathProp(segments)) + ht();
}

function testFragment(name, children) {
  return el('TestFragment', 'TestFragmentControllerPanel', 'TestFragment', name) + ht(children);
}

function includeController(name, includePath) {
  return el('IncludeController', 'IncludeControllerGui', 'IncludeController', name, sp('IncludeController.includepath', includePath)) + ht();
}

function nestedTx(depth, i) {
  if (depth <= 0) return http(`GET /deep/${i}`, 'GET', `/deep/${i}`, undefined, undefined, true, statusAssert());
  return tx(`DeepTC_L${depth}_${i}`, nestedTx(depth - 1, i), false);
}

function buildReferencesFixture(planTitle = 'Refs Test Plan') {
  const udv = '';
  const plan = el('TestPlan', 'TestPlanGui', 'TestPlan', planTitle,
    sp('TestPlan.comments', 'export/reference fixture') + bp('TestPlan.functional_mode', false) +
      bp('TestPlan.serialize_threadgroups', false) + sp('TestPlan.user_define_classpath', ''));

  // nested Transaction Controllers (5 levels deep)
  const deep = nestedTx(5, 1);

  // Module Controller + Test Fragment pair
  const loginFragment = testFragment('Login Fragment',
    http('POST /auth/login', 'POST', '/auth/login', undefined, JSON.stringify({ u: '${username}' }), true, statusAssert()));
  const callsLogin = moduleController('Call Login', [planTitle, 'Login Fragment']);

  // Include Controller
  const includeCtrl = includeController('Legacy checkout (external)', 'legacy/checkout.jmx');

  // ambiguous Module Controller path: two fragments sharing the same name
  const ambiguousA = testFragment('Checkout', http('GET /checkout/a', 'GET', '/checkout/a', undefined, undefined, true, statusAssert()));
  const ambiguousB = testFragment('Checkout', http('GET /checkout/b', 'GET', '/checkout/b', undefined, undefined, true, statusAssert()));
  const callsAmbiguous = moduleController('Call Checkout (ambiguous)', [planTitle, 'Checkout']);

  // reference cycle: Fragment A calls Fragment B and vice versa
  const callsB = moduleController('Call Fragment B', [planTitle, 'Fragment B']);
  const callsA = moduleController('Call Fragment A', [planTitle, 'Fragment A']);
  const fragmentA = testFragment('Fragment A', http('GET /a', 'GET', '/a', undefined, undefined, true, statusAssert()) + callsB);
  const fragmentB = testFragment('Fragment B', http('GET /b', 'GET', '/b', undefined, undefined, true, statusAssert()) + callsA);

  const mainFlow = tx('Main checkout flow', deep + callsLogin + callsAmbiguous, true);
  const tg = el('ThreadGroup', 'ThreadGroupGui', 'ThreadGroup', 'Main',
    sp('ThreadGroup.on_sample_error', 'continue') +
      '<elementProp name="ThreadGroup.main_controller" elementType="LoopController" guiclass="LoopControlPanel" ' +
      'testclass="LoopController" testname="Loop Controller" enabled="true">' +
      bp('LoopController.continue_forever', false) + ip('LoopController.loops', 1) + '</elementProp>' +
      sp('ThreadGroup.num_threads', '5') + sp('ThreadGroup.ramp_time', '1')) + ht(mainFlow);

  const planChildren = tg + loginFragment + includeCtrl + ambiguousA + ambiguousB + fragmentA + fragmentB;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">\n' +
    `<hashTree>${plan}${ht(planChildren)}</hashTree></jmeterTestPlan>\n`
  );
}

function buildSmall() {
  const plan = el('TestPlan', 'TestPlanGui', 'TestPlan', 'Small Plan', bp('TestPlan.functional_mode', false));
  const tg = el('ThreadGroup', 'ThreadGroupGui', 'ThreadGroup', 'Smoke',
    sp('ThreadGroup.num_threads', '1') + sp('ThreadGroup.ramp_time', '1')) + ht(
    tx('Check home page', http('GET /', 'GET', '/', undefined, undefined, true, statusAssert()), true)
  );
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<jmeterTestPlan version="1.2" properties="5.0" jmeter="5.6.3">\n' +
    `<hashTree>${plan}${ht(tg)}</hashTree></jmeterTestPlan>\n`
  );
}

function reindent(xmlText) {
  const xml = require('./xml');
  const withoutDecl = xmlText.replace(/^<\?xml[^>]*\?>\s*/, '');
  const root = xml.parseString(withoutDecl);
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + xml.toXmlString(root) + '\n';
}

function main(argv) {
  const out = argv[0] || 'sample.jmx';
  let text;
  if (argv[1] === '--small') {
    text = reindent(buildSmall());
  } else if (argv[1] === '--refs') {
    text = reindent(buildReferencesFixture());
  } else {
    const target = argv[1] ? parseInt(argv[1], 10) : 1050000;
    text = reindent(buildLarge(target));
  }
  fs.writeFileSync(out, text);
  console.log(`wrote ${out} (${fs.statSync(out).size.toLocaleString()} bytes)`);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { buildLarge, buildReferencesFixture, buildSmall, main };
