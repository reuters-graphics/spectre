#!/usr/bin/env node
/**
 * discover.js — route discovery for Spectre.
 *
 * Turns a running site into a list of routes to audit, so projects don't have
 * to hand-maintain a routes file. Three sources:
 *
 *   - 'sitemap' : fetch <baseUrl>/sitemap.xml and read every <loc>
 *   - 'crawl'   : start at '/', follow same-origin links reachable from the
 *                 homepage to a small depth (so unlinked pages — sharecards,
 *                 drafts, embeds — are never touched)
 *   - 'auto'    : sitemap if present, otherwise crawl (the default)
 *
 * Discovery runs in the CLI (never inside the Playwright spec). The CLI writes
 * the resolved list to a generated module and points the spec at it.
 *
 * No third-party deps — uses global fetch (Node 18+).
 */

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Convert a glob (`*`, `**`) to a RegExp anchored to the whole path. */
function globToRegExp(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex specials
    .replace(/\*\*/g, '\u0000') // placeholder for **
    .replace(/\*/g, '[^/]*') // * = anything but a slash
    .replace(/\u0000/g, '.*'); // ** = anything incl. slashes
  return new RegExp(`^${re}$`);
}

function matchesAny(pathname, globs) {
  return globs.some((g) => globToRegExp(g).test(pathname));
}

/** Normalise a URL path: ensure leading slash, drop query + fragment.
 *  Handles fragments that arrive pre-encoded as %23 (common in SPA anchor
 *  links like href="#eu-a" that some frameworks emit as "%23eu-a"), so
 *  same-page anchors collapse to the real page instead of becoming fake
 *  routes that 404. */
function cleanPath(pathname) {
  let p = pathname || '/';
  // Cut at the first query/fragment marker — literal or percent-encoded.
  for (const marker of ['#', '?', '%23', '%3F', '%3f']) {
    const i = p.indexOf(marker);
    if (i >= 0) p = p.slice(0, i);
  }
  if (!p.startsWith('/')) p = '/' + p;
  if (p === '') p = '/';
  return p;
}

/** Base path of the audit target, always with a single trailing slash. */
function basePathOf(baseUrl) {
  let bp = new URL(baseUrl).pathname || '/';
  if (!bp.endsWith('/')) bp += '/';
  return bp;
}

/** Is an origin-absolute path within the base path? */
function underBase(pathname, basePath) {
  const b = basePath.replace(/\/+$/, '');
  if (b === '') return true; // base is the origin root — everything qualifies
  return pathname === b || pathname.startsWith(b + '/');
}

/** Convert an origin-absolute path to one relative to the base path.
 *  e.g. base /p/, path /p/groups/ → /groups/ ; base /p/, path /p/ → / */
function toRelative(pathname, basePath) {
  const b = basePath.replace(/\/+$/, '');
  let rel = b && pathname.startsWith(b) ? pathname.slice(b.length) : pathname;
  if (!rel.startsWith('/')) rel = '/' + rel;
  return rel;
}

/** Derive a readable label from a path. '/' → 'home', '/a/b/' → 'a-b'. */
function labelFromPath(pathname) {
  const trimmed = pathname.replace(/^\/+|\/+$/g, '');
  if (!trimmed) return 'home';
  return trimmed
    .replace(/\.[a-z0-9]+$/i, '') // drop file extension
    .replace(/[^a-z0-9]+/gi, '-')
    .toLowerCase();
}

/** Extensions we never treat as auditable HTML pages. */
const ASSET_EXT =
  /\.(png|jpe?g|gif|svg|webp|avif|ico|css|scss|sass|less|styl|js|mjs|cjs|ts|json|xml|txt|pdf|zip|mp4|webm|mov|woff2?|ttf|eot|map|wasm)$/i;

function isAuditablePath(pathname) {
  if (ASSET_EXT.test(pathname)) return false;
  return true;
}

async function fetchText(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'spectre-discover' },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Sitemap
// ---------------------------------------------------------------------------
async function fromSitemap(baseUrl) {
  const origin = new URL(baseUrl).origin;
  const sitemapUrl = new URL('/sitemap.xml', origin).href;
  const xml = await fetchText(sitemapUrl);
  if (!xml) return null; // signal "not found" so caller can fall back to crawl

  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(
    (m) => m[1]
  );
  const paths = [];
  for (const loc of locs) {
    try {
      const u = new URL(loc);
      if (u.origin !== origin) continue; // same-origin only
      paths.push(cleanPath(u.pathname));
    } catch {
      /* skip malformed */
    }
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Crawl (BFS from the homepage, same-origin, link-reachable only)
// ---------------------------------------------------------------------------
async function fromCrawl(baseUrl, { depth = 1, maxPages = 100 } = {}) {
  const start = new URL(baseUrl);
  const origin = start.origin;
  const basePath = basePathOf(baseUrl);
  const startPath = cleanPath(start.pathname || '/');

  const seen = new Set([startPath]);
  const found = [startPath];
  let frontier = [startPath];

  for (let d = 0; d < depth && found.length < maxPages; d++) {
    const next = [];
    for (const p of frontier) {
      if (found.length >= maxPages) break;
      const html = await fetchText(new URL(p, origin).href);
      if (!html) continue;

      // Only follow real anchor links (<a href>). Matching bare `href=` also
      // catches <link rel="stylesheet">, preloads, icons, canonical, etc. —
      // which are assets, not pages (that's how /styles.scss crept in).
      const hrefs = [
        ...html.matchAll(/<a\b[^>]*?\shref\s*=\s*["']([^"']+)["']/gi),
      ].map((m) => m[1]);
      for (const rawHref of hrefs) {
        const href = (rawHref || '').trim();
        if (!href) continue;
        // Skip non-navigational + fragment-only links. `%23…` is a pre-encoded
        // `#…` — same-page anchors on SPAs — which must never become routes.
        if (/^(mailto:|tel:|javascript:|data:|#)/i.test(href)) continue;
        if (/^%23/i.test(href)) continue;
        let u;
        try {
          u = new URL(href, new URL(p, origin));
        } catch {
          continue;
        }
        if (u.origin !== origin) continue; // same-origin only
        const cp = cleanPath(u.pathname);
        if (cp.includes('#') || /%23/i.test(cp)) continue; // belt-and-braces
        if (!isAuditablePath(cp)) continue;
        if (!underBase(cp, basePath)) continue; // stay within the base path
        if (seen.has(cp)) continue;
        seen.add(cp);
        found.push(cp);
        next.push(cp);
        if (found.length >= maxPages) break;
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  return found;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover routes for a site.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl       Origin (+ optional base path) to discover from
 * @param {'auto'|'single'|'sitemap'|'crawl'} [opts.mode='auto']  auto = sitemap
 *   if present, else just the given URL. single = only the given URL.
 *   sitemap = sitemap only. crawl = follow homepage links (opt-in).
 * @param {number} [opts.crawlDepth=1]
 * @param {number} [opts.maxPages=100]
 * @param {string[]} [opts.exclude]   Glob patterns to drop (default embeds + sharecards)
 * @param {string[]} [opts.include]   If set, keep ONLY paths matching these globs
 * @param {string} [opts.waitFor='body']  Default waitFor for discovered routes
 * @param {Record<string, object>} [opts.overrides]  Per-path overrides
 * @param {Array<object>} [opts.extraRoutes]  Explicit routes appended verbatim
 * @returns {Promise<Array<{path:string,label:string,waitFor:string}>>}
 */
export async function discoverRoutes(opts = {}) {
  const {
    baseUrl,
    mode = 'auto',
    crawlDepth = 1,
    maxPages = 100,
    exclude = ['/embeds/**', '/sharecards/**'],
    include = [],
    waitFor = 'body',
    overrides = {},
    extraRoutes = [],
  } = opts;

  if (!baseUrl) {
    throw new Error('discoverRoutes: `baseUrl` is required.');
  }

  const basePath = basePathOf(baseUrl);
  const selfPath = cleanPath(new URL(baseUrl).pathname || '/');

  // Resolve the source paths (origin-absolute) per mode:
  //   auto    → sitemap if the site has one, else just the given URL
  //   sitemap → sitemap only (empty if none)
  //   single  → just the given URL
  //   crawl   → follow homepage links (opt-in; least predictable)
  let paths;
  let usedMode = mode;

  if (mode === 'crawl') {
    paths = await fromCrawl(baseUrl, { depth: crawlDepth, maxPages });
    usedMode = 'crawl';
  } else if (mode === 'single') {
    paths = [selfPath];
    usedMode = 'single';
  } else if (mode === 'sitemap') {
    paths = (await fromSitemap(baseUrl)) || [];
    usedMode = 'sitemap';
  } else {
    // auto: prefer a sitemap; otherwise audit only the URL you gave.
    const sm = await fromSitemap(baseUrl);
    if (sm && sm.length) {
      paths = sm;
      usedMode = 'sitemap';
    } else {
      paths = [selfPath];
      usedMode = 'single';
    }
  }

  // Paths are origin-absolute. Keep only those within the base path, then make
  // them RELATIVE to the base (the spec appends them to baseUrl, which already
  // contains the base path — otherwise the prefix would be duplicated). Apply
  // filters + labels on the relative path.
  const kept = [];
  const seen = new Set();
  for (const abs of paths) {
    if (!underBase(abs, basePath)) continue;
    const rel = toRelative(abs, basePath);
    if (!isAuditablePath(rel)) continue;
    if (include.length && !matchesAny(rel, include)) continue;
    if (exclude.length && matchesAny(rel, exclude)) continue;
    if (seen.has(rel)) continue;
    seen.add(rel);
    kept.push(rel);
  }
  kept.sort((a, b) => (a === '/' ? -1 : b === '/' ? 1 : a.localeCompare(b)));

  const routes = kept.map((p) => ({
    path: p,
    label: labelFromPath(p),
    waitFor,
    ...(overrides[p] || {}),
  }));

  // Append explicit extra routes (e.g. a hand-picked embed), de-duping by path.
  for (const extra of extraRoutes) {
    if (!extra || !extra.path) continue;
    if (routes.some((r) => r.path === extra.path)) continue;
    routes.push({
      label: labelFromPath(extra.path),
      waitFor,
      ...extra,
    });
  }

  return { routes, mode: usedMode };
}
