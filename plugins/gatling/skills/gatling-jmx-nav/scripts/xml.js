'use strict';

/**
 * Minimal, dependency-free XML parser/serializer covering the subset of XML that
 * JMeter .jmx files use: elements, attributes, leaf text, CDATA, comments, no
 * namespaces, no external DTD.
 */

class XmlParseError extends Error {}

class Element {
  constructor(tag) {
    this.tag = tag;
    this.attrib = Object.create(null);
    this.text = '';
    this.children = [];
  }

  get(name, def = '') {
    return Object.prototype.hasOwnProperty.call(this.attrib, name) ? this.attrib[name] : def;
  }

  find(tag) {
    for (const c of this.children) {
      if (c.tag === tag) return c;
    }
    return null;
  }

  *iter() {
    yield this;
    for (const c of this.children) yield* c.iter();
  }

  // Lets `for (const c of el)` iterate direct children.
  [Symbol.iterator]() {
    return this.children[Symbol.iterator]();
  }
}

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[A-Za-z0-9_:.\-]/;

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    switch (body) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        return m;
    }
  });
}

function parseString(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const n = text.length;
  let i = 0;
  let root = null;
  const stack = [];

  function fail(msg) {
    const line = text.slice(0, i).split('\n').length;
    throw new XmlParseError(`${msg} (line ${line})`);
  }

  function appendText(raw) {
    if (stack.length === 0) return;
    const top = stack[stack.length - 1];
    if (top.children.length === 0) top.text += raw;
  }

  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt === -1) {
      if (text.slice(i).trim() !== '') appendText(decodeEntities(text.slice(i)));
      break;
    }
    if (lt > i) appendText(decodeEntities(text.slice(i, lt)));
    i = lt;

    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end === -1) fail('unterminated comment');
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9);
      if (end === -1) fail('unterminated CDATA section');
      appendText(text.slice(i + 9, end));
      i = end + 3;
      continue;
    }
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      if (end === -1) fail('unterminated processing instruction');
      i = end + 2;
      continue;
    }
    if (text.startsWith('<!', i)) {
      const end = text.indexOf('>', i + 2);
      if (end === -1) fail('unterminated declaration');
      i = end + 1;
      continue;
    }
    if (text.startsWith('</', i)) {
      let j = i + 2;
      while (j < n && text[j] !== '>') j++;
      if (j >= n) fail('unterminated closing tag');
      const name = text.slice(i + 2, j).trim();
      if (stack.length === 0) fail(`closing tag </${name}> with no open element`);
      const top = stack.pop();
      if (top.tag !== name) fail(`mismatched closing tag: expected </${top.tag}>, got </${name}>`);
      i = j + 1;
      continue;
    }

    // Opening (or self-closing) tag.
    let j = i + 1;
    if (j >= n || !NAME_START.test(text[j])) fail('expected element name');
    const nameStart = j;
    while (j < n && NAME_CHAR.test(text[j])) j++;
    const tag = text.slice(nameStart, j);
    const el = new Element(tag);

    for (;;) {
      while (j < n && /\s/.test(text[j])) j++;
      if (j >= n) fail(`unterminated tag <${tag}>`);
      if (text[j] === '/' && text[j + 1] === '>') {
        j += 2;
        break;
      }
      if (text[j] === '>') {
        j += 1;
        break;
      }
      const attrStart = j;
      while (j < n && NAME_CHAR.test(text[j])) j++;
      if (j === attrStart) fail(`malformed attribute in <${tag}>`);
      const attrName = text.slice(attrStart, j);
      while (j < n && /\s/.test(text[j])) j++;
      if (text[j] !== '=') fail(`expected '=' after attribute "${attrName}" in <${tag}>`);
      j++;
      while (j < n && /\s/.test(text[j])) j++;
      const quote = text[j];
      if (quote !== '"' && quote !== "'") fail(`expected quoted value for attribute "${attrName}" in <${tag}>`);
      j++;
      const valStart = j;
      const valEnd = text.indexOf(quote, j);
      if (valEnd === -1) fail(`unterminated attribute value for "${attrName}" in <${tag}>`);
      el.attrib[attrName] = decodeEntities(text.slice(valStart, valEnd));
      j = valEnd + 1;
    }

    const selfClosed = text[j - 2] === '/' && text[j - 1] === '>';
    if (stack.length > 0) stack[stack.length - 1].children.push(el);
    if (root === null) root = el;
    if (!selfClosed) stack.push(el);
    i = j;
  }

  if (root === null) fail('no root element found');
  if (stack.length > 0) fail(`unclosed element <${stack[stack.length - 1].tag}>`);
  return root;
}

function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return escapeText(s).replace(/"/g, '&quot;');
}

// Pretty-printed serialization (2-space indent), not byte-exact to the source
// formatting, but a readable, self-closing-aware rendering good enough for `raw` output.
function toXmlString(el, depth = 0) {
  const pad = '  '.repeat(depth);
  const attrs = Object.keys(el.attrib)
    .map((k) => ` ${k}="${escapeAttr(el.attrib[k])}"`)
    .join('');
  if (el.children.length === 0) {
    const text = el.text || '';
    if (text === '') return `${pad}<${el.tag}${attrs}/>`;
    return `${pad}<${el.tag}${attrs}>${escapeText(text)}</${el.tag}>`;
  }
  const inner = el.children.map((c) => toXmlString(c, depth + 1)).join('\n');
  return `${pad}<${el.tag}${attrs}>\n${inner}\n${pad}</${el.tag}>`;
}

module.exports = { Element, XmlParseError, parseString, toXmlString };
