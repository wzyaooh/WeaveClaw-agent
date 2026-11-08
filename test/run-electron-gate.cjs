const { spawnSync } = require("node:child_process");
const path = require("node:path");

if (!process.env.ELECTRON_BIN) {
  console.error("请通过 ELECTRON_BIN 指定 Electron 可执行文件");
  process.exit(1);
}
for (const gate of ["electron-gate.cjs", "electron-transport-gate.cjs", "electron-supervisor-gate.cjs"]) {
  const result = spawnSync(process.env.ELECTRON_BIN, [path.join(__dirname, gate)], { stdio: "inherit", timeout: 45000 });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
