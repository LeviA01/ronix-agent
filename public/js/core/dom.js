export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function on(target, event, handler, options) {
  target.addEventListener(event, handler, options);
}

export function setHidden(el, hidden) {
  if (el) el.hidden = hidden;
}
