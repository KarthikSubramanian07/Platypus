// Type "perry" anywhere and the platypus puts on his fedora. Oh, there you are.
export function listenForAgentP(): void {
  let typed = "";
  document.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    typed = (typed + event.key.toLowerCase()).slice(-5);
    if (typed !== "perry") return;
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
