/**
 * The only way either page builds DOM from event data. Event text is untrusted
 * (owner replies, agent requests, Darwin's descriptions of third parties), so it
 * is set with textContent and never parsed as HTML.
 */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string | null): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/** Sets text only when it changed, so screen readers and text selection are not disturbed. */
export function setText(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

export function $<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const node = root.querySelector<T>(selector);
  if (!node) throw new Error(`Missing element ${selector}`);
  return node;
}
