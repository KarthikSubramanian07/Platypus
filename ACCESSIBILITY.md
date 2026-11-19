# Accessibility

Platypus aims for **WCAG 2.2 Level AA** on the public dashboard site (the Vite pages under `packages/dashboard`).

## What was tested

- Automated: axe-core (tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`) at 1440×900, 390×844 and 320×800 on `/`, `/live`, `/live-story`, `/business`, `/technical`, `/developers`, `/about`, `/contact`, `/privacy`, a 404, and open states for the home sources panel, home replay, and `/live` details.
- Manual: keyboard reachability of scroll regions, visible focus, skip links, page `lang` and titles, landmarks/headings, live regions on the demo pages, `prefers-reduced-motion`, and reflow at 320px width.

## Known limitations

- `/live` and `/live-story` need a running events source for a live stream. Static builds still render the recorded golden-path fixture; a live gateway was not required for the axe pass.
- The phone mock is illustrative (`role="img"` with a label). It is not a fully operable phone UI for assistive technology beyond that name and the surrounding story copy.
- Wide data tables (supply, docs) scroll inside a keyboard-focusable region rather than reflowing every column at 320px.

## Reporting a barrier

Open an issue at https://github.com/KarthikSubramanian07/Platypus/issues or use the contact page.
