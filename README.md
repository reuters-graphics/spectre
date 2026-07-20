# 👻 Spectre — local cross-browser UI audit harness

> Catch UI regressions on the routes that matter, on the devices that matter,
> **before** they hit production.

Spectre runs a small [Playwright](https://playwright.dev) audit across every
route × emulated device you care about and aggregates the findings into a
single browsable HTML report — plus a Markdown summary, a CI-friendly JSON,
and an LLM-ready post-mortem prompt.

It emulates iPhone / iPad / Pixel / Galaxy viewports and desktop
Chromium / WebKit / Firefox — no accounts, no paid seats, runs on your machine.

Captures per route × device:

- ❌ Console errors + warnings + uncaught `pageerror`s
- 🌐 Failed network requests
- 📐 Horizontal-overflow offenders (elements wider than the viewport)
- ♿ axe-core a11y violations (`critical` / `serious`)
- 🖼️ Full-page screenshots (base + per declared interaction)
- 🔍 Pixel-diff each device against the family baseline (desktop / mobile / tablet)

---

## 📦 Install

```bash
pnpm add -D @reuters-graphics/spectre @playwright/test
npx playwright install        # one-time: download the emulated browsers
```

`@playwright/test` is a peer dependency (you control the version). `sharp` is an
optional dependency — install it too if you want pixel-diff badges in the report.

---

## 🚦 Define your routes

Spectre audits **your** routes, so each project supplies its own list. Copy the
starter and edit it:

```bash
cp node_modules/@reuters-graphics/spectre/routes.example.ts ./spectre.routes.ts
```

A routes file just exports a `ROUTES` array:

```ts
// spectre.routes.ts
export const ROUTES = [
  { path: '/', label: 'home', waitFor: 'main' },
  {
    path: '/about/',
    label: 'about',
    waitFor: '.content',
    // optional: extra screenshots after an interaction
    interactions: [
      { name: 'menu-open', click: '[data-test="menu-toggle"]', pause: 400 },
    ],
  },
];
```

Each route declares:

| Field | Purpose |
| --- | --- |
| `path` | URL path, joined with `AUDIT_BASE_URL` at runtime |
| `label` | Human-readable name (used in report + screenshot filenames) |
| `waitFor` | CSS selector that must be visible before screenshotting |
| `settleMs` | *(optional)* extra settle time for data-heavy pages |
| `interactions` | *(optional)* post-load clicks, each producing an extra screenshot |

Spectre finds your routes automatically, in this order:

1. `SPECTRE_ROUTES=./path/to/routes.ts` env var
2. `spectre.routes.ts` / `.js` in your project root
3. `spectre.config.ts` / `.js` in your project root
4. `"spectre": { "routes": "./path/to/routes.ts" }` in `package.json`

Routes whose `path` still contains `<…>` placeholder markers are skipped at
runtime with a warning — handy for slugs you haven't filled in yet.

---

## ▶️ Run it

```bash
# Point at whatever you want to audit — a local dev server or a deployed preview
AUDIT_BASE_URL=http://localhost:4173 npx spectre local
# auto-opens the report when it finishes
```

That single command **cleans → audits → aggregates → runs the post-mortem**.

### Commands

| Command | Does |
| --- | --- |
| `npx spectre` | Interactive menu |
| `npx spectre local` | Run the audit (auto-cleans + reports + post-mortem) |
| `npx spectre show-report` | Reopen the last report in your browser |
| `npx spectre postmortem` | Re-generate the LLM triage prompt for the last sweep |
| `npx spectre clean` | Wipe the output folder |

Add scripts to your `package.json` if you like:

```json
{
  "scripts": {
    "audit": "spectre local",
    "audit:report": "spectre show-report"
  }
}
```

---

## 📂 Output

Everything lands in **`.spectre/`** inside your project (not in `node_modules`):

```
.spectre/
├── index.html              Browsable report viewer (post-mortem + galleries)
├── report.md               Human-readable triage doc
├── report.json             CI summary
├── audit.log               One line appended per run — history trail
├── postmortem-data.json    Clustered findings (for dashboards / CI gates)
├── postmortem-prompt.md    LLM triage prompt
├── screenshots/<device>/<route>[--<interaction>].png
├── reports/<device>/<route>.json
└── playwright-report/      Playwright's native HTML report
```

Add `.spectre/` to your `.gitignore` (or commit it if you want a permanent
trail). Redirect it anywhere with `SPECTRE_OUTPUT_DIR=/some/dir`.

---

## 🧠 LLM triage (post-mortem)

Every run clusters all console errors, network failures and a11y violations
across devices, ranks routes by severity, and writes an LLM prompt to
`.spectre/postmortem-prompt.md` (also copied to your clipboard). Paste it into
Claude / ChatGPT / any LLM to get:

- Top 5 issues with probable cause + concrete fix
- Quick wins (one-line fixes)
- Investigations needed
- 🟢 / 🟡 / 🔴 ship verdict

The report's HTML viewer has a built-in "🧠 Post-mortem" section with a
one-click **Copy prompt** button. Re-run standalone any time with
`npx spectre postmortem`.

---

## 🛡️ Auditing a host that returns "access denied"

If the preview origin is IP-allowlisted, VPN-only, password-protected, or just
rate-limits aggressively, tune the throttle + header knobs so 401/403/timeout
noise doesn't look like real bugs:

```bash
AUDIT_ROUTE_DELAY_MS=5000   npx spectre local   # 5s pause between routes
AUDIT_WORKERS=1             npx spectre local   # no parallelism at all
AUDIT_NAV_RETRIES=4         npx spectre local   # more retries per route

# Spoof headers / simulate an internal IP:
AUDIT_EXTRA_HEADERS='{"X-Forwarded-For":"10.0.0.1"}' npx spectre local

# HTTP-Basic protected preview:
AUDIT_BASIC_AUTH='user:s3cret' npx spectre local
```

### All env knobs

| Env | Default | Purpose |
| --- | --- | --- |
| `AUDIT_BASE_URL` | *(spec default)* | Origin prepended to every route |
| `AUDIT_WORKERS` | `1` | Parallel Playwright workers — keep at 1 for rate-limited hosts |
| `AUDIT_RETRIES` | `1` | Playwright test-level retries |
| `AUDIT_NAV_TIMEOUT_MS` | `90000` | Per-navigation timeout |
| `AUDIT_TEST_TIMEOUT_MS` | `180000` | Per-test (route) wall-clock budget |
| `AUDIT_ROUTE_DELAY_MS` | `1500` | Pause between consecutive routes |
| `AUDIT_NAV_RETRIES` | `2` | Extra `goto` retries on 4xx/5xx/timeout |
| `AUDIT_NAV_RETRY_BACKOFF_MS` | `3000` | Linear back-off per nav retry |
| `AUDIT_EXTRA_HEADERS` | — | JSON object merged into every request's headers |
| `AUDIT_USER_AGENT` | — | Overrides the UA — useful if the origin sniffs Playwright |
| `AUDIT_BASIC_AUTH` | — | `user:pass` for HTTP Basic protected previews |
| `SPECTRE_ROUTES` | *(auto)* | Explicit path to your routes module |
| `SPECTRE_OUTPUT_DIR` | `.spectre/` | Where audit artifacts are written |

When the audit detects an access-denied response it records a structured error
(`HTTP 401/403/407`, `429`, `ERR_ABORTED`, `ERR_CONNECTION_RESET`, …) **and**
stops waiting for app-specific selectors on that route, so the rest of the
report stays meaningful.

---

## 🎛️ Which devices?

The emulated device matrix (iPhone 15/SE, Pixel 7, Galaxy S9+, iPad Mini,
desktop Chrome/Safari/Firefox) lives in `playwright.local.config.ts`. Target a
single device with a Playwright pass-through flag:

```bash
npx spectre local -- --project=iphone-15
```

---

## License

MIT © Reuters Graphics
