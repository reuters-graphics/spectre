#!/usr/bin/env node
/**
 * Aggregates per-route JSON reports produced by the audit spec
 * (see audit.spec.ts) into a single Markdown report and a
 * machine-readable JSON summary.
 *
 * Output is organised ROUTE-FIRST so you can manually triage one page at a
 * time across every device:
 *
 *   1. Base URL banner (so the report is self-describing if shared).
 *   2. Top-level summary table (one row per device — quick numerical glance).
 *   3. Per-route section, each containing:
 *        - The full URL
 *        - A 4-column screenshot gallery, one cell per device + interaction
 *        - Console / network / overflow / a11y findings, grouped by device
 *
 * Inputs:   <output>/reports/<device>/<route>.json
 * Outputs:
 *   - <output>/report.md       (human-readable triage doc)
 *   - <output>/report.json     (CI-friendly summary)
 *   - <output>/audit.log       (timestamped run log)
 */

import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Optional. We use sharp (already a devDep) to compute perceptual diffs
// between screenshots of the same route across same-form-factor devices.
// If sharp can't be loaded we gracefully degrade — the report just won't
// show the diff badges.
let sharp = null;
try {
  ({ default: sharp } = await import('sharp'));
} catch {
  /* sharp not installed — diff badges disabled */
}

// Outputs land in the consumer project's output dir (default `.spectre/`),
// resolved from env passed by the Spectre CLI so the report never lands inside
// node_modules. Falls back to `<cwd>/.spectre` when run directly.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT =
  process.env.SPECTRE_OUTPUT_DIR ||
  process.env.AUDIT_OUTPUT_DIR ||
  path.resolve(process.env.SPECTRE_PROJECT_ROOT || process.cwd(), '.spectre');
const REPORTS_DIR = path.join(ROOT, 'reports');
const OUT_MD = path.join(ROOT, 'report.md');
const OUT_HTML = path.join(ROOT, 'index.html');
const OUT_JSON = path.join(ROOT, 'report.json');
const OUT_LOG = path.join(ROOT, 'audit.log');

// CLI flags. `--serve` (default true unless --no-serve) launches a small
// static server like `playwright show-report`. `--port=NNNN` pins the port.
const args = process.argv.slice(2);
const NO_SERVE = args.includes('--no-serve');
const PORT = (() => {
  const f = args.find((a) => a.startsWith('--port='));
  return f ? parseInt(f.slice('--port='.length), 10) : 0; // 0 = OS picks
})();

const A11Y_IMPACT_SEVERE = new Set(['critical', 'serious']);

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------
function read(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function listDevices() {
  if (!fs.existsSync(REPORTS_DIR)) return [];
  return fs
    .readdirSync(REPORTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

function listReports(device) {
  const dir = path.join(REPORTS_DIR, device);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ file: f, ...read(path.join(dir, f)) }));
}

function severeAxe(violations) {
  if (!Array.isArray(violations)) return [];
  return violations.filter((v) => v && A11Y_IMPACT_SEVERE.has(v.impact));
}

// Sort screenshots so the "base" page screenshot (no `--interaction` suffix)
// comes first, then interactions in declaration order.
function sortShots(shots) {
  return [...shots].sort((a, b) => {
    const aHasI = a.includes('--');
    const bHasI = b.includes('--');
    if (aHasI !== bHasI) return aHasI ? 1 : -1;
    return a.localeCompare(b);
  });
}

// ---------------------------------------------------------------------------
// Visual diff — group devices by form factor, pick the first as baseline,
// compute a mean-squared-error similarity score for every other device.
// Sharp downsamples both PNGs to the same 64×64 grayscale buffer so the
// comparison is fast and not perturbed by tiny anti-aliasing differences.
// ---------------------------------------------------------------------------

/**
 * Classify a device slug into a form factor so screenshots are compared
 * against same-form-factor baselines only (a desktop and a phone obviously
 * look different and shouldn't be diffed).
 */
function formFactor(deviceSlug) {
  const s = deviceSlug.toLowerCase();
  if (s.includes('desktop')) return 'desktop';
  if (s.includes('ipad') || s.includes('tablet')) return 'tablet';
  if (
    s.includes('iphone') ||
    s.includes('pixel') ||
    s.includes('galaxy') ||
    s.includes('android') ||
    s.includes('ios')
  ) {
    return 'mobile';
  }
  return 'other';
}

/**
 * Returns a normalized 64×64 grayscale buffer (4096 bytes) for the
 * given screenshot, or null if we couldn't decode it. We trim to a
 * fixed top crop so length differences between very-tall pages don't
 * dominate the diff signal.
 */
async function fingerprint(absPath) {
  if (!sharp || !fs.existsSync(absPath)) return null;
  try {
    return await sharp(absPath)
      .resize(64, 64, { fit: 'cover', position: 'top' })
      .greyscale()
      .raw()
      .toBuffer();
  } catch {
    return null;
  }
}

/**
 * Mean-squared-error between two 64×64 grayscale buffers, normalized to
 * a 0–100 percentage (0 = identical, 100 = maximally different).
 */
function mse(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  const max = 255 * 255;
  return Math.round((sum / a.length / max) * 100 * 10) / 10; // 1 decimal
}

/**
 * Walk every route × device × screenshot, compute the diff % vs the
 * same-form-factor baseline, and mutate the in-memory report so the
 * renderer can decorate each thumbnail with a badge.
 *
 * The baseline is the FIRST device (alphabetically) within each form
 * factor — typically the most "canonical" engine (e.g. desktop-chrome
 * sorts before desktop-firefox/safari). For the baseline itself we
 * record diff = 0.
 */
async function computeVisualDiffs(byRoute, devices) {
  if (!sharp) return;

  // Group devices by form factor, keep alphabetical order so the baseline
  // is deterministic across runs.
  const groups = {};
  for (const d of devices) {
    const ff = formFactor(d);
    (groups[ff] = groups[ff] || []).push(d);
  }

  for (const [, group] of Object.entries(groups)) {
    if (group.length < 2) continue; // nothing to compare
    const [baseline, ...rest] = group;

    for (const route of byRoute.keys()) {
      const slot = byRoute.get(route);
      const baseShots = (slot.devices[baseline]?.screenshots || []).map(
        (s) => ({ name: path.basename(s), abs: path.join(ROOT, s) })
      );
      if (!baseShots.length) continue;

      // Cache baseline fingerprints by screenshot basename
      const baseFps = new Map();
      for (const s of baseShots) baseFps.set(s.name, await fingerprint(s.abs));

      // Annotate baseline itself with 0% diff
      if (!slot.devices[baseline]._diffs) slot.devices[baseline]._diffs = {};
      for (const s of baseShots) slot.devices[baseline]._diffs[s.name] = 0;

      for (const device of rest) {
        const r = slot.devices[device];
        if (!r) continue;
        r._diffs = r._diffs || {};
        for (const shot of r.screenshots || []) {
          const name = path.basename(shot);
          const base = baseFps.get(name);
          if (!base) continue;
          const fp = await fingerprint(path.join(ROOT, shot));
          const diff = mse(base, fp);
          if (diff !== null) r._diffs[name] = diff;
        }
      }

      // Remember the baseline slug on the route so the renderer can flag it.
      slot._baselineByFactor = slot._baselineByFactor || {};
      slot._baselineByFactor[formFactor(baseline)] = baseline;
    }
  }
}

// ---------------------------------------------------------------------------
// Build report
// ---------------------------------------------------------------------------
const devices = listDevices();
if (devices.length === 0) {
  console.warn(
    `[report] Nothing to aggregate yet — no JSON files under ${REPORTS_DIR}.`
  );
  process.exit(0);
}

const summary = {
  generatedAt: new Date().toISOString(),
  baseUrl: '',
  devices: devices.length,
  totals: {
    routes: 0,
    consoleErrors: 0,
    networkFailures: 0,
    overflowOffenders: 0,
    axeSevere: 0,
    runErrors: 0,
  },
  byDevice: {},
};

// Cross-index everything by route. Each route entry gathers per-device data
// + a stable URL (taken from whichever device reported the route first).
const byRoute = new Map(); // route → { url, devices: { [device]: report } }

for (const device of devices) {
  const reports = listReports(device);
  const dSummary = {
    routes: reports.length,
    consoleErrors: 0,
    networkFailures: 0,
    overflowOffenders: 0,
    axeSevere: 0,
    runErrors: 0,
  };

  for (const r of reports) {
    const consoleErrors = (r.console || []).filter(
      (c) => c.type === 'error' || c.type === 'pageerror'
    );
    const severeViolations = severeAxe(r.axeViolations);

    dSummary.consoleErrors += consoleErrors.length;
    dSummary.networkFailures += (r.networkFailures || []).length;
    dSummary.overflowOffenders += (r.overflow || []).length;
    dSummary.axeSevere += severeViolations.length;
    dSummary.runErrors += (r.errors || []).length;

    if (!byRoute.has(r.route)) {
      byRoute.set(r.route, { url: r.url, devices: {} });
    }
    const slot = byRoute.get(r.route);
    if (!slot.url) slot.url = r.url;
    slot.devices[device] = {
      ...r,
      _consoleErrors: consoleErrors,
      _severeAxe: severeViolations,
    };

    // First non-empty URL also wins as the base URL banner. We strip the
    // route path off whatever Playwright recorded so it's the *site* origin
    // + base path, not the specific page.
    if (!summary.baseUrl && r.url) {
      try {
        const u = new URL(r.url);
        // Trim route from the end; the route normally appears as the
        // pathname suffix. Fall back to origin if anything is weird.
        const pathOnly = u.pathname;
        const guess = r.route.replace(/^\/+|\/+$/g, '');
        const trimmed =
          guess && pathOnly.endsWith(guess + '/') ?
            pathOnly.slice(0, -guess.length - 1)
          : guess && pathOnly.endsWith(guess) ? pathOnly.slice(0, -guess.length)
          : pathOnly;
        summary.baseUrl = `${u.origin}${trimmed}`;
      } catch {
        summary.baseUrl = r.url;
      }
    }
  }

  for (const k of Object.keys(dSummary)) summary.totals[k] += dSummary[k];
  summary.byDevice[device] = dSummary;
}

// Routes appear in the report in the same order the first device discovered
// them — which is the order they were declared in routes.ts.
const orderedRoutes = [...byRoute.keys()];

// ---------------------------------------------------------------------------
// Render Markdown
// ---------------------------------------------------------------------------
const md = [];

md.push('# 📋 Spectre · Cross-browser UI audit — Discrepancy Report');
md.push('');
md.push(`_Generated: ${summary.generatedAt}_`);
md.push('');

if (summary.baseUrl) {
  md.push(`**Base URL:** [${summary.baseUrl}](${summary.baseUrl})`);
  md.push('');
}

md.push(
  `**Devices tested:** ${devices.length}  •  **Routes audited:** ${orderedRoutes.length}`
);
md.push('');

// Per-device numerical summary
md.push('## Summary — totals by device');
md.push('');
md.push(
  '| Device | Routes | Console errors | Network fails | Overflow | A11y (severe) | Run errors |'
);
md.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const device of devices) {
  const d = summary.byDevice[device];
  md.push(
    `| \`${device}\` | ${d.routes} | ${d.consoleErrors} | ${d.networkFailures} | ${d.overflowOffenders} | ${d.axeSevere} | ${d.runErrors} |`
  );
}
md.push('');
md.push('---');
md.push('');

// Per-route walkthrough
md.push('## Routes');
md.push('');

for (const route of orderedRoutes) {
  const slot = byRoute.get(route);
  md.push(`### \`${route}\``);
  md.push('');
  if (slot.url) {
    md.push(`🔗 **URL:** [${slot.url}](${slot.url})`);
    md.push('');
  }

  // 1. Screenshot gallery — one image per (device × screenshot variant).
  //    Lay out as a 4-column grid using a markdown table so it renders
  //    nicely in GitHub / VS Code preview without HTML.
  const gallery = [];
  for (const device of devices) {
    const r = slot.devices[device];
    if (!r) continue;
    for (const shot of sortShots(r.screenshots || [])) {
      gallery.push({ device, shot });
    }
  }

  if (gallery.length) {
    md.push('#### Screenshots');
    md.push('');
    const COLS = 4;
    md.push('| ' + Array(COLS).fill(' ').join(' | ') + ' |');
    md.push('| ' + Array(COLS).fill(':---:').join(' | ') + ' |');
    for (let i = 0; i < gallery.length; i += COLS) {
      const row = gallery.slice(i, i + COLS);
      const labels = row
        .map(({ device, shot }) => {
          // Pull interaction suffix off the filename so the caption stays short.
          const base = path.basename(shot, '.png');
          const inter =
            base.includes('--') ? ` _(${base.split('--')[1]})_` : '';
          return `**${device}**${inter}`;
        })
        .concat(Array(COLS - row.length).fill(''))
        .join(' | ');
      const imgs = row
        .map(({ shot }) => `![](./${shot})`)
        .concat(Array(COLS - row.length).fill(''))
        .join(' | ');
      md.push(`| ${labels} |`);
      md.push(`| ${imgs} |`);
    }
    md.push('');
  }

  // 2. Findings per device
  let anyFindings = false;
  const findings = [];
  for (const device of devices) {
    const r = slot.devices[device];
    if (!r) continue;
    const sections = [];

    if (r.errors?.length) {
      sections.push(
        `**⚠️ Run errors:**\n` + r.errors.map((e) => `- ${e}`).join('\n')
      );
    }
    if (r._consoleErrors.length) {
      const lines = r._consoleErrors
        .slice(0, 20)
        .map(
          (c) =>
            `- \`${c.type}\` ${c.text}${c.location ? ` _(${c.location})_` : ''}`
        );
      if (r._consoleErrors.length > 20)
        lines.push(`- …and ${r._consoleErrors.length - 20} more`);
      sections.push(
        `**❌ Console (${r._consoleErrors.length}):**\n` + lines.join('\n')
      );
    }
    if (r.networkFailures?.length) {
      const lines = r.networkFailures
        .slice(0, 20)
        .map((n) => `- ${n.method} ${n.url} — ${n.failure}`);
      if (r.networkFailures.length > 20)
        lines.push(`- …and ${r.networkFailures.length - 20} more`);
      sections.push(
        `**🌐 Network failures (${r.networkFailures.length}):**\n` +
          lines.join('\n')
      );
    }
    if (r.overflow?.length) {
      const lines = r.overflow
        .slice(0, 15)
        .map(
          (o) =>
            `- \`${o.selector}\` — scrollWidth ${o.scrollWidth}px > clientWidth ${o.clientWidth}px`
        );
      if (r.overflow.length > 15)
        lines.push(`- …and ${r.overflow.length - 15} more`);
      sections.push(
        `**📐 Horizontal overflow (${r.overflow.length}):**\n` +
          lines.join('\n')
      );
    }
    if (r._severeAxe.length) {
      const lines = r._severeAxe
        .slice(0, 15)
        .map(
          (v) =>
            `- **${v.impact}** \`${v.id}\` — ${v.help} (${v.nodes?.length ?? 0} nodes)`
        );
      if (r._severeAxe.length > 15)
        lines.push(`- …and ${r._severeAxe.length - 15} more`);
      sections.push(
        `**♿ Axe (severe) (${r._severeAxe.length}):**\n` + lines.join('\n')
      );
    }

    if (sections.length) {
      anyFindings = true;
      findings.push(
        `<details><summary><strong>${device}</strong> — issues</summary>\n\n${sections.join('\n\n')}\n\n</details>`
      );
    } else {
      findings.push(`✅ **${device}** — no issues detected`);
    }
  }

  if (findings.length) {
    md.push('#### Findings');
    md.push('');
    md.push(findings.join('\n\n'));
    md.push('');
  }

  if (!anyFindings) {
    md.push('_No discrepancies detected on this route across any device._');
    md.push('');
  }
  md.push('---');
  md.push('');
}

md.push('## Totals');
md.push('');
md.push(`- **Routes audited:** ${orderedRoutes.length}`);
md.push(`- **Console errors:** ${summary.totals.consoleErrors}`);
md.push(`- **Network failures:** ${summary.totals.networkFailures}`);
md.push(
  `- **Horizontal overflow offenders:** ${summary.totals.overflowOffenders}`
);
md.push(`- **A11y violations (severe):** ${summary.totals.axeSevere}`);
md.push(`- **Run errors:** ${summary.totals.runErrors}`);
md.push('');

// Compute visual diffs (if sharp is available) before rendering so the
// HTML renderer can decorate each screenshot with a similarity badge.
await computeVisualDiffs(byRoute, devices);

// Run the post-mortem aggregator BEFORE rendering the HTML so the renderer
// can inline the clustered findings + LLM prompt. We pass --silent so it
// doesn't spam our stdout or steal the user's clipboard — the report HTML
// has dedicated "Copy prompt" buttons for that.
let postmortem = null;
try {
  const r = spawn('node', [path.join(__dirname, 'postmortem.js'), '--silent'], {
    stdio: 'ignore',
  });
  // postmortem.js writes synchronously; we just need to wait for it.
  await new Promise((resolve) => r.on('exit', resolve));
  const dataPath = path.join(ROOT, 'postmortem-data.json');
  const promptPath = path.join(ROOT, 'postmortem-prompt.md');
  if (fs.existsSync(dataPath) && fs.existsSync(promptPath)) {
    postmortem = {
      data: JSON.parse(fs.readFileSync(dataPath, 'utf8')),
      prompt: fs.readFileSync(promptPath, 'utf8'),
    };
  }
} catch {
  /* best effort — HTML still renders without postmortem */
}

fs.writeFileSync(OUT_MD, md.join('\n'));
fs.writeFileSync(OUT_JSON, JSON.stringify(summary, null, 2));
fs.writeFileSync(
  OUT_HTML,
  renderHtml(summary, byRoute, orderedRoutes, postmortem)
);

const logLine = `[${summary.generatedAt}] devices=${devices.length} routes=${orderedRoutes.length} consoleErrors=${summary.totals.consoleErrors} networkFailures=${summary.totals.networkFailures} overflow=${summary.totals.overflowOffenders} axeSevere=${summary.totals.axeSevere} runErrors=${summary.totals.runErrors}\n`;
fs.appendFileSync(OUT_LOG, logLine);

console.log(`✅ Wrote ${path.relative(process.cwd(), OUT_MD)}`);
console.log(`✅ Wrote ${path.relative(process.cwd(), OUT_HTML)}`);
console.log(`✅ Wrote ${path.relative(process.cwd(), OUT_JSON)}`);
console.log(`✅ Appended ${path.relative(process.cwd(), OUT_LOG)}`);
console.log('');
console.log('Totals:', summary.totals);

if (NO_SERVE) {
  // Always exit 0 — discovering UI bugs is success for this tool.
  process.exit(0);
}

serve(ROOT, PORT);

// ---------------------------------------------------------------------------
// HTML renderer — single self-contained page, served by the tiny http server
// below. Inlines the report data + styles so the file works without the
// server (open it directly in a browser too).
// ---------------------------------------------------------------------------
function htmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderHtml(summary, byRoute, orderedRoutes, postmortem) {
  const deviceList = Object.keys(summary.byDevice).sort();

  const summaryRows = deviceList
    .map((d) => {
      const s = summary.byDevice[d];
      return `<tr>
        <td><code>${htmlEscape(d)}</code></td>
        <td class="num">${s.routes}</td>
        <td class="num ${s.consoleErrors ? 'bad' : ''}">${s.consoleErrors}</td>
        <td class="num ${s.networkFailures ? 'bad' : ''}">${s.networkFailures}</td>
        <td class="num ${s.overflowOffenders ? 'warn' : ''}">${s.overflowOffenders}</td>
        <td class="num ${s.axeSevere ? 'bad' : ''}">${s.axeSevere}</td>
        <td class="num ${s.runErrors ? 'bad' : ''}">${s.runErrors}</td>
      </tr>`;
    })
    .join('\n');

  const routeSections = orderedRoutes
    .map((route) => {
      const slot = byRoute.get(route);
      const gallery = [];
      for (const device of deviceList) {
        const r = slot.devices[device];
        if (!r) continue;
        for (const shot of sortShots(r.screenshots || [])) {
          const base = path.basename(shot, '.png');
          const inter = base.includes('--') ? ` · ${base.split('--')[1]}` : '';

          // Visual-diff badge against the same-form-factor baseline.
          const filename = path.basename(shot);
          const diff =
            r._diffs && r._diffs[filename] !== undefined ?
              r._diffs[filename]
            : null;
          const isBaseline =
            slot._baselineByFactor &&
            slot._baselineByFactor[formFactor(device)] === device;
          let badge = '';
          let cls = '';
          if (diff !== null) {
            if (isBaseline) {
              badge = `<span class="diff-badge baseline" title="Baseline for ${htmlEscape(formFactor(device))}">baseline</span>`;
            } else {
              const tier =
                diff < 1 ? 'good'
                : diff < 5 ? 'warn'
                : 'bad';
              cls = `diff-${tier}`;
              badge = `<span class="diff-badge ${tier}" title="MSE-style pixel difference vs ${htmlEscape(slot._baselineByFactor[formFactor(device)])} (lower = more similar)">Δ ${diff}%</span>`;
            }
          }

          gallery.push(`
            <figure class="shot ${cls}">
              <a href="${htmlEscape(shot)}" target="_blank" rel="noopener">
                <img loading="lazy" src="${htmlEscape(shot)}" alt="${htmlEscape(device)}${htmlEscape(inter)}">
              </a>
              <figcaption>
                <strong>${htmlEscape(device)}</strong>${htmlEscape(inter)}
                ${badge}
              </figcaption>
            </figure>
          `);
        }
      }

      const findings = deviceList
        .map((device) => {
          const r = slot.devices[device];
          if (!r) return '';
          const blocks = [];
          if (r.errors?.length) {
            blocks.push(
              `<details open><summary class="bad">⚠️ Run errors (${r.errors.length})</summary><ul>${r.errors.map((e) => `<li>${htmlEscape(e)}</li>`).join('')}</ul></details>`
            );
          }
          if (r._consoleErrors?.length) {
            blocks.push(
              `<details><summary class="bad">❌ Console (${r._consoleErrors.length})</summary><ul>${r._consoleErrors
                .slice(0, 50)
                .map(
                  (c) =>
                    `<li><code>${htmlEscape(c.type)}</code> ${htmlEscape(c.text)}${c.location ? ` <span class="dim">(${htmlEscape(c.location)})</span>` : ''}</li>`
                )
                .join('')}</ul></details>`
            );
          }
          if (r.networkFailures?.length) {
            blocks.push(
              `<details><summary class="bad">🌐 Network failures (${r.networkFailures.length})</summary><ul>${r.networkFailures
                .map(
                  (n) =>
                    `<li>${htmlEscape(n.method)} <code>${htmlEscape(n.url)}</code> — ${htmlEscape(n.failure)}</li>`
                )
                .join('')}</ul></details>`
            );
          }
          if (r.overflow?.length) {
            blocks.push(
              `<details><summary class="warn">📐 Overflow (${r.overflow.length})</summary><ul>${r.overflow
                .slice(0, 25)
                .map(
                  (o) =>
                    `<li><code>${htmlEscape(o.selector)}</code> — ${o.scrollWidth}px > ${o.clientWidth}px</li>`
                )
                .join('')}</ul></details>`
            );
          }
          if (r._severeAxe?.length) {
            blocks.push(
              `<details><summary class="bad">♿ Axe severe (${r._severeAxe.length})</summary><ul>${r._severeAxe
                .map(
                  (v) =>
                    `<li><strong>${htmlEscape(v.impact)}</strong> <code>${htmlEscape(v.id)}</code> — ${htmlEscape(v.help || '')} (${v.nodes?.length ?? 0} nodes)</li>`
                )
                .join('')}</ul></details>`
            );
          }

          if (!blocks.length) {
            return `<div class="device clean"><strong>${htmlEscape(device)}</strong> ✅ no issues</div>`;
          }
          return `<div class="device"><strong>${htmlEscape(device)}</strong>${blocks.join('')}</div>`;
        })
        .join('');

      return `
        <section class="route" id="route-${htmlEscape(route)}">
          <h2><code>${htmlEscape(route)}</code></h2>
          ${slot.url ? `<p class="url">🔗 <a href="${htmlEscape(slot.url)}" target="_blank" rel="noopener">${htmlEscape(slot.url)}</a></p>` : ''}
          <div class="toolbar">
            <h3 style="margin:0;">Screenshots</h3>
            <div class="view-toggle" data-route="${htmlEscape(route)}">
              <button data-mode="grid" class="active">Grid</button>
              <button data-mode="diff" title="Diff each device against the first one in its category (desktop vs desktop, mobile vs mobile)">Diff vs baseline</button>
              <button data-mode="overlay" title="Toggle two images on top of each other with an opacity slider">Overlay</button>
            </div>
          </div>
          <div class="gallery" data-route-gallery="${htmlEscape(route)}">${gallery.join('')}</div>
          <h3>Findings</h3>
          <div class="findings">${findings}</div>
        </section>
      `;
    })
    .join('\n');

  const toc = orderedRoutes
    .map(
      (r) =>
        `<li><a href="#route-${htmlEscape(r)}"><code>${htmlEscape(r)}</code></a></li>`
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Spectre UI Audit — ${htmlEscape(summary.baseUrl || '')}</title>
<style>
  :root {
    --bg: #0e1116;
    --panel: #161b22;
    --border: #30363d;
    --text: #e6edf3;
    --dim: #8b949e;
    --bad: #f85149;
    --warn: #d29922;
    --good: #3fb950;
    --link: #58a6ff;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #ffffff; --panel: #f6f8fa; --border: #d0d7de;
      --text: #1f2328; --dim: #57606a;
      --bad: #cf222e; --warn: #9a6700; --good: #1a7f37; --link: #0969da;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
  }
  header.top {
    position: sticky; top: 0; z-index: 10;
    background: var(--panel); border-bottom: 1px solid var(--border);
    padding: 12px 24px;
  }
  header.top h1 { margin: 0 0 4px; font-size: 18px; }
  header.top .meta { color: var(--dim); font-size: 12px; }
  header.top a { color: var(--link); }
  header.top .links { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 8px; }
  header.top .links a {
    text-decoration: none;
    border: 1px solid var(--border);
    padding: 3px 10px;
    border-radius: 999px;
    font-size: 12px;
  }
  header.top .links a:hover { background: var(--bg); }

  .postmortem { margin: 32px 0; padding: 20px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; }
  .postmortem h2 { margin-top: 0; border-bottom: 0; }
  .postmortem .pm-meta { color: var(--dim); font-size: 12px; margin-bottom: 16px; }
  .postmortem .pm-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 16px; }
  .postmortem .pm-stat { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 10px 14px; }
  .postmortem .pm-stat .label { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--dim); }
  .postmortem .pm-stat .value { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .postmortem details { margin: 12px 0; }
  .postmortem summary { cursor: pointer; user-select: none; font-weight: 600; }
  .postmortem .clusters { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; }
  .postmortem .cluster { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 10px 14px; }
  .postmortem .cluster .head { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
  .postmortem .cluster .count { color: var(--bad); font-weight: 600; }
  .postmortem .cluster ul { margin: 4px 0 0; padding-left: 18px; font-size: 12px; color: var(--dim); }
  .pm-prompt-actions { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
  .pm-prompt-actions button {
    background: var(--link); color: #fff; border: 0; border-radius: 6px;
    padding: 6px 12px; font: inherit; font-size: 12px; cursor: pointer;
  }
  .pm-prompt-actions button:hover { filter: brightness(1.1); }
  .pm-prompt-actions .copied { color: var(--good); font-size: 12px; }
  .pm-prompt-box {
    background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    padding: 12px; font-family: ui-monospace, monospace; font-size: 12px;
    max-height: 360px; overflow: auto; white-space: pre-wrap; word-break: break-word;
  }
  main { padding: 24px; max-width: 1400px; margin: 0 auto; }
  h2 { margin: 0 0 8px; font-size: 20px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
  h3 { font-size: 14px; text-transform: uppercase; letter-spacing: .06em; color: var(--dim); margin: 24px 0 8px; }
  code { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; font-size: 0.9em; background: var(--panel); padding: 1px 6px; border-radius: 4px; }
  a { color: var(--link); }
  table { width: 100%; border-collapse: collapse; }
  table th, table td { padding: 6px 10px; border-bottom: 1px solid var(--border); text-align: left; }
  table th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--dim); }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .bad  { color: var(--bad);  font-weight: 600; }
  .warn { color: var(--warn); font-weight: 600; }
  .good { color: var(--good); }
  .dim  { color: var(--dim); }

  .toc { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 0; padding: 0; list-style: none; }
  .toc li a { display: inline-block; padding: 4px 10px; border: 1px solid var(--border); border-radius: 999px; text-decoration: none; }
  .toc li a:hover { background: var(--panel); }

  section.route { margin: 48px 0; }
  .url { margin: 0 0 12px; color: var(--dim); }

  .gallery {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 12px;
  }
  .shot {
    margin: 0;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px;
    overflow: hidden;
    transition: border-color .15s;
  }
  .shot.diff-warn { border-color: var(--warn); box-shadow: 0 0 0 1px var(--warn) inset; }
  .shot.diff-bad  { border-color: var(--bad);  box-shadow: 0 0 0 1px var(--bad)  inset; }

  .diff-badge {
    display: inline-block;
    margin-left: 6px;
    font-size: 11px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 999px;
    vertical-align: middle;
  }
  .diff-badge.baseline { background: rgba(99,99,99,.25); color: var(--dim); }
  .diff-badge.good { background: rgba(63,185,80,.18); color: var(--good); }
  .diff-badge.warn { background: rgba(210,153,34,.22); color: var(--warn); }
  .diff-badge.bad  { background: rgba(248,81,73,.22);  color: var(--bad);  }
  .shot img {
    width: 100%; height: 320px; object-fit: cover; object-position: top;
    display: block; border-radius: 4px;
    background: #fff;
  }
  .shot figcaption { font-size: 12px; color: var(--dim); margin-top: 6px; }
  .shot.baseline { outline: 2px solid var(--good); outline-offset: -2px; }
  .shot.baseline figcaption::before { content: '★ baseline · '; color: var(--good); font-weight: 600; }
  .shot .diff-stat {
    position: absolute; top: 12px; right: 12px;
    background: rgba(0,0,0,0.7); color: #fff;
    padding: 2px 8px; border-radius: 4px; font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .shot { position: relative; }

  .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 24px 0 8px; flex-wrap: wrap; }
  .view-toggle { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  .view-toggle button {
    background: transparent; color: var(--text); border: 0;
    padding: 4px 12px; font: inherit; font-size: 12px; cursor: pointer;
    border-right: 1px solid var(--border);
  }
  .view-toggle button:last-child { border-right: 0; }
  .view-toggle button:hover { background: var(--bg); }
  .view-toggle button.active { background: var(--link); color: #fff; }

  /* Overlay mode: stack two shots and crossfade via slider. */
  .overlay-stage {
    position: relative;
    display: grid;
    grid-template-columns: 240px 1fr;
    gap: 16px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px;
  }
  .overlay-stage .picker { display: flex; flex-direction: column; gap: 6px; }
  .overlay-stage .picker label { font-size: 12px; color: var(--dim); }
  .overlay-stage .picker select { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 4px 6px; }
  .overlay-stage .picker .slider-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
  .overlay-stage .picker .slider-row input { flex: 1; }
  .overlay-canvas-wrap {
    position: relative;
    background: #000;
    border-radius: 4px;
    overflow: auto;
    min-height: 300px;
    max-height: 80vh;
  }
  .overlay-canvas-wrap img {
    display: block;
    width: 100%; height: auto;
    position: absolute; top: 0; left: 0;
  }
  .overlay-canvas-wrap img:first-child { position: relative; }

  .findings { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; }
  .device { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 10px 14px; }
  .device.clean { color: var(--good); }
  .device details { margin: 6px 0; }
  .device summary { cursor: pointer; user-select: none; }
  .device ul { margin: 6px 0 8px 18px; padding: 0; }
  .device li { margin: 2px 0; }
</style>
</head>
<body>
<header class="top">
  <h1>📋 Spectre · Cross-browser UI audit</h1>
  <div class="meta">
    ${summary.baseUrl ? `Base URL: <a href="${htmlEscape(summary.baseUrl)}" target="_blank" rel="noopener">${htmlEscape(summary.baseUrl)}</a> • ` : ''}
    Generated ${htmlEscape(summary.generatedAt)} •
    ${deviceList.length} device${deviceList.length === 1 ? '' : 's'} • ${orderedRoutes.length} route${orderedRoutes.length === 1 ? '' : 's'}
  </div>
  <nav class="links">
    ${
      fs.existsSync(path.join(ROOT, 'playwright-report', 'index.html')) ?
        `<a href="playwright-report/index.html" target="_blank" rel="noopener">🎭 Playwright report</a>`
      : ''
    }
    <a href="report.md" target="_blank" rel="noopener">📝 Markdown</a>
    ${
      postmortem ?
        `<a href="postmortem-prompt.md" target="_blank" rel="noopener">🧠 Post-mortem prompt</a>`
      : ''
    }
  </nav>
</header>
<main data-baselines='${htmlEscape(JSON.stringify(detectBaselines(deviceList)))}'>
  <h2>Totals by device</h2>
  <table>
    <thead><tr>
      <th>Device</th><th class="num">Routes</th><th class="num">Console</th>
      <th class="num">Network</th><th class="num">Overflow</th>
      <th class="num">A11y severe</th><th class="num">Run errors</th>
    </tr></thead>
    <tbody>${summaryRows}</tbody>
  </table>

  <h3>Jump to route</h3>
  <ul class="toc">${toc}</ul>

  ${renderPostmortemSection(postmortem)}

  ${routeSections}
</main>

<script>
/**
 * Client-side visual diff + overlay for the screenshot gallery.
 *
 * Inspired by Storybook's Chromatic and GitHub's image-diff viewer.
 * Runs purely in the browser — no server dependency, no extra build.
 *
 * Modes (toggled per route):
 *   - "grid"    : default — just show every screenshot side-by-side.
 *   - "diff"    : pick the first device in each "family" (desktop/mobile/tablet)
 *                 as baseline. Replace every other shot in the family with a
 *                 red-tinted pixel-diff against its baseline, plus a "X% diff"
 *                 chip. Baseline cells get a green outline + "★ baseline" tag.
 *   - "overlay" : "swipe" style — pick any two shots from a route and crossfade
 *                 between them with an opacity slider. Best for catching small
 *                 layout shifts the diff mode flattens.
 */
(function () {
  const BASELINES = JSON.parse(document.querySelector('main').dataset.baselines || '{}');

  // family → first slug for that family in the device list
  // e.g. {desktop: 'desktop-chrome', mobile: 'iphone-15', tablet: 'ipad-mini'}

  function familyOf(slug) {
    if (slug.startsWith('desktop-') || /-(safari|chrome|firefox|edge)$/.test(slug) && !slug.startsWith('iphone') && !slug.startsWith('pixel') && !slug.startsWith('galaxy')) {
      // crude: 'mac-safari', 'win-chrome', 'desktop-*' → desktop
      if (slug.startsWith('mac-') || slug.startsWith('win-') || slug.startsWith('desktop-')) return 'desktop';
    }
    if (slug.startsWith('ipad') || slug.startsWith('tablet')) return 'tablet';
    return 'mobile';
  }

  function deviceSlugOfShot(shotEl) {
    return shotEl.dataset.device;
  }

  async function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  /**
   * Pixel-diff two images on a canvas, return {dataUrl, percent}.
   * Both images are scaled to the smaller of the two so we don't blow up
   * memory on 4× full-page screenshots.
   */
  async function diffImages(baselineSrc, otherSrc) {
    const [a, b] = await Promise.all([loadImage(baselineSrc), loadImage(otherSrc)]);
    const w = Math.min(a.naturalWidth, b.naturalWidth, 800);
    const ratio = w / Math.max(a.naturalWidth, b.naturalWidth);
    const hA = Math.round(a.naturalHeight * (w / a.naturalWidth));
    const hB = Math.round(b.naturalHeight * (w / b.naturalWidth));
    const h = Math.min(hA, hB);

    const canvA = document.createElement('canvas');
    canvA.width = w; canvA.height = h;
    canvA.getContext('2d').drawImage(a, 0, 0, w, h);

    const canvB = document.createElement('canvas');
    canvB.width = w; canvB.height = h;
    canvB.getContext('2d').drawImage(b, 0, 0, w, h);

    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const ctx = out.getContext('2d');

    // Draw "b" as the base layer so the diff overlay reads like
    // "this is what device B looks like, with the differences highlighted".
    ctx.drawImage(b, 0, 0, w, h);

    const dataA = canvA.getContext('2d').getImageData(0, 0, w, h).data;
    const dataB = canvB.getContext('2d').getImageData(0, 0, w, h).data;
    const overlay = ctx.getImageData(0, 0, w, h);
    const out8 = overlay.data;

    let diffCount = 0;
    const threshold = 24; // perceptual: ignore tiny anti-aliasing differences

    for (let i = 0; i < dataA.length; i += 4) {
      const dr = Math.abs(dataA[i] - dataB[i]);
      const dg = Math.abs(dataA[i + 1] - dataB[i + 1]);
      const db = Math.abs(dataA[i + 2] - dataB[i + 2]);
      const delta = dr + dg + db;

      if (delta > threshold) {
        diffCount++;
        // tint pixel magenta — Chromatic/Percy style
        out8[i] = 255;
        out8[i + 1] = 50;
        out8[i + 2] = 220;
        out8[i + 3] = 220;
      } else {
        // desaturate non-different pixels so the highlights pop
        const g = (dataB[i] + dataB[i + 1] + dataB[i + 2]) / 3;
        out8[i] = g; out8[i + 1] = g; out8[i + 2] = g; out8[i + 3] = 120;
      }
    }
    ctx.putImageData(overlay, 0, 0);

    const percent = (diffCount / (w * h)) * 100;
    return { dataUrl: out.toDataURL('image/png'), percent };
  }

  // -------------------------------------------------------------------------
  // Wire up the per-route toggles
  // -------------------------------------------------------------------------
  document.querySelectorAll('.view-toggle').forEach((toggle) => {
    const route = toggle.dataset.route;
    const gallery = document.querySelector('[data-route-gallery="' + CSS.escape(route) + '"]');

    // Tag every figure with its device slug + original src so we can swap
    // src in/out without losing it when leaving diff mode.
    gallery.querySelectorAll('.shot').forEach((fig) => {
      const img = fig.querySelector('img');
      if (img && !fig.dataset.device) {
        // alt is "<device> · <interaction>" — first token is the device slug
        // pulled from the alt's bold prefix in renderHtml, but we set the
        // explicit attr now for robustness.
        const cap = fig.querySelector('figcaption strong');
        fig.dataset.device = cap ? cap.textContent.trim() : '';
        fig.dataset.originalSrc = img.getAttribute('src');
      }
    });

    toggle.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', async () => {
        toggle.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const mode = btn.dataset.mode;

        // Restore originals first
        gallery.querySelectorAll('.shot').forEach((fig) => {
          const img = fig.querySelector('img');
          if (img && fig.dataset.originalSrc) img.src = fig.dataset.originalSrc;
          fig.classList.remove('baseline');
          fig.querySelector('.diff-stat')?.remove();
        });

        // Remove any overlay stage that might have been left in
        gallery.parentElement.querySelector('.overlay-stage')?.remove();
        gallery.style.display = '';

        if (mode === 'grid') return;

        if (mode === 'diff') {
          await diffMode(gallery);
        } else if (mode === 'overlay') {
          overlayMode(gallery, route);
        }
      });
    });
  });

  async function diffMode(gallery) {
    // Group shots by family. Within each family the first shot becomes
    // baseline; the rest get pixel-diffed against it.
    const figs = Array.from(gallery.querySelectorAll('.shot'));
    const byFamily = new Map();
    for (const fig of figs) {
      const device = fig.dataset.device || '';
      const fam = familyOf(device);
      // Also group by *interaction variant* so we don't diff a
      // "home" base shot against a "home--menu-open" interaction shot.
      const variant = (fig.querySelector('figcaption')?.textContent || '').split('·')[1]?.trim() || '_base';
      const key = fam + '::' + variant;
      if (!byFamily.has(key)) byFamily.set(key, []);
      byFamily.get(key).push(fig);
    }

    for (const group of byFamily.values()) {
      if (group.length < 2) continue;
      const baseline = group[0];
      baseline.classList.add('baseline');
      const baselineSrc = baseline.dataset.originalSrc;

      for (let i = 1; i < group.length; i++) {
        const fig = group[i];
        const img = fig.querySelector('img');
        try {
          const { dataUrl, percent } = await diffImages(baselineSrc, fig.dataset.originalSrc);
          img.src = dataUrl;
          const chip = document.createElement('div');
          chip.className = 'diff-stat';
          chip.textContent = percent.toFixed(2) + '% diff';
          fig.appendChild(chip);
        } catch (err) {
          // Most likely a CORS taint — when served by our own static
          // server this can't happen, but if the user opens index.html
          // directly via file:// canvas will refuse to readback the pixels.
          const chip = document.createElement('div');
          chip.className = 'diff-stat';
          chip.style.background = 'rgba(180, 0, 0, 0.9)';
          chip.textContent = 'diff failed';
          fig.appendChild(chip);
        }
      }
    }
  }

  function overlayMode(gallery, route) {
    const figs = Array.from(gallery.querySelectorAll('.shot'));
    if (figs.length < 2) return;

    gallery.style.display = 'none';

    const options = figs.map((fig, i) => {
      const cap = fig.querySelector('figcaption');
      return '<option value="' + i + '">' + (cap?.textContent.trim() || ('shot ' + i)) + '</option>';
    }).join('');

    const stage = document.createElement('div');
    stage.className = 'overlay-stage';
    stage.innerHTML =
      '<div class="picker">' +
        '<label>Base <select data-role="base">' + options + '</select></label>' +
        '<label>Compare <select data-role="other">' + options + '</select></label>' +
        '<div class="slider-row">' +
          '<span style="font-size:11px;">A</span>' +
          '<input type="range" min="0" max="100" value="50" data-role="alpha">' +
          '<span style="font-size:11px;">B</span>' +
        '</div>' +
        '<p style="font-size:11px;color:var(--dim);margin:8px 0 0;">' +
          'Drag the slider to crossfade between the two screenshots.' +
        '</p>' +
      '</div>' +
      '<div class="overlay-canvas-wrap">' +
        '<img data-layer="base" src="' + figs[0].dataset.originalSrc + '">' +
        '<img data-layer="other" src="' + (figs[1] || figs[0]).dataset.originalSrc + '" style="opacity:0.5;">' +
      '</div>';
    gallery.parentElement.insertBefore(stage, gallery.nextSibling);

    const baseSel = stage.querySelector('[data-role="base"]');
    const otherSel = stage.querySelector('[data-role="other"]');
    const alpha = stage.querySelector('[data-role="alpha"]');
    const baseImg = stage.querySelector('[data-layer="base"]');
    const otherImg = stage.querySelector('[data-layer="other"]');

    baseSel.value = '0';
    otherSel.value = figs.length > 1 ? '1' : '0';

    baseSel.addEventListener('change', () => {
      baseImg.src = figs[parseInt(baseSel.value, 10)].dataset.originalSrc;
    });
    otherSel.addEventListener('change', () => {
      otherImg.src = figs[parseInt(otherSel.value, 10)].dataset.originalSrc;
    });
    alpha.addEventListener('input', () => {
      otherImg.style.opacity = (parseInt(alpha.value, 10) / 100).toFixed(2);
    });
  }
})();
</script>
</body>
</html>
`;
}

/**
 * Render the post-mortem section that lives between the route TOC and the
 * route sections. Driven entirely by the JSON written by postmortem.js.
 * If postmortem isn't available (sharp not installed / no reports), we
 * return an empty string and the section silently disappears.
 */
function renderPostmortemSection(postmortem) {
  if (!postmortem || !postmortem.data) return '';
  const d = postmortem.data;

  // Top-N helpers — render at most 8 clusters in each card so the section
  // doesn't dominate the page. Users can drill into the raw JSON link.
  const topConsole = (d.topConsole || []).slice(0, 8);
  const topNetwork = (d.topNetwork || []).slice(0, 8);
  const topAxe = [...(d.topAxe || [])]
    .sort((a, b) => {
      const w = { critical: 3, serious: 2, moderate: 1 };
      const dw = (w[b.impact] || 0) - (w[a.impact] || 0);
      return dw !== 0 ? dw : b.count - a.count;
    })
    .slice(0, 8);

  const totalJs = topConsole.reduce((s, e) => s + e.count, 0);
  const totalNet = topNetwork.reduce((s, e) => s + e.count, 0);
  const a11ySevere = (d.topAxe || []).filter(
    (a) => a.impact === 'critical' || a.impact === 'serious'
  ).length;

  const renderCluster = (head, count, examples, tier = 'bad') => `
    <div class="cluster">
      <div class="head">
        <div>${head}</div>
        <span class="count ${tier}">× ${count}</span>
      </div>
      ${examples ? `<ul>${examples}</ul>` : ''}
    </div>`;

  const consoleHtml =
    topConsole
      .map((e) =>
        renderCluster(
          `<code>${htmlEscape(e.type)}</code> ${htmlEscape((e.text || '').slice(0, 90))}`,
          e.count,
          (e.examples || [])
            .slice(0, 3)
            .map(
              (x) => `<li>${htmlEscape(x.device)}/${htmlEscape(x.route)}</li>`
            )
            .join('')
        )
      )
      .join('') || '<p class="dim">No console errors detected.</p>';

  const networkHtml =
    topNetwork
      .map((e) =>
        renderCluster(
          `<code>${htmlEscape(e.method)} ${htmlEscape((e.url || '').slice(0, 80))}</code>`,
          e.count,
          (e.examples || [])
            .slice(0, 3)
            .map(
              (x) =>
                `<li>${htmlEscape(x.device)}/${htmlEscape(x.route)} — ${htmlEscape(x.failure || '')}</li>`
            )
            .join('')
        )
      )
      .join('') || '<p class="dim">No network failures detected.</p>';

  const axeHtml =
    topAxe
      .map((a) =>
        renderCluster(
          `<strong class="${a.impact === 'critical' || a.impact === 'serious' ? 'bad' : 'warn'}">${htmlEscape(a.impact)}</strong> <code>${htmlEscape(a.id)}</code> — ${htmlEscape(a.help || '')}`,
          a.count,
          `<li>affects ${a.routes?.length || 0} route(s), ${a.devices?.length || 0} device(s)</li>`,
          a.impact === 'critical' || a.impact === 'serious' ? 'bad' : 'warn'
        )
      )
      .join('') || '<p class="dim">No accessibility violations detected.</p>';

  const worstRoutesHtml =
    (d.ranked || [])
      .slice(0, 10)
      .map(
        (r) =>
          `<tr>
            <td><code>${htmlEscape(r.route)}</code></td>
            <td><code>${htmlEscape(r.device)}</code></td>
            <td class="num"><strong>${r.score}</strong></td>
            <td class="num ${r.console ? 'bad' : ''}">${r.console}</td>
            <td class="num ${r.network ? 'bad' : ''}">${r.network}</td>
            <td class="num ${r.overflow ? 'warn' : ''}">${r.overflow}</td>
            <td class="num ${r.a11ySevere ? 'bad' : ''}">${r.a11ySevere}</td>
            <td class="num ${r.runErrors ? 'bad' : ''}">${r.runErrors}</td>
          </tr>`
      )
      .join('') ||
    '<tr><td colspan="8" class="dim">No issues — every route is clean.</td></tr>';

  // The prompt is fairly long. Embed it as a textarea-like <pre> with a
  // "Copy" button so the user can pipe it into their LLM in one click.
  const escapedPrompt = htmlEscape(postmortem.prompt || '');
  const sourceLabel = 'local Playwright';

  return `
  <section class="postmortem" id="postmortem">
    <h2>🧠 Post-mortem</h2>
    <div class="pm-meta">
      Source: <strong>${htmlEscape(sourceLabel)}</strong> •
      Generated ${htmlEscape(d.generatedAt)} •
      ${(d.ranked || []).length} non-clean (device × route) pairs
    </div>

    <div class="pm-stats">
      <div class="pm-stat"><div class="label">JS errors</div><div class="value ${totalJs ? 'bad' : 'good'}">${totalJs}</div></div>
      <div class="pm-stat"><div class="label">Network failures</div><div class="value ${totalNet ? 'bad' : 'good'}">${totalNet}</div></div>
      <div class="pm-stat"><div class="label">Axe rules tripped</div><div class="value ${
        a11ySevere ? 'bad'
        : d.topAxe?.length ? 'warn'
        : 'good'
      }">${d.topAxe?.length || 0}</div></div>
      <div class="pm-stat"><div class="label">Worst route score</div><div class="value">${(d.ranked && d.ranked[0]?.score) || 0}</div></div>
    </div>

    <details open>
      <summary>Top JS errors (${topConsole.length})</summary>
      <div class="clusters">${consoleHtml}</div>
    </details>

    <details ${topNetwork.length ? 'open' : ''}>
      <summary>Top failing network requests (${topNetwork.length})</summary>
      <div class="clusters">${networkHtml}</div>
    </details>

    <details>
      <summary>Top accessibility rules (${topAxe.length})</summary>
      <div class="clusters">${axeHtml}</div>
    </details>

    <details open>
      <summary>Worst routes by severity score</summary>
      <table>
        <thead><tr>
          <th>Route</th><th>Device</th><th class="num">Score</th>
          <th class="num">Console</th><th class="num">Network</th>
          <th class="num">Overflow</th><th class="num">A11y(sev)</th>
          <th class="num">RunErr</th>
        </tr></thead>
        <tbody>${worstRoutesHtml}</tbody>
      </table>
    </details>

    <details>
      <summary>📋 LLM triage prompt (paste into Cline / Claude / ChatGPT)</summary>
      <div class="pm-prompt-actions">
        <button id="pm-copy-btn" type="button">Copy prompt to clipboard</button>
        <span id="pm-copy-status" class="copied"></span>
        <a href="postmortem-prompt.md" target="_blank" rel="noopener" style="margin-left:auto;font-size:12px;">Open raw .md →</a>
      </div>
      <div class="pm-prompt-box" id="pm-prompt">${escapedPrompt}</div>
    </details>

    <script>
      (function () {
        const btn = document.getElementById('pm-copy-btn');
        const status = document.getElementById('pm-copy-status');
        const box = document.getElementById('pm-prompt');
        if (!btn || !box) return;
        btn.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(box.textContent);
            status.textContent = '✓ copied';
            setTimeout(() => { status.textContent = ''; }, 2000);
          } catch (err) {
            status.textContent = 'copy failed — select the text below';
            const r = document.createRange();
            r.selectNodeContents(box);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(r);
          }
        });
      })();
    </script>
  </section>
  `;
}

/**
 * Pick a baseline device per "family" — used by the client-side diff viewer
 * to choose which screenshots count as the reference. Currently just an
 * informational hint sent down to the client; family detection is done
 * client-side too (see the inline script).
 */
function detectBaselines(deviceList) {
  const out = { desktop: null, mobile: null, tablet: null };
  for (const d of deviceList) {
    if (
      !out.desktop &&
      (d.startsWith('desktop-') || d.startsWith('mac-') || d.startsWith('win-'))
    ) {
      out.desktop = d;
    } else if (
      !out.tablet &&
      (d.startsWith('ipad') || d.startsWith('tablet'))
    ) {
      out.tablet = d;
    } else if (!out.mobile) {
      out.mobile = d;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tiny static server — mirrors `playwright show-report` UX. Serves the logs/
// directory rooted at `index.html`, finds a free port, opens the user's
// default browser, and stays in the foreground until Ctrl-C.
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function serve(root, port) {
  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://l').pathname);
    } catch {
      res.writeHead(400);
      res.end('bad url');
      return;
    }
    if (pathname === '/') pathname = '/index.html';

    // Prevent path traversal — resolve and ensure it's still inside root.
    const filePath = path.normalize(path.join(root, pathname));
    if (!filePath.startsWith(path.normalize(root))) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });

  server.listen(port, '127.0.0.1', () => {
    const addr = server.address();
    const url = `http://127.0.0.1:${addr.port}/`;
    console.log('');
    console.log(`🌐 Serving report at ${url}`);
    console.log('   Press Ctrl-C to stop.');
    openInBrowser(url);
  });

  // Clean shutdown on Ctrl-C
  process.on('SIGINT', () => {
    server.close();
    process.exit(0);
  });
}

function openInBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
    : 'xdg-open';
  const args =
    process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* best effort */
  }
}
