/**
 * Spectre routes — EXAMPLE / STARTER FILE.
 *
 * Copy this into your project root as `spectre.routes.ts` (or point
 * SPECTRE_ROUTES / package.json "spectre.routes" at it) and edit the list to
 * match YOUR app. Spectre imports whatever this module exports as `ROUTES`
 * (a default export also works). The routes below are a realistic sample from
 * a Reuters graphics app — replace them with your own.
 *
 * Quickstart:
 *   cp node_modules/@reuters-graphics/browserstack-ui-audit/routes.example.ts \
 *      ./spectre.routes.ts
 *
 * Add or remove entries here — the audit spec loops through all of them.
 *
 * Each route declares:
 *   - `path`: the URL path (joined with BASE_URL at runtime)
 *   - `label`: human-readable name (used in report + screenshot filenames)
 *   - `waitFor`: a CSS selector that must be visible before we screenshot
 *   - `interactions`: optional list of post-load interactions, each producing
 *                     an extra screenshot (e.g. open a menu, switch a tab)
 */

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

/**
 * NOTE: Replace `<MATCH_SLUG>` and `<TEAM_SLUG>` placeholders with real slugs
 * from the deployed preview before running. The audit spec will skip routes
 * that still contain `<…>` markers and log a warning.
 */
export const ROUTES: Route[] = [
  // --- App pages -------------------------------------------------------------
  {
    path: '/',
    label: 'home',
    waitFor: 'main',
    interactions: [
      { name: 'menu-open', click: '[data-test="menu-toggle"]', pause: 400 },
    ],
  },
  {
    path: '/groups/',
    label: 'groups',
    waitFor: '.group-table, [data-test="group-table"]',
  },
  {
    path: '/groups/standings/',
    label: 'groups-standings',
    waitFor: '.group-table, [data-test="group-table"]',
  },
  {
    path: '/groups/results/',
    label: 'groups-results',
    waitFor: '.group-table, [data-test="group-table"]',
  },
  {
    path: '/knockouts/',
    label: 'knockouts',
    waitFor: 'main',
    settleMs: 1500,
  },
  {
    path: '/schedule/',
    label: 'schedule',
    waitFor: 'main',
  },

  // --- Match + team pages (fill in real slugs!) -----------------------------
  {
    path: '/matches/<MATCH_SLUG>/',
    label: 'match-detail',
    waitFor: 'main',
  },
  {
    path: '/teams/<TEAM_SLUG>/',
    label: 'team-detail',
    waitFor: 'main',
  },

  // --- Embeds ----------------------------------------------------------------
  {
    path: '/embeds/en/matches-widget/',
    label: 'embed-matches-widget',
    waitFor: 'main, .matches-widget',
  },
  {
    path: '/embeds/en/groups/',
    label: 'embed-groups',
    waitFor: '.group-table, [data-test="group-table"]',
  },
  {
    path: '/embeds/en/bracket/',
    label: 'embed-bracket',
    waitFor: 'main',
    settleMs: 1500,
  },
];
