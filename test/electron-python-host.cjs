/** Development gate: only a synthetic test token reaches this parent process. */
const { app, utilityProcess } = require("electron");
const path = require("node:path");
app.whenReady().then(() => {
  const config = JSON.parse(process.env.PI_TEST_CONFIG);
  const env = process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {};
  const child = utilityProcess.fork(path.join(__dirname, "../dist/orchestrator.cjs"), [], { env, stdio: "pipe" });
  child.stderr?.pipe(process.stderr);
  child.on("message", (message) => {
    if (message.type === "ready") process.stdout.write("READY\n");
    if (message.type === "error") process.stderr.write(`CHILD_ERROR: ${message.code}\n`);
  });
  child.on("exit", (code) => app.exit(code));
  child.postMessage({ type: "start", ...config });
}).catch(() => app.exit(1));
