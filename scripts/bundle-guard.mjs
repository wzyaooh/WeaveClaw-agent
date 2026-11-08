import { builtinModules, isBuiltin } from "node:module";

const allowed = ["ws", "@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-schema",
  "@earendil-works/pi-telemetry", "partial-json"];

export function verifyBundle(metafile, text) {
  for (const input of Object.keys(metafile.inputs)) {
    if (input.startsWith("disabled-native:")) continue;
    if (!input.startsWith("node_modules/")) {
      if (!input.startsWith("src/")) throw new Error("unexpected_bundle_input");
      continue;
    }
    const dependency = input.slice(input.lastIndexOf("node_modules/") + "node_modules/".length);
    if (!allowed.some((name) => dependency.startsWith(name + "/"))) throw new Error("unexpected_bundle_dependency");
  }
  for (const output of Object.values(metafile.outputs)) {
    for (const dependency of output.imports) {
      if (dependency.external && !isBuiltin(dependency.path) && !builtinModules.includes(dependency.path)) {
        throw new Error("unexpected_external_dependency");
      }
    }
  }
  const references = [...text.matchAll(/\bprocess\s*(?:\?\.|\.)\s*env\b/g)];
  if (references.length !== 1 || !/\benv\s*=\s*process\.env\b/.test(text) ||
      /\bprocess\s*(?:\?\.)?\s*\[\s*["'`]env["'`]\s*\]/.test(text) ||
      /\{[^}]*\benv\b[^}]*\}\s*=\s*(?:globalThis\.)?process\b/.test(text) ||
      /=\s*(?:globalThis\.)?process\s*[;,)]/.test(text) ||
      /(?:require\s*\(|from\s*)["'](?:node:)?process["']/.test(text)) {
    throw new Error("unexpected_bundle_environment_read");
  }
  if (/\b(?:require|import)\s*\((?!\s*["'])/.test(text)) throw new Error("dynamic_bundle_import");
}
