// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addCopyButtons } from "./copy-code";

describe("addCopyButtons", () => {
  beforeEach(() => {
    document.body.innerHTML = '<article class="prose"><pre><code>pnpm install\npnpm dev\n</code></pre><table><tr><td>x</td></tr></table></article>';
  });
  afterEach(() => vi.useRealTimers());

  it("wraps each code block with one labelled Copy button and wraps tables to scroll", () => {
    addCopyButtons();
    addCopyButtons(); // idempotent
    const buttons = document.querySelectorAll(".copy-btn");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.getAttribute("aria-label")).toBe("Copy this command");
    expect(buttons[0]!.textContent).toBe("Copy");
    expect(document.querySelector(".code-block > pre")).not.toBeNull();
    expect(document.querySelectorAll(".table-scroll > table")).toHaveLength(1);
  });

  it("copies the command and says so, then resets", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    addCopyButtons();
    const button = document.querySelector<HTMLButtonElement>(".copy-btn")!;
    button.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(String(writeText.mock.calls[0]![0])).toContain("pnpm install");
    await vi.waitFor(() => expect(button.textContent).toBe("Copied"));
    expect(button.dataset.copied).toBe("");
    vi.advanceTimersByTime(1900);
    expect(button.textContent).toBe("Copy");
  });

  it("selects the text when the clipboard is blocked", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => { throw new Error("denied"); } }, configurable: true });
    addCopyButtons();
    const button = document.querySelector<HTMLButtonElement>(".copy-btn")!;
    button.click();
    await vi.waitFor(() => expect(button.textContent).toBe("Press ⌘C"));
  });
});
