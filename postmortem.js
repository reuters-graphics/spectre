#!/usr/bin/env node
/**
 * postmortem.js
 *
 * Reads the per-route JSON reports written by `spectre local`
 * (`<output>/reports/<device>/<route>.json`) and produces an LLM triage prompt
 * that asks a model to:
 *
 *   1. Triage the findings: group by error class, dedupe noise, surface the
 *      handful that matter (e.g. 12 routes all failing the same axe rule).
 *   2. For each clustered issue, suggest a probable cause + a fix anchored
 *      to a file path / selector in the repo if possible.
 *   3. Rank routes worst → best by severity-weighted score.
 *
 * The prompt + raw findings get written to:
 *   <output>/postmortem-prompt.md
 *   <output>/postmortem-data.json
 *
 * And the prompt is copied to the clipboard so you can paste it straight
 * into Claude / Cline / whatever.
 *
 * Usage:
 *   npx spectre postmortem              # triage the last sweep
 *   npx spectre postmortem --top=5      # only include top-5 worst routes
 */

import color from 'picocolors';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Consumer project root + output dir, resolved from env passed by the Spectre
// CLI (falls back to cwd). Never resolve outputs into node_modules.
const PROJECT_ROOT = process.env.SPECTRE_PROJECT_ROOT || process.cwd();
const REPO_ROOT = PROJECT_ROOT; // back-compat alias used below
const LOGS_DIR =
  process.env.SPECTRE_OUTPUT_DIR ||
  process.env.AUDIT_OUTPUT_DIR ||
  path.join(PROJECT_ROOT, '.spectre');
const REPORTS_DIR = path.join(LOGS_DIR, 'reports');

const args = process.argv.slice(2);
const TOP = parseInt(
  args.find((a) => a.startsWith('--top='))?.split('=')[1] || '0',
  10
);
// `--silent` is set when postmortem runs as a side-effect of `spectre report`
// / `spectre show-report` / `spectre local`. It suppresses the
// ASCII summary + clipboard copy + the trailing "paste this into an LLM" note,
// since the data has already been written to disk and report.js will surface
// it inside the HTML viewer.
const SILENT = args.includes('--silent');

// ---------------------------------------------------------------------------
// Load reports
// ---------------------------------------------------------------------------
function loadReports() {
  if (!fs.existsSync(REPORTS_DIR)) {
    console.error(
      color.red('No reports found at ') +
        color.cyan(path.relative(REPO_ROOT, REPORTS_DIR)) +
        '.\nRun `pnpm spectre:local` or `pnpm spectre:run` first.'
    );
    process.exit(1);
  }
  const devices = fs
    .readdirSync(REPORTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const all = [];
  for (const device of devices) {
    const files = fs
      .readdirSync(path.join(REPORTS_DIR, device))
      .filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const r = JSON.parse(
        fs.readFileSync(path.join(REPORTS_DIR, device, file), 'utf8')
      );
      all.push({ device, ...r });
    }
  }
  return all;
}

// ---------------------------------------------------------------------------
// Triage — cluster findings into actionable buckets
// ---------------------------------------------------------------------------

/** Severity score per finding type — higher = worse. */
const W = {
  runError: 5,
  pageerror: 4,
  consoleError: 3,
  networkFailure: 3,
  axeCritical: 4,
  axeSerious: 3,
  axeModerate: 1,
  consoleWarning: 0.5,
  overflow: 0.5,
};

function scoreRoute(r) {
  let s = 0;
  s += (r.errors?.length || 0) * W.runError;
  for (const c of r.console || []) {
    if (c.type === 'pageerror') s += W.pageerror;
    else if (c.type === 'error') s += W.consoleError;
    else if (c.type === 'warning') s += W.consoleWarning;
  }
  s += (r.networkFailures?.length || 0) * W.networkFailure;
  for (const v of r.axeViolations || []) {
    if (v.impact === 'critical') s += W.axeCritical;
    else if (v.impact === 'serious') s += W.axeSerious;
    else if (v.impact === 'moderate') s += W.axeModerate;
  }
  s += (r.overflow?.length || 0) * W.overflow;
  return Math.round(s * 10) / 10;
}

/**
 * Cluster identical findings across devices/routes so the prompt
 * highlights "this one error happens on 14 pages" rather than 14 separate
 * one-off mentions.
 */
function cluster(all) {
  const byConsoleText = new Map(); // text → { count, examples: [{device,route,location}] }
  const byNetwork = new Map(); // url → { count, examples }
  const byAxe = new Map(); // ruleId → { impact, help, count, routes:Set, devices:Set }

  for (const r of all) {
    for (const c of r.console || []) {
      if (c.type !== 'error' && c.type !== 'pageerror') continue;
      const key = (c.text || '').slice(0, 200);
      if (!byConsoleText.has(key)) {
        byConsoleText.set(key, { count: 0, type: c.type, examples: [] });
      }
      const e = byConsoleText.get(key);
      e.count++;
      if (e.examples.length < 5) {
        e.examples.push({
          device: r.device,
          route: r.route,
          location: c.location,
        });
      }
    }
    for (const n of r.networkFailures || []) {
      const key = n.url;
      if (!byNetwork.has(key)) {
        byNetwork.set(key, { count: 0, method: n.method, examples: [] });
      }
      const e = byNetwork.get(key);
      e.count++;
      if (e.examples.length < 5) {
        e.examples.push({
          device: r.device,
          route: r.route,
          failure: n.failure,
        });
      }
    }
    for (const v of r.axeViolations || []) {
      if (!v || !v.id) continue;
      if (!byAxe.has(v.id)) {
        byAxe.set(v.id, {
          impact: v.impact,
          help: v.help,
          count: 0,
          routes: new Set(),
          devices: new Set(),
          sampleNodes: [],
        });
      }
      const e = byAxe.get(v.id);
      e.count += v.nodes?.length || 1;
      e.routes.add(r.route);
      e.devices.add(r.device);
      if (e.sampleNodes.length < 3 && v.nodes?.[0]) {
        e.sampleNodes.push(v.nodes[0]);
      }
    }
  }

  return { byConsoleText, byNetwork, byAxe };
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------
function copyToClipboard(text) {
  const cmds =
    process.platform === 'darwin' ? [['pbcopy', []]]
    : process.platform === 'win32' ? [['clip', []]]
    : [
        ['wl-copy', []],
        ['xclip', ['-selection', 'clipboard']],
        ['xsel', ['--clipboard', '--input']],
      ];
  for (const [cmd, args] of cmds) {
    const r = spawnSync(cmd, args, { input: text, encoding: 'utf8' });
    if (r.status === 0) return cmd;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Render prompt
// ---------------------------------------------------------------------------
function renderPrompt({ all, clusters, ranked }) {
  const { byConsoleText, byNetwork, byAxe } = clusters;
  const topConsole = [...byConsoleText.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 15);
  const topNetwork = [...byNetwork.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10);
  const topAxe = [...byAxe.entries()].sort((a, b) => {
    // critical > serious > moderate; tie-break by count
    const w = { critical: 3, serious: 2, moderate: 1 };
    const dw = (w[b[1].impact] || 0) - (w[a[1].impact] || 0);
    return dw !== 0 ? dw : b[1].count - a[1].count;
  });
  const worstRoutes = ranked.slice(0, TOP || 10);

  return `# Spectre · Post-mortem — auto-generated by \`spectre postmortem\`

Source: **local Playwright emulation**
Routes audited: **${new Set(all.map((r) => r.route)).size}**
Devices: **${new Set(all.map((r) => r.device)).size}**
Total (device × route) reports: **${all.length}**

Your job: read the structured findings below and produce a **prioritised,
deduplicated triage** with concrete fix suggestions. Quality over quantity.

## Findings

### 1. Top JS errors (deduplicated across devices)

${
  topConsole.length === 0 ?
    '_None._'
  : topConsole
      .map(
        ([text, e], i) =>
          `${i + 1}. **${e.type}** × ${e.count} — \`${text.replace(/\n/g, ' ').slice(0, 120)}\`
   - examples: ${e.examples
     .slice(0, 3)
     .map((x) => `${x.device}/${x.route}`)
     .join(
       ', '
     )}${e.examples[0]?.location ? `\n   - at: \`${e.examples[0].location}\`` : ''}`
      )
      .join('\n\n')
}

### 2. Top failing network requests

${
  topNetwork.length === 0 ?
    '_None._'
  : topNetwork
      .map(
        ([url, e], i) =>
          `${i + 1}. \`${e.method} ${url.slice(0, 120)}\` × ${e.count}
   - example failure: ${e.examples[0]?.failure || 'unknown'}`
      )
      .join('\n\n')
}

### 3. Accessibility violations (axe-core, grouped by rule)

${
  topAxe.length === 0 ?
    '_None._'
  : topAxe
      .map(
        ([id, e], i) =>
          `${i + 1}. **${e.impact}** \`${id}\` — ${e.help}
   - affects ${e.routes.size} route(s), ${e.devices.size} device(s), ${e.count} node(s)
   - sample target: ${e.sampleNodes[0]?.target?.join(' ') || '(none)'}
   - sample html: \`${(e.sampleNodes[0]?.html || '').replace(/\n/g, ' ').slice(0, 140)}\``
      )
      .join('\n\n')
}

### 4. Worst routes by severity-weighted score

| Route | Score | Console | Network | Overflow | a11y(sev) | RunErr |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${worstRoutes
  .map(
    (r) =>
      `| \`${r.route}\` (${r.device}) | ${r.score} | ${r.console} | ${r.network} | ${r.overflow} | ${r.a11ySevere} | ${r.runErrors} |`
  )
  .join('\n')}

## What to produce

1. **Top 5 issues** — for each, write:
   - 1-line summary of what's broken
   - Probable cause (anchor to a likely file/component if you can infer it
     from the error / selector / URL)
   - Suggested fix (concrete change, not "investigate further")
   - Pages affected (count + 2-3 examples)

2. **Quick wins** — list any issues that look like one-line fixes (typos,
   wrong key in env, deprecated API, missing alt, etc.).

3. **Investigations needed** — list any issues whose cause isn't obvious
   from the symptoms; suggest what to instrument or log to narrow it down.

4. **Triage verdict** — one of:
   - 🟢 ship it (only cosmetic issues remain)
   - 🟡 ship with caveat (functional but with known bugs X, Y)
   - 🔴 do not ship (P0 bugs A, B block release)

Write the triage as a markdown report. Don't restate the raw data —
synthesise.
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const all = loadReports();
  if (all.length === 0) {
    console.error(
      color.red('No per-route reports found under ') +
        color.cyan(path.relative(REPO_ROOT, REPORTS_DIR))
    );
    process.exit(1);
  }

  // Score every (device,route) pair
  const ranked = all
    .map((r) => ({
      device: r.device,
      route: r.route,
      score: scoreRoute(r),
      console: (r.console || []).filter(
        (c) => c.type === 'error' || c.type === 'pageerror'
      ).length,
      network: (r.networkFailures || []).length,
      overflow: (r.overflow || []).length,
      a11ySevere: (r.axeViolations || []).filter(
        (v) => v.impact === 'critical' || v.impact === 'serious'
      ).length,
      runErrors: (r.errors || []).length,
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  const clusters = cluster(all);

  // Persist the structured data alongside the prompt so other tools can
  // read it later (CI, dashboards, …).
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const dataPath = path.join(LOGS_DIR, 'postmortem-data.json');
  fs.writeFileSync(
    dataPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: 'local',
        ranked,
        topConsole: [...clusters.byConsoleText.entries()]
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 20)
          .map(([text, e]) => ({ text, ...e })),
        topNetwork: [...clusters.byNetwork.entries()]
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 20)
          .map(([url, e]) => ({ url, ...e })),
        topAxe: [...clusters.byAxe.entries()].map(([id, e]) => ({
          id,
          impact: e.impact,
          help: e.help,
          count: e.count,
          routes: [...e.routes],
          devices: [...e.devices],
          sampleNodes: e.sampleNodes,
        })),
      },
      null,
      2
    )
  );

  const prompt = renderPrompt({ all, clusters, ranked });
  const promptPath = path.join(LOGS_DIR, 'postmortem-prompt.md');
  fs.writeFileSync(promptPath, prompt);

  // When invoked as a side-effect of report.js / show-report (--silent),
  // skip the chatty stdout summary + clipboard interaction. report.js will
  // ingest the JSON we wrote and render it inside the HTML viewer.
  if (SILENT) {
    return;
  }

  const clipboard = copyToClipboard(prompt);

  // ASCII summary to stdout
  console.log('');
  console.log(
    color.bold('Spectre post-mortem') +
      color.dim(` (${ranked.length} non-clean reports)`)
  );
  console.log('');
  console.log(color.bold('Top issues:'));
  console.log(
    '  ' +
      color.red('JS errors: ') +
      [...clusters.byConsoleText.values()].reduce((s, e) => s + e.count, 0) +
      color.dim(` across ${clusters.byConsoleText.size} unique messages`)
  );
  console.log(
    '  ' +
      color.red('Network failures: ') +
      [...clusters.byNetwork.values()].reduce((s, e) => s + e.count, 0) +
      color.dim(` across ${clusters.byNetwork.size} unique URLs`)
  );
  console.log(
    '  ' +
      color.yellow('Axe rules tripped: ') +
      clusters.byAxe.size +
      color.dim(
        ` (${[...clusters.byAxe.values()].filter((e) => e.impact === 'critical' || e.impact === 'serious').length} severe)`
      )
  );
  console.log('');
  console.log(color.bold('Worst routes:'));
  for (const r of ranked.slice(0, 5)) {
    console.log(
      '  ' +
        color.cyan(r.route.padEnd(20)) +
        color.dim(' on ' + r.device.padEnd(18)) +
        '  score: ' +
        color.bold(String(r.score))
    );
  }
  console.log('');
  console.log(
    color.green('✓ Wrote ') + color.cyan(path.relative(REPO_ROOT, dataPath))
  );
  console.log(
    color.green('✓ Wrote ') + color.cyan(path.relative(REPO_ROOT, promptPath))
  );
  if (clipboard) {
    console.log(
      color.green('✓ Copied prompt to clipboard ') +
        color.dim(`(via ${clipboard})`)
    );
  } else {
    console.log(
      color.yellow('! Could not copy to clipboard — paste from ') +
        color.cyan(path.relative(REPO_ROOT, promptPath))
    );
  }
  console.log('');
  console.log(
    color.bold('Next: ') +
      'paste the prompt above into Claude (or any LLM) to get a prioritised\n' +
      '      triage with fixes and a ship verdict.'
  );
}

main();
