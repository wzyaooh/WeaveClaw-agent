const { app, utilityProcess } = require("electron");
const { randomBytes } = require("node:crypto");
const path = require("node:path");
const { WebSocketServer } = require("ws");

app.whenReady().then(async () => {
  const token = randomBytes(32).toString("base64url");
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false });
  await new Promise((resolve) => server.once("listening", resolve));
  const env = process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {};
  const child = utilityProcess.fork(path.join(__dirname, "../dist/orchestrator.cjs"), [], { stdio: "pipe", env });
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);
  let verified = false;
  const timer = setTimeout(() => { child.kill(); console.error("utilityProcess 通信测试超时"); app.exit(1); }, 30000);
  server.on("connection", (peer, request) => {
    if (request.headers["x-weaveclaw-orchestrator-token"] !== token) { peer.terminate(); return; }
    let sequence = 0;
    const send = (type, requestId, payload) => peer.send(JSON.stringify({ version: 2, type,
      sequence: ++sequence, turn_id: "attempt-1", request_id: requestId, payload }));
    const tool = { name: "write", description: "模拟写入", parameters: { type: "object", properties: {}, additionalProperties: false } };
    send("turn.start", "start-1", { prompt: "当前创作目标", history: [], scope: "project", tools: [tool] });
    peer.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "model.call") {
        send("model.result", frame.request_id, { parts: [{ type: "tool_call", id: "call-1", name: "write", arguments: {} }] });
      } else if (frame.type === "tool.call") {
        if (JSON.stringify(frame.payload) !== JSON.stringify({ tool_call_id: "call-1", name: "write", arguments: {} })) {
          child.kill(); app.exit(1); return;
        }
        send("tool.result", frame.request_id, { ok: true, final: true, result: { ok: true } });
      } else if (frame.type === "turn.end") {
        verified = true;
        child.postMessage({ type: "stop" });
      }
    });
  });
  child.on("message", (value) => { if (value?.type === "error") { console.error(value.code); child.kill(); app.exit(1); } });
  child.on("exit", (code) => {
    clearTimeout(timer);
    server.close();
    if (!verified || code !== 0) { console.error("utilityProcess 通信测试失败"); app.exit(1); return; }
    console.log(JSON.stringify({ ok: true, electron: process.versions.electron, checks: ["local_socket", "host_owned_write"] }));
    app.exit(0);
  });
  child.postMessage({ type: "start", url: `ws://127.0.0.1:${server.address().port}/api/v1/desktop/orchestrator/ws`, token });
}).catch((error) => { console.error(error); app.exit(1); });
