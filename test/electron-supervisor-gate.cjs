const { app, utilityProcess } = require("electron");
const { randomBytes } = require("node:crypto");
const path = require("node:path");
const net = require("node:net");
const { WebSocketServer } = require("ws");

app.whenReady().then(async () => {
  const token = randomBytes(32).toString("base64url");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `ws://127.0.0.1:${server.address().port}/api/v1/desktop/orchestrator/ws`;
  const env = process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {};
  const run = (message, expected, closeAfterReady = false, childEnv = env) => new Promise((resolve, reject) => {
    const child = utilityProcess.fork(path.join(__dirname, "../dist/orchestrator.cjs"), [], { env: childEnv, stdio: "pipe" });
    child.stderr?.pipe(process.stderr);
    const events = [];
    let peer;
    const timeout = setTimeout(() => { child.kill(); reject(new Error("supervisor_gate_timeout")); }, 10000);
    const onConnection = (socket) => { peer = socket; };
    server.once("connection", onConnection);
    child.on("message", (value) => {
      events.push(value);
      if (closeAfterReady && value.type === "ready") peer?.terminate();
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      server.off("connection", onConnection);
      peer?.terminate();
      if (code !== expected.exit || JSON.stringify(events) !== JSON.stringify(expected.events)) {
        reject(new Error(`supervisor_gate_mismatch: ${JSON.stringify({ code, events })}`));
      } else resolve();
    });
    child.postMessage(message);
  });
  await run({ type: "start", url: "ws://localhost:8780/api/v1/desktop/orchestrator/ws", token },
    { exit: 1, events: [{ type: "error", code: "invalid_start" }] });
  await run({ type: "stop" }, { exit: 0, events: [] });
  await run({ type: "stop" }, { exit: 1, events: [{ type: "error", code: "unsafe_environment" }] }, false, { ...env, HF_TOKEN: "test-only" });
  await run({ type: "start", url, token },
    { exit: 1, events: [{ type: "ready" }, { type: "error", code: "host_disconnected" }] }, true);
  server.close();
  const pending = net.createServer();
  await new Promise((resolve) => pending.listen(0, "127.0.0.1", resolve));
  const hanging = utilityProcess.fork(path.join(__dirname, "../dist/orchestrator.cjs"), [], { env, stdio: "pipe" });
  const hangingEvents = [];
  hanging.on("message", (event) => hangingEvents.push(event));
  const accepted = new Promise((resolve) => pending.once("connection", resolve));
  const exited = new Promise((resolve) => hanging.once("exit", resolve));
  hanging.postMessage({ type: "start", url: `ws://127.0.0.1:${pending.address().port}/api/v1/desktop/orchestrator/ws`, token });
  const client = await accepted;
  hanging.postMessage({ type: "stop" });
  const status = await exited;
  client.destroy();
  pending.close();
  if (status !== 0 || hangingEvents.length) throw new Error("stop_during_handshake_failed");
  console.log(JSON.stringify({ ok: true, checks: ["invalid_start", "early_stop", "unsafe_environment", "disconnect_reported", "stop_during_handshake"] }));
  app.exit(0);
}).catch((error) => { console.error(error.message); app.exit(1); });
