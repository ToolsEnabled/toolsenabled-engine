'use strict';
// The canonical visual identity for every owner prompt, on every surface.
//
// WHY THIS EXISTS AT ALL, AND WHY IT LIVES ON THIS SIDE
//
// An owner prompt is the surface that asks for a card number and for spend
// approval, so its appearance is a security property rather than decoration.
// If the popup took its colours from whatever the page happened to define,
// anything that could influence the renderer could also make an unofficial
// dialog look official.  So the palette is served from the trusted side and
// the renderer pins to it -- Mission Control's src/owner-popup.js validates
// this exact shape and refuses to draw when it does not arrive.
//
// THE DEFECT THIS CLOSES
//
// Mission Control ships a complete, styled, tested in-app owner popup:
// mounted in index.html, dressed by src/owner-popup.css, and it requires a
// snapshot of {ok, schemaVersion, generatedAt, theme, prompts}.  Nothing on
// this side ever produced one -- there was no /v1/owner-prompts route and no
// theme manifest anywhere in the engine.  The renderer therefore failed its
// own validation on every poll and displayed "The owner prompt service is
// unavailable", which reads like a service that is merely down rather than a
// feature that was never connected.  Every prompt consequently fell back to
// the native dialog, and the owner refused to type a card into it because it
// did not look like the product.  He was right; it did not.
//
// DRIFT IS THE REAL RISK, SO THE VALUES ARE TESTED, NOT TRUSTED
//
// These values are transcribed from Mission Control's src/styles.css.  A
// second hand-maintained palette is exactly how two surfaces of one product
// stop matching, so tests/owner-prompt-theme.test.js parses that stylesheet
// and fails on any disagreement.  When the stylesheet is not reachable, that
// test reports SKIPPED rather than passing -- an unverifiable claim must not
// look like a verified one.
//
// Change a colour in styles.css and this file must change with it.  That is
// the intended cost: one palette, enforced, instead of two that drift.

const SCHEMA_VERSION = 1;
const THEME_NAMES = Object.freeze(['white', 'tan', 'black']);

// Native surfaces (the WinForms credential dialog) cannot load the bundled
// variable webfonts, so they get an installed-font ladder that keeps the same
// typographic register. IBM Plex Sans first when present; otherwise the Windows 11
// UI face; otherwise plain Segoe.  Listing them here rather than in the
// dialog keeps one answer to "what does this product look like".
const FONTS = Object.freeze({
  ui: '"IBM Plex Sans Variable", "IBM Plex Sans", "Segoe UI Variable", system-ui, sans-serif',
  mono: '"JetBrains Mono Variable", ui-monospace, monospace',
  nativeUiFamilies: Object.freeze(['IBM Plex Sans', 'Segoe UI Variable Text', 'Segoe UI']),
  nativeMonoFamilies: Object.freeze(['JetBrains Mono', 'Cascadia Mono', 'Consolas'])
});

// Tight radii and a 4px spacing step are deliberate: this product reads as
// clinical instrument, not as a consumer card stack.
const METRICS = Object.freeze({
  radiusSmall: 2,
  radiusMedium: 3,
  radiusLarge: 3,
  space1: 4,
  space2: 8,
  space3: 12,
  space4: 16,
  space5: 24
});

const ROLES = Object.freeze({
  coordinator: '#41859c',
  helper: '#b46b4d',
  shadow: '#468777',
  manager: '#7771c1'
});

// accentFloor is the pressed/active step beneath accent, and onAccent is the
// only colour permitted on top of an accent fill.
const COMMON = Object.freeze({
  accent: '#41859c',
  accentFloor: '#007892',
  focus: '#007d98',
  onAccent: '#ffffff'
});

const THEMES = Object.freeze({
  white: Object.freeze({
    bg: '#f7f8fa',
    bg2: '#eef1f5',
    surface: '#f7f8fa',
    sheet: '#ffffff',
    ink: '#0e1726',
    ink2: '#4f5f70',
    ink25: '#5a6876',
    ink3: '#64727f',
    line: 'rgba(14, 23, 38, 0.07)',
    line2: 'rgba(14, 23, 38, 0.12)',
    good: '#198038',
    serious: '#da1e28'
  }),
  tan: Object.freeze({
    bg: '#f2e5bc',
    bg2: '#ebdbb2',
    surface: '#f2e5bc',
    sheet: '#fbf1c7',
    ink: '#282828',
    ink2: '#3c3836',
    ink25: '#504945',
    ink3: '#665c54',
    line: 'rgba(40, 40, 40, 0.10)',
    line2: 'rgba(40, 40, 40, 0.17)',
    good: '#0e6027',
    serious: '#a2191f'
  }),
  black: Object.freeze({
    bg: '#212327',
    bg2: '#292b30',
    surface: '#212327',
    sheet: '#2e3136',
    ink: '#f5f1ee',
    ink2: '#cabdb7',
    ink25: '#b9aaa2',
    ink3: '#a6968e',
    line: 'rgba(255, 226, 218, 0.09)',
    line2: 'rgba(255, 226, 218, 0.155)',
    good: '#42be65',
    serious: '#fa4d56'
  })
});

const MANIFEST = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  defaultTheme: 'white',
  fonts: FONTS,
  metrics: METRICS,
  roles: ROLES,
  common: COMMON,
  themes: THEMES
});

// The renderer's validator rejects unknown keys as well as missing ones, so a
// well-meant extra field here would blank the popup in the field rather than
// fail here.  Assert the shape at module load: a shape error becomes a startup
// failure on this side instead of a silent "unavailable" on the owner's screen.
const REQUIRED_THEME_KEYS = Object.freeze([
  'bg', 'bg2', 'surface', 'sheet', 'ink', 'ink2', 'ink25', 'ink3',
  'line', 'line2', 'good', 'serious'
]);
const REQUIRED_COMMON_KEYS = Object.freeze(['accent', 'accentFloor', 'focus', 'onAccent']);
const REQUIRED_METRIC_KEYS = Object.freeze([
  'radiusSmall', 'radiusMedium', 'radiusLarge',
  'space1', 'space2', 'space3', 'space4', 'space5'
]);
const REQUIRED_ROLE_KEYS = Object.freeze(['coordinator', 'helper', 'shadow', 'manager']);

function exactKeys(value, required, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...required].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`owner prompt theme: ${label} keys are ${actual.join(',')} but must be exactly ${wanted.join(',')}`);
  }
}

// Mirrors the renderer's safeCssToken. A value carrying ; { } < > could break
// out of the declaration it is written into once this reaches a stylesheet.
function safeToken(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 160 || /[;{}<>\u0000-\u001f]/.test(value)) {
    throw new Error(`owner prompt theme: ${label} is not a safe visual token`);
  }
}

function assertManifest(manifest) {
  exactKeys(manifest, ['schemaVersion', 'defaultTheme', 'fonts', 'metrics', 'roles', 'common', 'themes'], 'manifest');
  exactKeys(manifest.fonts, ['ui', 'mono', 'nativeUiFamilies', 'nativeMonoFamilies'], 'fonts');
  exactKeys(manifest.metrics, REQUIRED_METRIC_KEYS, 'metrics');
  exactKeys(manifest.roles, REQUIRED_ROLE_KEYS, 'roles');
  exactKeys(manifest.common, REQUIRED_COMMON_KEYS, 'common');
  exactKeys(manifest.themes, THEME_NAMES, 'themes');
  if (manifest.schemaVersion !== SCHEMA_VERSION) throw new Error('owner prompt theme: schemaVersion must be 1');
  if (!THEME_NAMES.includes(manifest.defaultTheme)) throw new Error('owner prompt theme: defaultTheme is not a known theme');
  for (const key of ['ui', 'mono']) safeToken(manifest.fonts[key], `fonts.${key}`);
  for (const key of ['nativeUiFamilies', 'nativeMonoFamilies']) {
    const list = manifest.fonts[key];
    if (!Array.isArray(list) || list.length < 1 || list.length > 8) throw new Error(`owner prompt theme: fonts.${key} is malformed`);
    list.forEach((value, index) => safeToken(value, `fonts.${key}[${index}]`));
  }
  for (const key of REQUIRED_METRIC_KEYS) {
    const value = manifest.metrics[key];
    if (!Number.isFinite(value) || value < 0 || value > 96) throw new Error(`owner prompt theme: metrics.${key} is malformed`);
  }
  for (const key of REQUIRED_ROLE_KEYS) safeToken(manifest.roles[key], `roles.${key}`);
  for (const key of REQUIRED_COMMON_KEYS) safeToken(manifest.common[key], `common.${key}`);
  for (const name of THEME_NAMES) {
    exactKeys(manifest.themes[name], REQUIRED_THEME_KEYS, `themes.${name}`);
    for (const key of REQUIRED_THEME_KEYS) safeToken(manifest.themes[name][key], `themes.${name}.${key}`);
  }
  return manifest;
}

assertManifest(MANIFEST);

function themeManifest() {
  return MANIFEST;
}

// Resolve one theme's flat palette for a surface that cannot evaluate CSS
// custom properties -- the native dialog asks for this. An unknown or absent
// name resolves to the default rather than throwing: the owner is mid-prompt
// and a readable dialog in the wrong theme beats no dialog at all.
function resolveTheme(name) {
  const selected = THEME_NAMES.includes(name) ? name : MANIFEST.defaultTheme;
  return Object.freeze({
    name: selected,
    ...MANIFEST.themes[selected],
    ...MANIFEST.common,
    roles: MANIFEST.roles,
    metrics: MANIFEST.metrics,
    fonts: MANIFEST.fonts
  });
}

// Native prompts belong to the runtime that requested them. Electron publishes
// <userData>/capability; its renderer-prefs.json is also the boot theme's source.
// Never discover another installation's preferences through ambient APPDATA.
function resolveRuntimeTheme({ env = process.env } = {}) {
  const fs = require('node:fs');
  const path = require('node:path');
  const configured = env.TOOLSENABLED_STATE_ROOT;
  if (!configured) return resolveTheme();
  const boundary = require('./account-profile-boundary');
  const profileRoot = boundary.installationProfileRoot();
  const checked = value => boundary.assertAccountProfilePath(value, {
    profileRoot, requireOwnedProfile: true, field: 'owner prompt theme'
  });
  const stateRoot = checked(configured);
  if (path.basename(stateRoot).toLowerCase() !== 'capability') return resolveTheme();
  const userData = path.dirname(stateRoot);
  const read = name => {
    const file = checked(path.join(userData, name));
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  };
  const stored = read('renderer-prefs.json')?.values?.['mc.theme'];
  if (THEME_NAMES.includes(stored)) return resolveTheme(stored);
  return resolveTheme(read('shell-state.json')?.theme);
}

module.exports = Object.freeze({
  SCHEMA_VERSION,
  THEME_NAMES,
  REQUIRED_THEME_KEYS,
  REQUIRED_COMMON_KEYS,
  REQUIRED_METRIC_KEYS,
  REQUIRED_ROLE_KEYS,
  themeManifest,
  resolveTheme,
  resolveRuntimeTheme,
  assertManifest
});
