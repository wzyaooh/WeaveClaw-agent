const { app, utilityProcess } = require("electron");
const path = require("node:path");

app.whenReady().then(() => {
  const child = utilityProcess.fork(path.join(__dirname, "electron-gate-child.mjs"), [], { stdio: "pipe" });
  let result;
  const timeout = setTimeout(() => { child.kill(); console.error("Pi utilityProcess 验证超时"); app.exit(1); }, 30000);
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
  child.on("message", (message) => {
    if (result) return;
    result = message;
    child.postMessage({ acknowledged: true });
  });
  child.on("exit", (code) => {
    clearTimeout(timeout);
    if (result && !result.ok) { console.error(result.error); app.exit(1); return; }
    if (!result || code !== 0) { console.error(`Pi utilityProcess 退出异常：${code}`); app.exit(1); return; }
    const [major, minor] = result.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 19)) { console.error("Electron Node 版本不满足 Pi 要求"); app.exit(1); return; }
    console.log(JSON.stringify({ ...result, electron: process.versions.electron }));
    app.exit(result.ok ? 0 : 1);
  });
}).catch((error) => { console.error(error); app.exit(1); });
