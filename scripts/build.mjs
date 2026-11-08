import { build, formatMessages } from "esbuild";
import { verifyBundle } from "./bundle-guard.mjs";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const disabledNative = {
  name: "disable-optional-native",
  setup(context) {
    context.onResolve({ filter: /^(bufferutil|utf-8-validate)$/ }, (args) => ({ path: args.path, namespace: "disabled-native" }));
    context.onLoad({ filter: /.*/, namespace: "disabled-native" }, () => ({ contents: 'throw new Error("optional native module disabled")', loader: "js" }));
  },
};
const result = await build({ absWorkingDir: root, entryPoints: ["src/main.mjs"], outfile: "dist/orchestrator.cjs",
  bundle: true, platform: "node", target: "node22", format: "cjs", sourcemap: false,
  define: { "process.env.WS_NO_BUFFER_UTIL": '"1"', "process.env.WS_NO_UTF_8_VALIDATE": '"1"' },
  plugins: [disabledNative], metafile: true, write: false, logLevel: "silent" });
if (result.warnings.length) throw new Error((await formatMessages(result.warnings, { kind: "warning" })).join("\n"));
const output = result.outputFiles[0];
verifyBundle(result.metafile, output.text);
await mkdir(path.join(root, "dist"), { recursive: true });
await writeFile(path.join(root, "dist/orchestrator.cjs"), output.contents);
console.log(`构建完成：dist/orchestrator.cjs（${output.contents.length} 字节）`);
