/**
 * BrowserStack UI audit — Playwright spec.
 *
 * For every route in `routes.ts` this spec:
 *   1. Navigates to the page on the target real device / browser.
 *   2. Waits for the declared anchor selector + network idle.
 *   3. Captures:
 *        • a full-page screenshot                → screenshots/<device>/<route>.png
 *        • all console messages (error/warning)  → reports/<device>/<route>.json
 *        • all failed network requests           → reports/<device>/<route>.json
 *        • horizontal-overflow offenders         → reports/<device>/<route>.json
 *        • axe-core a11y violations              → reports/<device>/<route>.json
 *   4. Optionally drives a small number of interactions (menu toggles, tab
 *      switches) declared on the route — each produces its own screenshot.
 *
 * After the suite finishes, `spectre local` runs the aggregator to combine all
 * per-route JSON files into a single `report.md` (and HTML) for triage.
 */

import {
  test,
  expect,
  type Page,
  type ConsoleMessage,
  type Request,
  type Response,
} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Route types + consumer-provided route loading.
//
// The route list is project-specific, so it is NOT bundled with the package.
// The Spectre CLI resolves the consumer's routes file and passes its absolute
// path via $SPECTRE_ROUTES. We import it dynamically (top-level await is
// supported in Playwright spec modules) so the same spec works for any project.
// ---------------------------------------------------------------------------
export type Interaction = {
  /** Short label appended to the screenshot filename */
  name: string;
  /** Selector to click */
  click?: string;
  /** Selector to wait for AFTER the interaction */
  waitFor?: string;
  /** Milliseconds to wait after interaction (for animations) */
  pause?: number;
};

export type Route = {
  path: string;
  label: string;
  waitFor: string;
  /** Pages that need extra-long settle time (e.g. data-heavy bracket) */
  settleMs?: number;
  interactions?: Interaction[];
};

async function loadRoutes(): Promise<Route[]> {
  const routesPath = process.env.SPECTRE_ROUTES;
  if (!routesPath) {
    throw new Error(
      'SPECTRE_ROUTES is not set. Run the audit via the Spectre CLI ' +
        '(`pnpm spectre local` / `run`), or set SPECTRE_ROUTES to your ' +
        'routes module. See routes.example.ts for the shape.'
    );
  }
  const mod = await import(pathToFileURL(routesPath).href);
  const routes = (mod.ROUTES ?? mod.default) as Route[] | undefined;
  if (!Array.isArray(routes)) {
    throw new Error(
      `Routes module at ${routesPath} must export \`ROUTES\` (or a default) ` +
        'as an array of Route objects.'
    );
  }
  return routes;
}

const ROUTES = await loadRoutes();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const BASE_URL =
  process.env.AUDIT_BASE_URL ||
  'https://graphics.thomsonreuters.com/testfiles/2026/4JYXyaGzfly';

// ---------------------------------------------------------------------------
// Throttle knobs (all env-overridable). The default 1.5s inter-route delay
// keeps the audit gentle on rate-limited preview hosts (e.g. the Reuters
// graphics preview origin, which 403s after a burst of ~10 requests/sec).
// Per-route nav retries combat transient access-denied responses from a CDN
// that hasn't propagated the audit IP yet.
// ---------------------------------------------------------------------------
const ROUTE_DELAY_MS = Number(process.env.AUDIT_ROUTE_DELAY_MS ?? 1_500);
const NAV_RETRIES = Number(process.env.AUDIT_NAV_RETRIES ?? 2);
const NAV_RETRY_BACKOFF_MS = Number(
  process.env.AUDIT_NAV_RETRY_BACKOFF_MS ?? 3_000
);

// All audit artifacts land in the consumer project's output dir (default
// `<project>/.spectre`), resolved from env passed down by the Spectre CLI so
// nothing is ever written inside node_modules. Falls back to cwd-relative if
// the spec is somehow run directly.
const OUT_ROOT =
  process.env.SPECTRE_OUTPUT_DIR ||
  process.env.AUDIT_OUTPUT_DIR ||
  path.resolve(process.env.SPECTRE_PROJECT_ROOT || process.cwd(), '.spectre');
const SCREEN_DIR = path.join(OUT_ROOT, 'screenshots');
const REPORT_DIR = path.join(OUT_ROOT, 'reports');

// axe-core is loaded from CDN to keep the harness dependency-light; if you
// prefer pinning, install `axe-core` and replace the URL with a file read.
const AXE_CDN =
  'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function deviceSlug(projectName: string): string {
  return projectName.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

type ConsoleEntry = { type: string; text: string; location?: string };
type NetworkFailure = { url: string; method: string; failure: string };
type OverflowEntry = {
  selector: string;
  scrollWidth: number;
  clientWidth: number;
};

type RouteReport = {
  device: string;
  route: string;
  url: string;
  loadedAt: string;
  console: ConsoleEntry[];
  networkFailures: NetworkFailure[];
  overflow: OverflowEntry[];
  axeViolations: unknown[];
  screenshots: string[];
  errors: string[];
};

async function collectOverflow(page: Page): Promise<OverflowEntry[]> {
  return page.evaluate(() => {
    const out: {
      selector: string;
      scrollWidth: number;
      clientWidth: number;
    }[] = [];
    const docWidth = document.documentElement.clientWidth;
    const all = document.querySelectorAll<HTMLElement>('body *');
    all.forEach((el) => {
      if (el.scrollWidth > docWidth + 2) {
        // Build a short, useful selector
        const id = el.id ? `#${el.id}` : '';
        const cls =
          el.className && typeof el.className === 'string' ?
            '.' +
            el.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.')
          : '';
        const tag = el.tagName.toLowerCase();
        out.push({
          selector: `${tag}${id}${cls}`.slice(0, 200),
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        });
      }
    });
    // De-dupe by selector
    const seen = new Set<string>();
    return out.filter((o) =>
      seen.has(o.selector) ? false : (seen.add(o.selector), true)
    );
  });
}

/**
 * Dismiss common cookie/consent banners so they don't obscure screenshots.
 *
 * Strategy is tiered:
 *   1. Pre-emptively set ALL known consent cookies on the origin BEFORE
 *      navigation, so most banners never appear in the first place. This
 *      is the most reliable approach — clicking "Accept" buttons is fragile
 *      because every CMP (Cookiebot, OneTrust, CookieYes, etc.) uses
 *      different selectors and many fade in after a timeout.
 *   2. After page load, click any visible "Accept" button on a short
 *      best-effort selector list — catches anything our cookie set missed.
 *   3. Inject a global CSS overlay that hides anything with a high z-index
 *      and the word "cookie"/"consent"/"gdpr" in its class/id — last resort.
 */
async function suppressCookieBanners(page: Page, baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    const cookies = [
      // Reuters / Thomson Reuters
      { name: 'OptanonAlertBoxClosed', value: new Date().toISOString() },
      {
        name: 'OptanonConsent',
        value:
          'isGpcEnabled=0&datestamp=' +
          new Date().toUTCString() +
          '&version=202402.1.0&isIABGlobal=false&hosts=&consentId=audit&interactionCount=1&landingPath=NotLandingPage&groups=C0001:1,C0002:1,C0003:1,C0004:1,C0005:1',
      },
      {
        name: 'eupubconsent-v2',
        value:
          'CPvL2sAPvL2sAAcABBENC0CsAP_AAH_AAAYgIxNf_X__bX9j-_5_aft0eY1P9_r37uQzDhfNk-4F3L_W_LwX52E7NF36pq4KuR4ku3LBIUdlHPHcTUmw6okVrTPsbk2Mr7NKJ7PEmnMbe2dYGH9_n93TuZKY7_____7________77777777f_f__-__e_V___9zfn9_____9vP___9v-_8_/',
      },
      // Cookiebot
      {
        name: 'CookieConsent',
        value:
          '{stamp:%27audit%27%2Cnecessary:true%2Cpreferences:true%2Cstatistics:true%2Cmarketing:true%2Cmethod:%27explicit%27%2Cver:1%2Cutc:' +
          Date.now() +
          '%2Cregion:%27us%27}',
      },
      // OneTrust simple
      { name: 'OptanonAlertBoxClosedV2', value: new Date().toISOString() },
      // CookieYes
      {
        name: 'cookieyes-consent',
        value:
          'consentid:audit,consent:yes,action:yes,necessary:yes,functional:yes,analytics:yes,performance:yes,advertisement:yes',
      },
      // Generic "we showed it, don't show again" flags
      { name: 'cookie_consent', value: 'true' },
      { name: 'cookies_accepted', value: 'true' },
      { name: 'cookieconsent_status', value: 'dismiss' },
      { name: 'gdpr-consent', value: 'true' },
    ];
    await page.context().addCookies(
      cookies.map((c) => ({
        ...c,
        domain: url.hostname,
        path: '/',
      }))
    );
  } catch {
    /* best-effort — if URL is malformed we just skip */
  }
}

/** Click any visible Accept/Agree button after the page has loaded. */
async function clickAwayConsent(page: Page) {
  const selectors = [
    // OneTrust
    '#onetrust-accept-btn-handler',
    'button#accept-recommended-btn-handler',
    // Cookiebot
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    '#CybotCookiebotDialogBodyButtonAccept',
    // CookieYes
    '.cky-btn-accept',
    // Generic role/text selectors
    'button[aria-label*="accept" i]',
    'button[aria-label*="agree" i]',
  ];
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 250 })) {
        await el.click({ timeout: 1000 }).catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }
  // Last-resort: text content
  for (const text of [/^accept all$/i, /^accept$/i, /^agree$/i, /^i agree$/i]) {
    try {
      const el = page.getByRole('button', { name: text }).first();
      if (await el.isVisible({ timeout: 250 })) {
        await el.click({ timeout: 1000 }).catch(() => {});
        break;
      }
    } catch {
      /* ignore */
    }
  }

  // Nuclear option: hide the typical CMP overlays via CSS so screenshots
  // are clean even if the dismissal didn't take.
  await page
    .addStyleTag({
      content: `
      #onetrust-consent-sdk, #onetrust-banner-sdk,
      #CybotCookiebotDialog, .cky-consent-container,
      [class*="cookie-banner" i], [id*="cookie-banner" i],
      [class*="consent-banner" i], [id*="consent-banner" i],
      [class*="gdpr-banner" i], [id*="gdpr-banner" i] {
        display: none !important;
        visibility: hidden !important;
      }
    `,
    })
    .catch(() => {});
}

async function runAxe(page: Page): Promise<unknown[]> {
  try {
    await page.addScriptTag({ url: AXE_CDN });
    const result = await page.evaluate(async () => {
      // @ts-expect-error axe is injected at runtime
      const r = await window.axe.run(document, {
        resultTypes: ['violations'],
      });
      return r.violations;
    });
    return result as unknown[];
  } catch (err) {
    return [{ error: `axe injection failed: ${(err as Error).message}` }];
  }
}

function attachListeners(page: Page) {
  const consoleLog: ConsoleEntry[] = [];
  const networkFailures: NetworkFailure[] = [];

  page.on('console', (msg: ConsoleMessage) => {
    const type = msg.type();
    if (type === 'error' || type === 'warning') {
      const loc = msg.location();
      consoleLog.push({
        type,
        text: msg.text(),
        location: loc.url ? `${loc.url}:${loc.lineNumber}` : undefined,
      });
    }
  });

  page.on('requestfailed', (req: Request) => {
    networkFailures.push({
      url: req.url(),
      method: req.method(),
      failure: req.failure()?.errorText ?? 'unknown',
    });
  });

  page.on('pageerror', (err) => {
    consoleLog.push({ type: 'pageerror', text: err.message });
  });

  return { consoleLog, networkFailures };
}

/**
 * Navigate with retries + access-denied detection.
 *
 * Returns the final `Response` (or `null` if every attempt failed) along with
 * a structured reason so the caller can surface 401/403/timeout distinctly
 * in the per-route report — these are the failure modes most commonly
 * confused for "real" UI bugs when auditing IP-allowlisted preview hosts.
 */
async function navigateWithRetry(
  page: Page,
  url: string,
  navTimeout: number
): Promise<{
  response: Response | null;
  attempts: number;
  errors: string[];
  accessDenied: boolean;
}> {
  const errors: string[] = [];
  let response: Response | null = null;
  let accessDenied = false;

  for (let attempt = 1; attempt <= NAV_RETRIES + 1; attempt++) {
    try {
      response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: navTimeout,
      });

      const status = response?.status() ?? 0;
      if (status === 401 || status === 403 || status === 407) {
        accessDenied = true;
        errors.push(
          `attempt ${attempt}: access denied (HTTP ${status}) — check VPN / IP allowlist / AUDIT_BASIC_AUTH / AUDIT_EXTRA_HEADERS`
        );
      } else if (status === 429) {
        errors.push(
          `attempt ${attempt}: rate-limited (HTTP 429) — increase AUDIT_ROUTE_DELAY_MS`
        );
      } else if (status >= 500) {
        errors.push(`attempt ${attempt}: server error (HTTP ${status})`);
      } else {
        // Success path — break out of the retry loop.
        return { response, attempts: attempt, errors, accessDenied };
      }
    } catch (err) {
      const msg = (err as Error).message;
      errors.push(`attempt ${attempt}: ${msg}`);
      // Common manifestation of an origin that's quietly dropping our
      // connection (typical when our IP is denied at the edge):
      //   net::ERR_ABORTED / ERR_TIMED_OUT / ERR_CONNECTION_RESET
      if (/ERR_(ABORTED|TIMED_OUT|CONNECTION_RESET|FAILED)/i.test(msg)) {
        accessDenied = accessDenied || /ABORTED|CONNECTION_RESET/i.test(msg);
      }
    }

    if (attempt <= NAV_RETRIES) {
      // Linear back-off — preview rate-limit windows are usually short, so
      // there's no point in exponential growth here.
      await page.waitForTimeout(NAV_RETRY_BACKOFF_MS * attempt);
    }
  }

  return { response, attempts: NAV_RETRIES + 1, errors, accessDenied };
}

// ---------------------------------------------------------------------------
// Test suite — one test per route
// ---------------------------------------------------------------------------
test.describe.configure({ mode: 'serial' });

for (const route of ROUTES) {
  test(`audit ${route.label}`, async ({ page }, testInfo) => {
    // Skip routes that still contain placeholder slugs
    if (route.path.includes('<') && route.path.includes('>')) {
      testInfo.skip(
        true,
        `Route ${route.path} contains a placeholder slug. Edit routes.ts.`
      );
      return;
    }

    const device = deviceSlug(testInfo.project.name || 'unknown');
    const deviceScreenDir = path.join(SCREEN_DIR, device);
    const deviceReportDir = path.join(REPORT_DIR, device);
    ensureDir(deviceScreenDir);
    ensureDir(deviceReportDir);

    // Join base + route path without doubling the slash (base may or may not
    // have a trailing slash; route paths start with '/').
    const url =
      BASE_URL.replace(/\/+$/, '') +
      (route.path.startsWith('/') ? route.path : `/${route.path}`);
    const { consoleLog, networkFailures } = attachListeners(page);
    const errors: string[] = [];
    const screenshots: string[] = [];

    try {
      // Set consent cookies BEFORE navigation so the banner never renders.
      await suppressCookieBanners(page, BASE_URL);

      const navResult = await navigateWithRetry(page, url, 60_000);
      errors.push(...navResult.errors);

      if (navResult.accessDenied) {
        // Skip the rest of the audit for this route — selectors / axe will
        // just timeout on an error page, polluting the report with noise.
        errors.push(
          'access denied — skipping selector wait, screenshots only.'
        );
      } else {
        // Belt-and-braces: also dismiss visible banners + CSS-hide stragglers.
        await clickAwayConsent(page);
        await page.waitForSelector(route.waitFor, {
          state: 'visible',
          timeout: 30_000,
        });
        await page
          .waitForLoadState('networkidle', { timeout: 30_000 })
          .catch(() => {
            /* networkidle is best-effort — some pages keep long-poll connections */
          });
        if (route.settleMs) await page.waitForTimeout(route.settleMs);
      }
    } catch (err) {
      errors.push(`navigation/wait failed: ${(err as Error).message}`);
    }

    // Initial screenshot
    const baseShot = path.join(deviceScreenDir, `${route.label}.png`);
    try {
      await page.screenshot({
        path: baseShot,
        fullPage: true,
        animations: 'disabled',
      });
      screenshots.push(path.relative(OUT_ROOT, baseShot));
    } catch (err) {
      errors.push(`screenshot failed: ${(err as Error).message}`);
    }

    // Overflow + a11y sweeps
    const overflow = await collectOverflow(page).catch(() => []);
    const axeViolations = await runAxe(page).catch(() => []);

    // Interactions (extra screenshots)
    for (const inter of route.interactions ?? []) {
      try {
        if (inter.click) {
          const el = page.locator(inter.click).first();
          if ((await el.count()) > 0) {
            await el.click({ timeout: 5_000 });
            if (inter.waitFor)
              await page.waitForSelector(inter.waitFor, { timeout: 10_000 });
            if (inter.pause) await page.waitForTimeout(inter.pause);
            const shot = path.join(
              deviceScreenDir,
              `${route.label}--${inter.name}.png`
            );
            await page.screenshot({
              path: shot,
              fullPage: true,
              animations: 'disabled',
            });
            screenshots.push(path.relative(OUT_ROOT, shot));
          } else {
            errors.push(
              `interaction "${inter.name}" — selector not found: ${inter.click}`
            );
          }
        }
      } catch (err) {
        errors.push(
          `interaction "${inter.name}" failed: ${(err as Error).message}`
        );
      }
    }

    const report: RouteReport = {
      device,
      route: route.label,
      url,
      loadedAt: new Date().toISOString(),
      console: consoleLog,
      networkFailures,
      overflow,
      axeViolations,
      screenshots,
      errors,
    };

    const reportPath = path.join(deviceReportDir, `${route.label}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    // Be a polite neighbour to rate-limited preview hosts: pause between
    // routes within the same project. Skipped after the final route to
    // avoid wasting wall-clock on no-op delay.
    if (ROUTE_DELAY_MS > 0 && route !== ROUTES[ROUTES.length - 1]) {
      await page.waitForTimeout(ROUTE_DELAY_MS);
    }

    // Soft assertion — we never want a discrepancy to abort the whole sweep.
    // The aggregator script enforces the actual pass/fail thresholds.
    expect(errors, `route errors for ${route.label}`).toBeDefined();
  });
}
