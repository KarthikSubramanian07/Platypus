/** Every code block on a content page gets a copy button. Comments after "#" stay in, so the copied text matches what's shown. */
export function codeText(pre: HTMLElement): string {
  return (pre.innerText || pre.textContent || "").replace(/\n+$/, "");
}

const SVG = "http://www.w3.org/2000/svg";

/** The two-squares copy icon, built with DOM calls: this package never parses strings as HTML. */
function copyIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  const rect = document.createElementNS(SVG, "rect");
  for (const [k, v] of Object.entries({ x: "5", y: "5", width: "9", height: "9", rx: "2", stroke: "currentColor", "stroke-width": "1.5" })) rect.setAttribute(k, v);
  const path = document.createElementNS(SVG, "path");
  for (const [k, v] of Object.entries({ d: "M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5", stroke: "currentColor", "stroke-width": "1.5" })) path.setAttribute(k, v);
  svg.append(rect, path);
  return svg;
}

export function addCopyButtons(root: ParentNode = document): void {
  for (const pre of root.querySelectorAll<HTMLElement>(".prose pre")) {
    if (pre.parentElement?.classList.contains("code-block")) continue;
    const wrap = document.createElement("div");
    wrap.className = "code-block";
    pre.replaceWith(wrap);
    wrap.append(pre);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy-btn";
    const label = document.createElement("span");
    label.textContent = "Copy";
    button.append(copyIcon(), label);
    button.setAttribute("aria-label", "Copy this command");
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(codeText(pre));
        label.textContent = "Copied";
        button.dataset.copied = "";
      } catch {
        // No clipboard permission: select the text so Cmd/Ctrl+C works.
        const range = document.createRange();
        range.selectNodeContents(pre);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
        label.textContent = "Press ⌘C";
      }
      setTimeout(() => {
        label.textContent = "Copy";
        delete button.dataset.copied;
      }, 1800);
    });
    wrap.append(button);
  }
  // Wide tables scroll on their own instead of pushing the page sideways.
  for (const table of root.querySelectorAll<HTMLTableElement>(".prose table")) {
    if (table.parentElement?.classList.contains("table-scroll")) continue;
    const scroller = document.createElement("div");
    scroller.className = "table-scroll";
    table.replaceWith(scroller);
    scroller.append(table);
  }
}
