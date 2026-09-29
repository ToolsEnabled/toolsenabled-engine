'use strict';

// A TOOL PACK IS A SET OF TOOL DEFINITIONS THIS PRODUCT DOES NOT SHIP.
//
// WHY THIS EXISTS. The installer payload is DERIVED: tools/pack-capability-layer.mjs
// walks literal require() calls from tools/mission-bridge.js and src/mcp-server.js
// and stages exactly what it reaches. src/lib/tool-registry.js sits one hop from
// both, and it used to require() every provider module in the tree at the top of
// the file. So "is this file in the shipped product" had exactly one answer for
// every provider: yes. That is how a module built to handle a private personal
// document ended up inside a payload about to be published as open source.
//
// The only honest fix is to change the GRAPH. A computed require() would hide the
// file from the packer while still loading it at runtime -- the packer refuses
// those on purpose, and that refusal is not to be weakened. So the definitions
// that must not ship move OUT of the registry into a pack, and the pack is
// require()d by a program that is not a payload entrypoint (see
// src/lib/tool-packs/index.js for who loads them). In the payload no pack is
// registered, this file's list is empty, and the registry is exactly its core.
//
// ORDERING IS THE ONE RULE, AND IT FAILS LOUD. A pack must be require()d BEFORE
// src/lib/tool-registry.js is first require()d, because TOOL_REGISTRY is frozen
// at module load and P13_ACTION_CATALOG is derived from it immediately after. A
// pack that registers later would be silently absent -- the tool would simply not
// exist, and the caller would see UnknownToolError with nothing to explain it. So
// registering after the registry has consumed the list THROWS. The one exception
// is re-registration of a pack that was already consumed, which is what a test
// clearing the require cache does, and which changes nothing.
//
// PACKS CANNOT WIDEN THE SECURITY SURFACE. They do not get a private path into the
// registry: their definitions are built with the same define() every core tool
// uses, so the effect-classification refusal, the approval defaults, the MCP
// annotations and validateRegistry()'s duplicate/name checks all apply unchanged.
// A pack cannot redefine a core tool -- validateRegistry() rejects the duplicate.

const packs = new Map();
const consumedNames = new Set();
let consumed = false;

function assertPackShape(pack) {
  if (!pack || typeof pack !== 'object') throw new TypeError('A tool pack must be an object.');
  if (typeof pack.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pack.name)) {
    throw new TypeError(`A tool pack needs a lowercase-dashed name; got ${JSON.stringify(pack.name)}.`);
  }
  if (typeof pack.definitions !== 'function') {
    throw new TypeError(`Tool pack '${pack.name}' must expose definitions(api) returning an array of define() results.`);
  }
  if (pack.p13SemanticOverrides !== undefined
    && (typeof pack.p13SemanticOverrides !== 'object' || pack.p13SemanticOverrides === null || Array.isArray(pack.p13SemanticOverrides))) {
    throw new TypeError(`Tool pack '${pack.name}' p13SemanticOverrides must be a plain object when present.`);
  }
}

function registerToolPack(pack) {
  assertPackShape(pack);
  if (consumed && !consumedNames.has(pack.name)) {
    throw new Error(
      `Tool pack '${pack.name}' registered after src/lib/tool-registry.js was already built. `
      + 'TOOL_REGISTRY is frozen at module load, so this pack\'s tools would not exist at all. '
      + 'Load the pack before the registry -- see src/lib/tool-packs/index.js.'
    );
  }
  packs.set(pack.name, Object.freeze({
    name: pack.name,
    definitions: pack.definitions,
    p13SemanticOverrides: Object.freeze({ ...(pack.p13SemanticOverrides || {}) })
  }));
}

// Called exactly once per load of src/lib/tool-registry.js, with the schema and
// define() helpers a pack needs. Returns everything the registry has to merge, so
// the registry never reaches back into this module afterwards.
function consumeToolPacks(api) {
  if (!api || typeof api.define !== 'function') {
    throw new TypeError('consumeToolPacks(api) needs the registry helper bundle, including define().');
  }
  const definitions = [];
  const p13SemanticOverrides = {};
  for (const pack of packs.values()) {
    const produced = pack.definitions(api);
    if (!Array.isArray(produced)) {
      throw new TypeError(`Tool pack '${pack.name}' definitions(api) must return an array; got ${typeof produced}.`);
    }
    for (const entry of produced) definitions.push(entry);
    // A pack may only carry P13 semantics for tools IT defines. Without this,
    // "packs cannot widen the security surface" would rest on a comment: a pack
    // could name a core tool here and downgrade its policyKind from, say,
    // secret-access to tool-dispatch, and nothing would notice, because the
    // duplicate-name rule governs DEFINITIONS only.
    const producedNames = new Set(produced.map((entry) => entry && entry.name));
    for (const [name, semantics] of Object.entries(pack.p13SemanticOverrides)) {
      if (!producedNames.has(name)) {
        throw new Error(
          `Tool pack '${pack.name}' declares P13 semantics for '${name}', which it does not define. `
          + 'A pack may only carry semantics for its own tools; it must never restate or relax a core mapping.'
        );
      }
      p13SemanticOverrides[name] = semantics;
    }
    consumedNames.add(pack.name);
  }
  consumed = true;
  return { definitions, p13SemanticOverrides, names: [...packs.keys()] };
}

function registeredPackNames() { return [...packs.keys()]; }

// Test seam only. Mirrors audit.js's resetForTests() convention: a suite that
// wants to prove the empty-pack (shipped) shape must be able to get back to it
// without spawning a second process.
function resetForTests() {
  packs.clear();
  consumedNames.clear();
  consumed = false;
}

module.exports = Object.freeze({ registerToolPack, consumeToolPacks, registeredPackNames, resetForTests });
