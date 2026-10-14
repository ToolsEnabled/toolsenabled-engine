// EXECUTABLE CHANGE
'use strict';
// TEST-CAN-FAIL REPORT (testcanfail-tests-owner-prompt-theme-test-js)
// STRENGTHENED: the three assertions in "an unknown theme name resolves to
// the default rather than throwing" now pin the independently specified
// default, `white`. Mutation: changed owner-prompt-theme.js's defaultTheme
// from `white` to `black`. Before this change the test remained green. After
// this change it exited 1 with:
//   FAIL an unknown theme name resolves to the default rather than throwing:
//   + actual - expected
//   + 'black'
//   - 'white'
// The source was then restored byte-for-byte. The restored run ended with:
//   owner-prompt-theme: 3 checks passed, 1 SKIPPED (did not run)
// PRECONDITION-NOT-MET: Mission Control's styles.css is not present in any
// candidate location in this checkout, so the explicitly reported cross-repo
// palette checks could not execute here.
// NOT-FOUND (1): no assertion loop can pass merely because a product-owned
// collection is empty; empty THEME_NAMES makes module validation fail during
// load, while the other iterated collections are non-empty test constants.
// NOT-FOUND (2): this test does not assert an exit status or truthy process
// return; it makes direct value assertions and aggregates thrown failures.
// NOT-FOUND (3): no assertion failure is swallowed by try/catch or optional
// chaining; check() records caught failures and sets process.exitCode to 1.
// NOT-FOUND (4): no mock stands in for owner-prompt-theme.js.
// NOT-FOUND (5): the unavailable cross-repository stylesheet is loudly
// reported and counted as skipped, and the local contract checks still run;
// there is no silent whole-file no-op guard.
// NOT-FOUND (6), after the fix below: no remaining expected assertion value is
// computed by the same product code whose behavior that assertion checks.
// Proves the engine's owner-prompt palette still equals Mission Control's
// stylesheet.
//
// src/lib/owner-prompt-theme.js transcribes colours that are authored in the
// app's src/styles.css.  Two hand-maintained copies of one palette is exactly
// how the credential dialog ended up lavender while the product was teal, so
// the copy is checked rather than trusted: this parses the real stylesheet and
// fails on any disagreement.
//
// WHEN THE STYLESHEET IS NOT REACHABLE THIS REPORTS SKIPPED, NOT PASSED.
// The app lives in a separate tree that is not guaranteed to be checked out
// beside the engine.  A drift check that silently passes when it cannot see
// the other side is worse than no check -- it reports a verification that did
// not happen, which is the defect family this project keeps finding.  Skips
// are printed loudly and counted separately from passes.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const theme = require('../src/lib/owner-prompt-theme.js');

// Manifest key -> the custom property that authors it in styles.css.
const THEME_TOKEN_SOURCE = Object.freeze({
  bg: '--bg',
  bg2: '--bg-2',
  surface: '--surface',
  sheet: '--sheet',
  ink: '--ink',
  ink2: '--ink-2',
  ink25: '--ink-25',
  ink3: '--ink-3',
  line: '--line',
  line2: '--line-2',
  good: '--s-good',
  serious: '--s-serious'
});

const ROLE_TOKEN_SOURCE = Object.freeze({
  coordinator: '--c-coordinator',
  helper: '--c-helper',
  shadow: '--c-shadow',
  manager: '--c-manager'
});

// onAccent is deliberately absent here. owner-popup.css writes it as
// var(--sheet), which is per-theme, while the manifest contract puts it in
// theme-independent `common`. It is asserted separately against the white
// theme's sheet, which is the surface an accent fill is drawn on.
const COMMON_TOKEN_SOURCE = Object.freeze({
  accent: '--c-coordinator',
  accentFloor: '--accent-2',
  focus: '--focus-ring'
});

const METRIC_TOKEN_SOURCE = Object.freeze({
  radiusSmall: '--r-sm',
  radiusMedium: '--r-md',
  radiusLarge: '--r-lg',
  space1: '--s1',
  space2: '--s2',
  space3: '--s3',
  space4: '--s4',
  space5: '--s5'
});

function stylesheetCandidates() {
  const fromEnv = process.env.MISSION_CONTROL_STYLES;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return [
    ...(fromEnv ? [fromEnv] : []),
    path.join(home, 'Desktop', 'wt-installer', 'src', 'styles.css'),
    path.join(home, 'Desktop', 'mission-control', 'src', 'styles.css'),
    path.join(__dirname, '..', '..', 'wt-installer', 'src', 'styles.css'),
    path.join(__dirname, '..', '..', 'mission-control', 'src', 'styles.css')
  ];
}

function findStylesheet() {
  for (const candidate of stylesheetCandidates()) {
    try { if (fs.statSync(candidate).isFile()) return candidate; }
    catch { /* try the next candidate */ }
  }
  return null;
}

// Read one selector's declaration block. Selectors are matched at a line start
// so `:root {` does not also match `:root[data-theme="tan"] {`.
function blocks(css, selector) {
  const found = [];
  const needle = `\n${selector} {`;
  let at = css.indexOf(needle);
  while (at !== -1) {
    const open = css.indexOf('{', at);
    const close = css.indexOf('\n}', open);
    if (close === -1) break;
    found.push(css.slice(open + 1, close));
    at = css.indexOf(needle, close);
  }
  return found;
}

function declarations(text) {
  const out = new Map();
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    // Strip trailing block comments authors put after a value.
    const value = match[2].replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (value) out.set(match[1], value);
  }
  return out;
}

function effectiveTokens(css, themeName) {
  const base = new Map();
  for (const block of blocks(css, ':root')) {
    for (const [key, value] of declarations(block)) base.set(key, value);
  }
  for (const block of blocks(css, `:root[data-theme="${themeName}"]`)) {
    for (const [key, value] of declarations(block)) base.set(key, value);
  }
  return base;
}

let passed = 0;
let skipped = 0;
const failures = [];

function check(name, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { failures.push({ name, error }); console.log(`  FAIL ${name}: ${error.message}`); }
}

const stylesheet = findStylesheet();

if (!stylesheet) {
  skipped += 1;
  console.log('  SKIPPED  owner-prompt palette matches Mission Control styles.css');
  console.log('           Mission Control stylesheet not found. Looked in:');
  for (const candidate of stylesheetCandidates()) console.log(`             ${candidate}`);
  console.log('           Set MISSION_CONTROL_STYLES to the app stylesheet to run this check.');
  console.log('           THIS CHECK DID NOT RUN. It is not a pass.');
} else {
  console.log(`  using stylesheet: ${stylesheet}`);
  const css = fs.readFileSync(stylesheet, 'utf8');
  const manifest = theme.themeManifest();

  for (const themeName of theme.THEME_NAMES) {
    check(`themes.${themeName} matches styles.css`, () => {
      const tokens = effectiveTokens(css, themeName);
      assert.ok(tokens.size > 0, `no custom properties parsed for ${themeName}; the parser or the stylesheet shape changed`);
      for (const [key, property] of Object.entries(THEME_TOKEN_SOURCE)) {
        const authored = tokens.get(property);
        assert.ok(authored !== undefined, `${property} is not authored for theme ${themeName}`);
        assert.strictEqual(
          manifest.themes[themeName][key].replace(/\s+/g, ' '),
          authored.replace(/\s+/g, ' '),
          `themes.${themeName}.${key} is "${manifest.themes[themeName][key]}" but styles.css authors ${property} as "${authored}"`
        );
      }
    });
  }

  check('roles match styles.css', () => {
    const tokens = effectiveTokens(css, 'white');
    for (const [key, property] of Object.entries(ROLE_TOKEN_SOURCE)) {
      assert.strictEqual(manifest.roles[key], tokens.get(property),
        `roles.${key} disagrees with ${property}`);
    }
  });

  check('common accent/floor/focus match styles.css', () => {
    const tokens = effectiveTokens(css, 'white');
    for (const [key, property] of Object.entries(COMMON_TOKEN_SOURCE)) {
      assert.strictEqual(manifest.common[key], tokens.get(property),
        `common.${key} disagrees with ${property}`);
    }
  });

  check('common.onAccent equals the white sheet it is drawn against', () => {
    assert.strictEqual(manifest.common.onAccent, manifest.themes.white.sheet,
      'onAccent must equal the white theme sheet');
  });

  check('metrics match styles.css pixel scales', () => {
    const tokens = effectiveTokens(css, 'white');
    for (const [key, property] of Object.entries(METRIC_TOKEN_SOURCE)) {
      const authored = tokens.get(property);
      assert.ok(authored !== undefined, `${property} is not authored`);
      const pixels = Number.parseFloat(String(authored).replace('px', ''));
      assert.strictEqual(manifest.metrics[key], pixels,
        `metrics.${key} is ${manifest.metrics[key]} but ${property} is ${authored}`);
    }
  });

  check('fonts.ui and fonts.mono match styles.css', () => {
    const tokens = effectiveTokens(css, 'white');
    assert.strictEqual(manifest.fonts.ui.replace(/\s+/g, ' '), tokens.get('--font-ui').replace(/\s+/g, ' '));
    assert.strictEqual(manifest.fonts.mono.replace(/\s+/g, ' '), tokens.get('--font-mono').replace(/\s+/g, ' '));
  });
}

// Contract checks that need no stylesheet, so they always run.
check('native themes follow the requesting runtime preferences before its cached shell theme', () => {
  const isolated = require('./lib/isolated-environment').activate('owner-prompt-theme');
  const userData = path.join(isolated.root, 'theme-runtime', 'ToolsEnabled-Live');
  const stateRoot = path.join(userData, 'capability');
  fs.mkdirSync(stateRoot, { recursive: true });
  const prefs = path.join(userData, 'renderer-prefs.json');
  const cached = path.join(userData, 'shell-state.json');
  const env = { ...process.env, TOOLSENABLED_STATE_ROOT: stateRoot };
  fs.writeFileSync(cached, JSON.stringify({ theme: 'tan' }));
  for (const name of ['black', 'white', 'tan']) {
    fs.writeFileSync(prefs, JSON.stringify({ version: 1, values: { 'mc.theme': name } }));
    assert.strictEqual(theme.resolveRuntimeTheme({ env }).name, name);
  }
  fs.writeFileSync(prefs, JSON.stringify({ version: 1, values: { 'mc.theme': 'black' } }));
  if (process.platform === 'win32') {
    const { execFileSync } = require('node:child_process');
    const script = path.join(__dirname, '..', 'tools', 'owner-prompt-theme.ps1').replace(/'/g, "''");
    const answer = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `. '${script}'; $r = Get-OwnerPromptTheme; [pscustomobject]@{name=$r.Theme.name;bg=$r.Theme.bg;degraded=$r.Degraded} | ConvertTo-Json -Compress`],
    { env, windowsHide: true, encoding: 'utf8', timeout: 15000 });
    const native = JSON.parse(answer.trim());
    assert.strictEqual(native.name, 'black');
    assert.strictEqual(native.bg, '#212327');
    assert.strictEqual(native.degraded, false);
  }
  fs.unlinkSync(prefs);
  assert.strictEqual(theme.resolveRuntimeTheme({ env }).name, 'tan');
  fs.unlinkSync(cached);
  assert.strictEqual(theme.resolveRuntimeTheme({ env }).name, 'white');
  assert.strictEqual(theme.resolveRuntimeTheme({ env: {} }).name, 'white');
});

check('the manifest satisfies the renderer contract', () => {
  theme.assertManifest(theme.themeManifest());
});

check('an unknown theme name resolves to the default rather than throwing', () => {
  // `resolveTheme` and `themeManifest` are implemented from the same manifest.
  // Comparing one with the other cannot detect an accidental change to the
  // product's canonical default, so pin both sides of this public contract to
  // the independently expected theme name.
  assert.strictEqual(theme.themeManifest().defaultTheme, 'white');
  assert.strictEqual(theme.resolveTheme('not-a-theme').name, 'white');
  assert.strictEqual(theme.resolveTheme(undefined).name, 'white');
});

check('white text on the accent fill would fail AA, so accentFloor is the button fill', () => {
  // Guards a real accessibility trap. The role palette is built to a 3:1
  // NON-TEXT floor, so #008dab under white text measures about 3.9:1 -- fine
  // for a mark, short of the 4.5:1 normal-text floor for a button label.
  // accentFloor is the darker step that clears it. If someone lightens either
  // token, this fails rather than shipping an unreadable button.
  const luminance = hex => {
    const channel = value => {
      const srgb = value / 255;
      return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
    };
    const r = Number.parseInt(hex.slice(1, 3), 16);
    const g = Number.parseInt(hex.slice(3, 5), 16);
    const b = Number.parseInt(hex.slice(5, 7), 16);
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const manifest = theme.themeManifest();
  const onFloor = ratio(manifest.common.onAccent, manifest.common.accentFloor);
  assert.ok(onFloor >= 4.5,
    `onAccent on accentFloor is ${onFloor.toFixed(2)}:1, below the 4.5:1 normal-text floor`);
});

console.log('');
if (failures.length) {
  console.log(`owner-prompt-theme: ${failures.length} FAILED, ${passed} passed, ${skipped} skipped`);
  process.exitCode = 1;
} else {
  console.log(`owner-prompt-theme: ${passed} checks passed${skipped ? `, ${skipped} SKIPPED (did not run)` : ''}`);
}
