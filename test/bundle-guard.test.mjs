import assert from "node:assert/strict";
import test from "node:test";
import { verifyBundle } from "../scripts/bundle-guard.mjs";

const meta = (inputs, imports = []) => ({ inputs: Object.fromEntries(inputs.map((name) => [name, {}])), outputs: { out: { imports } } });
const safe = "function createSupervisor({ env = process.env }) {}";

test("bundle guard rejects unlisted, nested and external dependencies", () => {
  verifyBundle(meta(["src/main.mjs", "node_modules/ws/index.js"], [{ external: true, path: "node:fs" }]), safe);
  assert.throws(() => verifyBundle(meta(["node_modules/unknown/index.js"]), safe), /unexpected_bundle_dependency/);
  assert.throws(() => verifyBundle(meta(["../node_modules/ws/index.js"]), safe), /unexpected_bundle_input/);
  assert.throws(() => verifyBundle(meta(["node_modules/ws/node_modules/unknown/index.js"]), safe), /unexpected_bundle_dependency/);
  assert.throws(() => verifyBundle(meta(["src/main.mjs"], [{ external: true, path: "bufferutil" }]), safe), /unexpected_external_dependency/);
});

test("bundle guard rejects additional environment access patterns", () => {
  for (const extra of ["process.env.X", "process.env?.X", "process?.env", "process['env']", "process?.['env']",
    "Object.keys(process.env)", "const { X } = process.env", "const p = require('node:process')",
    "const { env } = process", "const p = process; p.env.X", "process[`env`]"]) {
    assert.throws(() => verifyBundle(meta(["src/main.mjs"]), `${safe}; ${extra}`), /unexpected_bundle_environment_read/);
  }
});


test("bundle guard rejects runtime-selected imports", () => {
  assert.throws(() => verifyBundle(meta(["src/main.mjs"]), `${safe}; try { require(name) } catch {}`), /dynamic_bundle_import/);
  assert.throws(() => verifyBundle(meta(["src/main.mjs"]), `${safe}; import(name)`), /dynamic_bundle_import/);
});
