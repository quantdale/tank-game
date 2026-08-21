import assert from 'node:assert/strict';

const elements = new Map();
const appendedStyles = [];
globalThis.document = {
  getElementById: (id) => elements.get(id) || null,
  createElement: (tagName) => ({
    tagName: tagName.toUpperCase(),
    appendChild(child) { (this.children ||= []).push(child); },
  }),
  head: {
    appendChild(style) {
      appendedStyles.push(style);
      elements.set(style.id, style);
    },
  },
};

const { createElement, ensureStyle, escapeHtml } = await import('./dom.js');

const style = ensureStyle('test-style', '.test{}');
assert.equal(style.id, 'test-style');
assert.equal(style.textContent, '.test{}');
assert.equal(ensureStyle('test-style', '.replacement{}'), style);
assert.equal(appendedStyles.length, 1, 'style injection is idempotent by id');

const parent = document.createElement('section');
const child = createElement('button', 'test-button', parent);
assert.equal(child.tagName, 'BUTTON');
assert.equal(child.className, 'test-button');
assert.deepEqual(parent.children, [child]);

// escapeHtml: network-supplied nicknames must not be able to inject markup
// when a UI module interpolates them into an innerHTML template.
assert.equal(escapeHtml('<img src=x onerror=alert(1)>'),
  '&lt;img src=x onerror=alert(1)&gt;', 'angle brackets are neutralized');
assert.equal(escapeHtml('&"\''), '&amp;&quot;&#39;', 'ampersand and quotes are escaped');
assert.equal(escapeHtml('Tank Commander'), 'Tank Commander', 'plain names pass through unchanged');
assert.equal(escapeHtml(null), '', 'nullish renders as empty string');
assert.equal(escapeHtml(42), '42', 'non-strings stringify');

console.log('dom.selftest: shared style and element gates passed');
