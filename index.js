#!/usr/bin/env node
/**
 * spectre — CLI entrypoint for the local cross-browser UI-audit harness.
 *
 * Runs a Playwright audit across every route × emulated device declared by the
 * consuming project, aggregates the findings into a browsable HTML report +
 * Markdown summary + CI JSON, and generates an LLM triage prompt.
 *
 * Sub-commands:
 *   local        Run the audit on emulated devices. Auto-cleans + auto-reports.
 *   show-report  Reopen the last report in your browser.
 *   postmortem   (Re)generate the LLM triage prompt for the last sweep.
 *   clean        Wipe the output folder (everything except .gitkeep).
 *   menu         Interactive menu (default when no sub-command).
 *   help         Print help.
 *
 * Usage:
 *   npx spectre                                  (interactive menu)
 *   npx spectre local
 *   AUDIT_BASE_URL=http://localhost:4173 npx spectre local
 *   npx spectre show-report
 *   npx spectre postmortem
 *   npx spectre clean
 */

import * as p from '@clack/prompts';

import color from 'picocolors';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { discoverRoutes } from './discover.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The installed package root. When developing in this repo it's the repo
// itself; when installed it's node_modules/@reuters-graphics/spectre.
// All package-internal assets (spec, config) resolve from here.
const PKG_ROOT = __dirname;

// The CONSUMER's project root — where the project's own package.json lives and
// where audit output should be written. When the CLI is invoked via
// `npx spectre`, this is the current working directory. Override with
// SPECTRE_PROJECT_ROOT for unusual monorepo layouts.
const PROJECT_ROOT = process.env.SPECTRE_PROJECT_ROOT || process.cwd();

// Where all audit artifacts land. Defaults to `.spectre/` inside the consumer
// project (NEVER inside node_modules). Override with SPECTRE_OUTPUT_DIR (or
// AUDIT_OUTPUT_DIR) so CI can redirect it.
const OUTPUT_DIR =
  process.env.SPECTRE_OUTPUT_DIR ||
  process.env.AUDIT_OUTPUT_DIR ||
  path.join(PROJECT_ROOT, '.spectre');

const LOGS_DIR = OUTPUT_DIR;
const CONFIG_LOCAL = path.join(PKG_ROOT, 'playwright.local.config.ts');
const REPORT_SCRIPT = path.join(PKG_ROOT, 'report.js');
const POSTMORTEM_SCRIPT = path.join(PKG_ROOT, 'postmortem.js');
const ROUTES_EXAMPLE = path.join(PKG_ROOT, 'routes.example.ts');

// ---------------------------------------------------------------------------
// Consumer-provided routes resolution.
//
// The route list is project-specific, so the package does NOT ship one — the
// consumer supplies it. We look (in order) for:
//   1. $SPECTRE_ROUTES                       (explicit path, absolute or rel)
//   2. spectre.routes.{ts,js,mjs} in project root
//   3. spectre.config.{ts,js} in project root
//   4. package.json → "spectre": { "routes": "<path>" }
// Returns an absolute path or null.
// ---------------------------------------------------------------------------
function resolveRoutesPath() {
  if (process.env.SPECTRE_ROUTES) {
    return path.resolve(PROJECT_ROOT, process.env.SPECTRE_ROUTES);
  }
  const candidates = [
    'spectre.routes.ts',
    'spectre.routes.js',
    'spectre.routes.mjs',
    'spectre.config.ts',
    'spectre.config.js',
  ];
  for (const c of candidates) {
    const full = path.join(PROJECT_ROOT, c);
    if (fs.existsSync(full)) return full;
  }
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')
    );
    if (pkg.spectre && pkg.spectre.routes) {
      return path.resolve(PROJECT_ROOT, pkg.spectre.routes);
    }
  } catch {
    /* no package.json / not JSON — ignore */
  }
  return null;
}

/** Resolve the routes file or exit with a helpful, copy-paste-able message. */
function ensureRoutesOrExit() {
  const routes = resolveRoutesPath();
  if (!routes) {
    console.error(
      color.red('❌ No Spectre routes file found in ') + color.cyan(PROJECT_ROOT)
    );
    console.error(
      color.yellow(
        'Spectre needs the routes for YOUR project. Provide one of:\n' +
          '  • spectre.routes.ts (or .js) in your project root\n' +
          '  • spectre.config.ts (or .js) in your project root\n' +
          '  • "spectre": { "routes": "./path/to/routes.ts" } in package.json\n' +
          '  • SPECTRE_ROUTES=./path/to/routes.ts env var\n\n'
      ) +
        color.dim(
          'Copy the starter to get going:\n' +
            `  cp ${ROUTES_EXAMPLE} ./spectre.routes.ts\n`
        )
    );
    process.exit(1);
  }
  return routes;
}

/**
 * Load spectre.config.json from the project root (if present). This is written
 * by `spectre setup` and holds the discovery mode, base URL, excludes, etc.
 * Returns {} when there's no config.
 */
const CONFIG_JSON = path.join(PROJECT_ROOT, 'spectre.config.json');
function loadConfig() {
  if (!fs.existsSync(CONFIG_JSON)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_JSON, 'utf8')) || {};
  } catch (err) {
    p.log.warn(
      `Could not parse spectre.config.json: ${(err && err.message) || err}`
    );
    return {};
  }
}

/**
 * Environment handed to every child process (Playwright, report.js,
 * postmortem.js) so they all resolve the same project root, output dir and
 * routes file regardless of their own __dirname.
 */
function childEnv(extra = {}) {
  const routes = resolveRoutesPath();
  return {
    ...process.env,
    SPECTRE_PROJECT_ROOT: PROJECT_ROOT,
    SPECTRE_OUTPUT_DIR: OUTPUT_DIR,
    ...(routes ? { SPECTRE_ROUTES: routes } : {}),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------
function cancelIf(value) {
  if (p.isCancel(value)) {
    p.cancel('Cancelled.');
    process.exit(0);
  }
  return value;
}

function ensureLogs() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const keep = path.join(LOGS_DIR, '.gitkeep');
  if (!fs.existsSync(keep)) fs.writeFileSync(keep, '');
}

/** Is a package resolvable from the consumer project? */
function hasDep(name) {
  if (
    fs.existsSync(path.join(PROJECT_ROOT, 'node_modules', name, 'package.json'))
  ) {
    return true;
  }
  try {
    createRequire(path.join(PROJECT_ROOT, 'package.json')).resolve(
      `${name}/package.json`
    );
    return true;
  } catch {
    return false;
  }
}

function runCommand(cmd, args, { cwd = PROJECT_ROOT, env = childEnv() } = {}) {
  const printable = `${cmd} ${args.join(' ')}`;
  p.log.info(color.dim(`▶ ${printable}`));
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd, env });
  return r.status ?? 1;
}

// ---------------------------------------------------------------------------
// Auto-housekeeping. Every audit run starts from a clean slate and ends with
// an aggregated report — the user never has to think about either.
// ---------------------------------------------------------------------------

/** Wipe output before a fresh run so stale screenshots can't muddy the diff. */
function autoClean() {
  if (!fs.existsSync(LOGS_DIR)) return;
  for (const entry of fs.readdirSync(LOGS_DIR)) {
    if (entry === '.gitkeep') continue;
    fs.rmSync(path.join(LOGS_DIR, entry), { recursive: true, force: true });
  }
  p.log.info(color.dim('🧹 Cleared previous output'));
}

/** Run the JSON → report aggregator after a sweep finishes. Never throws. */
function autoReport() {
  const r = spawnSync('node', [REPORT_SCRIPT], {
    stdio: 'inherit',
    cwd: PROJECT_ROOT,
    env: childEnv(),
  });
  if (r.status === 0) {
    p.log.success(
      color.green('📋 Report written to ') +
        color.cyan(
          path.join(path.relative(PROJECT_ROOT, LOGS_DIR) || '.spectre', 'report.md')
        )
    );
  }
}

// ---------------------------------------------------------------------------
// `local` — run the audit against Playwright's bundled device-descriptor
// matrix (emulated iPhone/iPad/Pixel/Galaxy + desktop Chromium/WebKit/Firefox).
// ---------------------------------------------------------------------------
async function runLocalAudit(rest) {
  if (!hasDep('@playwright/test')) {
    p.log.error(
      'Local mode needs Playwright. Install it in your project:\n' +
        '  ' +
        color.cyan('pnpm add -D @playwright/test') +
        '\n  ' +
        color.cyan('npx playwright install') +
        '   (one-time browser download)\n' +
        'then re-run ' +
        color.cyan('npx spectre local') +
        '.'
    );
    process.exit(1);
  }

  // ------------------------------------------------------------------
  // Decide where routes come from: an explicit routes file, or discovery.
  // ------------------------------------------------------------------
  const config = loadConfig();
  const manualRoutes = resolveRoutesPath();
  const baseUrl = process.env.AUDIT_BASE_URL || config.baseUrl || '';
  const wantDiscover =
    (config.discover && config.discover !== 'manual') ||
    (!manualRoutes && !!baseUrl);

  if (!wantDiscover && !manualRoutes) {
    // Nothing to run — guide the user to `setup` or a routes file.
    p.log.error(
      color.red('❌ Spectre has no routes to audit.') +
        '\n\n' +
        color.yellow('Easiest: let Spectre discover them from your site:\n') +
        '  ' +
        color.cyan('npx spectre setup') +
        '   then ' +
        color.cyan('npx spectre local') +
        '\n\n' +
        color.dim(
          'Or set a base URL for this run:\n' +
            '  AUDIT_BASE_URL=http://localhost:4173 npx spectre local\n' +
            'Or provide an explicit routes file (see routes.example.ts).'
        )
    );
    process.exit(1);
  }

  autoClean();
  ensureLogs();

  // Playwright (and Node's native TS support) refuse to transform `.ts` files
  // that live inside node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING).
  // So we copy the spec + config OUT of the package into the consumer's output
  // dir — which is in their project, not node_modules — where Playwright's own
  // transformer handles the TypeScript (and the consumer's .ts routes import).
  const runnerDir = path.join(OUTPUT_DIR, '.runner');
  fs.mkdirSync(runnerDir, { recursive: true });
  const runnerConfig = path.join(runnerDir, 'playwright.local.config.ts');
  fs.copyFileSync(
    path.join(PKG_ROOT, 'audit.spec.ts'),
    path.join(runnerDir, 'audit.spec.ts')
  );
  fs.copyFileSync(CONFIG_LOCAL, runnerConfig);

  // Resolve the routes module the spec will import.
  let routesFile = manualRoutes;
  const extraEnv = {};

  if (wantDiscover) {
    if (!baseUrl) {
      p.log.error(
        'Route discovery needs a base URL. Set ' +
          color.cyan('AUDIT_BASE_URL') +
          ' or add ' +
          color.cyan('"baseUrl"') +
          ' to spectre.config.json (run ' +
          color.cyan('npx spectre setup') +
          ').'
      );
      process.exit(1);
    }
    const s = p.spinner();
    s.start(`Discovering routes from ${baseUrl}`);
    let result;
    try {
      result = await discoverRoutes({
        baseUrl,
        mode: config.discover || 'crawl',
        crawlDepth: config.crawlDepth ?? 2,
        maxPages: config.maxPages ?? 100,
        exclude: config.exclude ?? ['/embeds/**', '/sharecards/**'],
        include: config.include ?? [],
        waitFor: config.waitFor ?? 'body',
        overrides: config.overrides ?? {},
        extraRoutes: config.extraRoutes ?? [],
      });
    } catch (err) {
      s.stop(color.red('Discovery failed'));
      p.log.error((err && err.message) || String(err));
      process.exit(1);
    }
    if (!result.routes.length) {
      s.stop(color.red('No routes discovered'));
      p.log.error(
        `Discovery via ${result.mode} found no auditable pages at ${baseUrl}. ` +
          'Check the URL is reachable, or add routes to spectre.config.json.'
      );
      process.exit(1);
    }
    s.stop(
      color.green(
        `Discovered ${result.routes.length} route(s) via ${result.mode}`
      )
    );
    routesFile = path.join(runnerDir, 'routes.generated.mjs');
    fs.writeFileSync(
      routesFile,
      `// Auto-generated by spectre from ${baseUrl} (${result.mode}). Do not edit.\n` +
        `export const ROUTES = ${JSON.stringify(result.routes, null, 2)};\n`
    );
    // Make sure the spec audits against the same origin we discovered.
    extraEnv.AUDIT_BASE_URL = baseUrl;
  }

  p.log.info(
    color.dim('Running audit — Playwright emulated devices, no account needed.')
  );

  const code = runCommand(
    'npx',
    ['playwright', 'test', `--config=${runnerConfig}`, ...rest],
    { cwd: PROJECT_ROOT, env: childEnv({ SPECTRE_ROUTES: routesFile, ...extraEnv }) }
  );

  // First-time Playwright users need browsers installed. Hint at the fix
  // instead of leaving them staring at a stack trace.
  if (code !== 0) {
    p.log.warn(
      color.yellow(
        'If you saw "browserType.launch: Executable doesn\'t exist", run:\n' +
          '  npx playwright install\n' +
          '…then re-run `npx spectre local`.'
      )
    );
  }
  autoReport();
  process.exit(code);
}

// ---------------------------------------------------------------------------
// `postmortem` — triage an existing sweep into an LLM prompt + structured JSON.
// Does NOT re-run anything; it reads the per-route reports already on disk.
// ---------------------------------------------------------------------------
function runPostmortem(rest) {
  const reportsDir = path.join(LOGS_DIR, 'reports');
  if (
    !fs.existsSync(reportsDir) ||
    !fs
      .readdirSync(reportsDir, { withFileTypes: true })
      .some((d) => d.isDirectory())
  ) {
    p.log.error(
      'No audit reports found. Run ' +
        color.cyan('npx spectre local') +
        ' first.'
    );
    process.exit(1);
  }
  const code = runCommand('node', [POSTMORTEM_SCRIPT, ...rest], {
    cwd: PROJECT_ROOT,
  });
  process.exit(code);
}

// ---------------------------------------------------------------------------
// `show-report` — re-serve the last generated report without re-running the
// audit. Mirrors `npx playwright show-report`.
// ---------------------------------------------------------------------------
function runShowReport(rest) {
  const reportsDir = path.join(LOGS_DIR, 'reports');
  const hasReports =
    fs.existsSync(reportsDir) &&
    fs
      .readdirSync(reportsDir, { withFileTypes: true })
      .some((d) => d.isDirectory());

  if (!hasReports) {
    p.log.error(
      'No audit reports found under ' +
        color.cyan(
          path.relative(PROJECT_ROOT, reportsDir) || '.spectre/reports'
        ) +
        '.\n   Run ' +
        color.cyan('npx spectre local') +
        ' first to generate them.'
    );
    process.exit(1);
  }

  // report.js (re)writes the HTML from the existing JSON, then serves it.
  const code = runCommand('node', [REPORT_SCRIPT, ...rest], {
    cwd: PROJECT_ROOT,
  });
  process.exit(code);
}

// ---------------------------------------------------------------------------
// `clean` — wipe output keeping .gitkeep
// ---------------------------------------------------------------------------
function runClean() {
  if (!fs.existsSync(LOGS_DIR)) return;
  for (const entry of fs.readdirSync(LOGS_DIR)) {
    if (entry === '.gitkeep') continue;
    fs.rmSync(path.join(LOGS_DIR, entry), { recursive: true, force: true });
  }
  p.log.success(
    color.green('🧹 Cleared ') +
      color.cyan(path.relative(PROJECT_ROOT, LOGS_DIR) || '.spectre')
  );
}

// ---------------------------------------------------------------------------
// Default action for bare `spectre` — just run the audit. Since local is the
// only mode, there's no reason to make the user type `spectre local`. If the
// project isn't configured yet (no config, no routes file, no base URL), fall
// into the setup wizard so the first run is guided.
// ---------------------------------------------------------------------------
async function runDefault() {
  const configured =
    fs.existsSync(CONFIG_JSON) ||
    !!resolveRoutesPath() ||
    !!process.env.AUDIT_BASE_URL;
  if (configured) return runLocalAudit([]);

  p.intro(color.bgCyan(color.black(' spectre ')));
  p.log.info("No Spectre config found yet — let's set it up.");
  p.outro('');
  return runSetup();
}

// ---------------------------------------------------------------------------
// Interactive menu
// ---------------------------------------------------------------------------
async function runMenu() {
  p.intro(color.bgCyan(color.black(' spectre ')));

  const choice = cancelIf(
    await p.select({
      message: 'What would you like to do?',
      options: [
        {
          value: 'setup',
          label: '🛠  Setup',
          hint: 'pick a base URL, save spectre.config.json',
        },
        {
          value: 'local',
          label: '💻 Run audit (emulated devices)',
          hint: 'Playwright device descriptors — free, no account',
        },
        {
          value: 'show-report',
          label: '👀 Show last report',
          hint: 'open the last report in your browser',
        },
        {
          value: 'postmortem',
          label: '🧠 Generate LLM post-mortem prompt',
          hint: 'triage the last sweep into an LLM prompt',
        },
        {
          value: 'clean',
          label: '🧹 Clean output',
          hint: 'wipe the .spectre/ output folder',
        },
      ],
    })
  );

  switch (choice) {
    case 'setup':
      p.outro('');
      return runSetup();
    case 'local':
      p.outro('');
      return runLocalAudit([]);
    case 'show-report':
      p.outro('');
      return runShowReport([]);
    case 'postmortem':
      p.outro('');
      return runPostmortem([]);
    case 'clean':
      p.outro('');
      return runClean();
  }
}

// ---------------------------------------------------------------------------
// `setup` — interactive wizard that writes spectre.config.json
// ---------------------------------------------------------------------------
async function runSetup() {
  p.intro(color.bgCyan(color.black(' spectre · setup ')));
  const existing = loadConfig();

  const baseUrl = cancelIf(
    await p.text({
      message: 'Base URL to audit (dev server, preview, or live page)',
      placeholder: existing.baseUrl || 'http://localhost:4173',
      defaultValue: existing.baseUrl || 'http://localhost:4173',
      validate: (v) =>
        /^https?:\/\//.test(String(v)) ?
          undefined
        : 'Must start with http:// or https://',
    })
  );

  const skipNonPublic = cancelIf(
    await p.confirm({
      message: 'Skip embeds & sharecards (non-public pages)?',
      initialValue: true,
    })
  );

  // Discovery defaults to crawling the homepage — only publicly-linked pages
  // get audited. Power users can hand-edit `discover` in spectre.config.json
  // to "auto" (sitemap first), "sitemap", or "manual"; the wizard keeps
  // whatever's already set rather than asking everyone to choose.
  const discover = existing.discover || 'crawl';
  const exclude =
    existing.exclude ??
    (skipNonPublic ? ['/embeds/**', '/sharecards/**'] : []);

  const config = {
    baseUrl,
    discover,
    crawlDepth: existing.crawlDepth ?? 2,
    exclude: skipNonPublic ? exclude : [],
    waitFor: existing.waitFor ?? 'body',
    extraRoutes: existing.extraRoutes ?? [],
    overrides: existing.overrides ?? {},
  };

  fs.writeFileSync(CONFIG_JSON, JSON.stringify(config, null, 2) + '\n');
  p.log.success(
    color.green('✓ Wrote ') +
      color.cyan(path.relative(PROJECT_ROOT, CONFIG_JSON) || 'spectre.config.json')
  );
  p.note(
    [
      discover === 'manual' ?
        `Provide a routes file (see ${color.dim('routes.example.ts')}).`
      : `Spectre will crawl ${color.cyan(baseUrl)} from the homepage and audit\n` +
        `every publicly-linked page.`,
      '',
      `Next: ${color.cyan('npx spectre')}`,
    ].join('\n'),
    'Setup complete'
  );
  p.outro(color.green('Done.'));
}

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------
function help() {
  console.log(`
${color.bold('👻 spectre')} — local cross-browser UI audit harness

${color.bold('Commands:')}
  ${color.cyan('setup')}       Interactive wizard — set a base URL + how routes are
              discovered (sitemap/crawl), saved to spectre.config.json.
  ${color.cyan('(none)')}      Running ${color.dim('spectre')} with no command runs the audit
              (or setup on first run). Auto-cleans + reports + post-mortem.
  ${color.cyan('local')}       Alias of the default — run the audit.
              Auto-cleans + auto-reports + runs the post-mortem.
  ${color.cyan('show-report')} Open the last report in your browser via the built-in
              static server (like ${color.dim('playwright show-report')}).
  ${color.cyan('postmortem')}  Triage the last sweep into an LLM prompt + structured
              JSON. Also runs automatically after each audit.
  ${color.cyan('clean')}       Wipe the output folder.
  ${color.cyan('menu')}        Interactive menu.
  ${color.cyan('help')}        Show this message.

${color.bold('Routes:')} Spectre discovers your routes automatically — run
  ${color.cyan('spectre setup')} to pick a base URL and discovery mode (sitemap
  if present, else a homepage crawl). You can still provide an explicit routes
  file (see ${color.dim('routes.example.ts')}) or set ${color.dim('SPECTRE_ROUTES')}.

${color.bold('Examples:')}
  npx spectre                                  # run the audit (setup on first run)
  npx spectre setup                            # configure discovery
  npx spectre menu                             # interactive menu
  AUDIT_BASE_URL=http://localhost:4173 npx spectre
  npx spectre show-report                       # re-open last report
  npx spectre postmortem                        # standalone triage
`);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
const [, , subcommand, ...rest] = process.argv;

(async () => {
  try {
    switch (subcommand) {
      case undefined:
        await runDefault();
        break;
      case 'menu':
        await runMenu();
        break;
      case 'local':
      case 'run':
        await runLocalAudit(rest);
        break;
      case 'setup':
        await runSetup();
        break;
      case 'show-report':
      case 'show':
        runShowReport(rest);
        break;
      case 'postmortem':
      case 'triage':
        runPostmortem(rest);
        break;
      // Hidden alias used by the auto-flow + CI hooks.
      case 'report':
        ensureLogs();
        process.exit(
          spawnSync('node', [REPORT_SCRIPT, ...rest], {
            stdio: 'inherit',
            cwd: PROJECT_ROOT,
            env: childEnv(),
          }).status ?? 1
        );
        break;
      case 'clean':
        runClean();
        break;
      case 'help':
      case '--help':
      case '-h':
        help();
        break;
      default:
        help();
        process.exit(1);
    }
  } catch (err) {
    console.error(color.red('spectre:'), err.message || err);
    process.exit(1);
  }
})();
