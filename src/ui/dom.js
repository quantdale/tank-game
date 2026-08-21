/** Inject a stylesheet once and return the canonical style element. */
export function ensureStyle(id, css) {
  let style = document.getElementById(id);
  if (style) return style;
  style = document.createElement('style');
  style.id = id;
  style.textContent = css;
  document.head.appendChild(style);
  return style;
}

/** Create an element, optionally assign its class and append it to a parent. */
export function createElement(tag, className = '', parent = null) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (parent) parent.appendChild(element);
  return element;
}

/**
 * Escape a string for safe interpolation into innerHTML templates.
 * Required for any network-supplied text (player nicknames arrive over the
 * wire and must never be able to inject markup). Non-string inputs pass
 * through String() so numeric/nullish fields keep rendering as before.
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
