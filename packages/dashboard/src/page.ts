// Styles and fonts for the plain content pages; the home page's script also plays the demo.
import "@fontsource/source-serif-4/400.css";
import "@fontsource-variable/dm-sans";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource/caveat/500.css";
import "./styles.css";
import { listenForAgentP } from "./agent-p";
listenForAgentP();
import { addCopyButtons } from "./copy-code";
addCopyButtons();
