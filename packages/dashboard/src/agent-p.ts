// Type "perry" anywhere and the platypus puts on his fedora. Oh, there you are.
const SECRET = "perry";

/** Feeds keys in one at a time; returns true on the key that completes the secret word. */
export function createPerryDetector(secret = SECRET): (key: string) => boolean {
  let typed = "";
  return (key) => {
    if (key.length !== 1) return false;
    typed = (typed + key.toLowerCase()).slice(-secret.length);
    return typed === secret;
  };
}

export function listenForAgentP(): void {
  const detect = createPerryDetector();
  document.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if (!detect(event.key)) return;
    document.body.classList.add("agent-p");
    let toast = document.querySelector<HTMLElement>(".agent-toast");
    if (!toast) {
      toast = document.createElement("p");
      toast.className = "agent-toast";
      toast.setAttribute("role", "status");
      document.body.append(toast);
    }
    toast.textContent = "Oh, there you are, Perry.";
    toast.dataset.show = "";
    const shown = toast;
    setTimeout(() => delete shown.dataset.show, 2600);
  });
}
