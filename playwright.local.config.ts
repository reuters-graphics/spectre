/**
 * Playwright config for the LOCAL audit mode.
 *
 * No BrowserStack involved — uses Playwright's bundled device-descriptor
 * matrix to emulate iPhone/iPad/Pixel/Galaxy viewports + UA strings, plus
 * desktop Chromium/WebKit/Firefox at 1280×800.
 *
 * What you give up vs. BrowserStack: real Safari/Chrome on real iOS/Android
 * silicon. What you gain: zero cost, no account needed, full audit coverage
 * (console errors, network failures, horizontal overflow, axe-core a11y).
 *
 * Used by `node bin/spectre local`.
 */

import { defineConfig, devices } from '@playwright/test';

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Output dir lives in the CONSUMER project, not inside the package. Resolved
// from env passed by the Spectre CLI; falls back to `<cwd>/.spectre`.
const LOGS_DIR =
  process.env.SPECTRE_OUTPUT_DIR ||
  process.env.AUDIT_OUTPUT_DIR ||
  path.resolve(process.env.SPECTRE_PROJECT_ROOT || process.cwd(), '.spectre');

// ---------------------------------------------------------------------------
// Throttle / network-shaping knobs (all env-overridable so CI can tune them
// without editing code). Defaults are intentionally conservative because the
// preview hosts the audit usually points at (graphics.thomsonreuters.com,
// AWS-hosted previews, etc.) are IP-allowlisted and rate-limit aggressively
// — hitting them with 2+ parallel workers triggers blanket 403s that look
// like real bugs in the report.
// ---------------------------------------------------------------------------
const WORKERS = Number(process.env.AUDIT_WORKERS ?? 1);
const RETRIES = Number(process.env.AUDIT_RETRIES ?? 1);
const NAV_TIMEOUT = Number(process.env.AUDIT_NAV_TIMEOUT_MS ?? 90_000);
const TEST_TIMEOUT = Number(process.env.AUDIT_TEST_TIMEOUT_MS ?? 180_000);

// Headers / auth — used by audit.spec.ts to pretend the audit is coming from
// inside the corporate network (X-Forwarded-For), to override the UA, or to
// pass HTTP Basic credentials for a password-protected preview. Each is
// optional; left empty everything behaves as before.
let extraHTTPHeaders: Record<string, string> | undefined;
if (process.env.AUDIT_EXTRA_HEADERS) {
  try {
    extraHTTPHeaders = JSON.parse(process.env.AUDIT_EXTRA_HEADERS);
  } catch {
    console.warn('[spectre] AUDIT_EXTRA_HEADERS is not valid JSON — ignoring.');
  }
}
const httpCredentials =
  process.env.AUDIT_BASIC_AUTH ?
    (() => {
      const [username, ...rest] = process.env.AUDIT_BASIC_AUTH.split(':');
      return { username, password: rest.join(':') };
    })()
  : undefined;
const userAgent = process.env.AUDIT_USER_AGENT || undefined;

export default defineConfig({
  testDir: __dirname,
  testMatch: /audit\.spec\.ts$/,
  timeout: TEST_TIMEOUT,
  expect: { timeout: 15_000 },
  retries: RETRIES,
  workers: WORKERS,

  reporter: [
    ['list'],
    [
      'html',
      { open: 'never', outputFolder: path.join(LOGS_DIR, 'playwright-report') },
    ],
  ],
  outputDir: path.join(LOGS_DIR, 'playwright-output'),

  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: NAV_TIMEOUT,
    ...(extraHTTPHeaders ? { extraHTTPHeaders } : {}),
    ...(httpCredentials ? { httpCredentials } : {}),
    ...(userAgent ? { userAgent } : {}),
  },

  // Each project = one "device" the audit runs against. Names are
  // slugified by audit.spec.ts (project.name → `deviceSlug()`) so the
  // screenshots land in `logs/screenshots/<device>/`.
  projects: [
    {
      name: 'iphone-15',
      use: { ...devices['iPhone 15'] },
    },
    {
      name: 'iphone-se',
      use: { ...devices['iPhone SE'] },
    },
    {
      name: 'pixel-7',
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'galaxy-s9',
      use: { ...devices['Galaxy S9+'] },
    },
    {
      name: 'ipad-mini',
      use: { ...devices['iPad Mini'] },
    },
    {
      name: 'desktop-chrome',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'desktop-safari',
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'desktop-firefox',
      use: { ...devices['Desktop Firefox'] },
    },
  ],
});
