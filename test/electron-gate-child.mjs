import { verifyPiGate } from "./pi-gate.mjs";
import { createTurn } from "../src/turn.mjs";

try {
  if (process.env.PI_GATE_FAIL_FOR_TEST === "1") throw new Error("模拟门禁失败");
  const result = await verifyPiGate();
  const requests = [];
  const tool = { name: "write", description: "模拟写入", parameters: { type: "object", properties: {}, additionalProperties: false } };
  const host = { async request(kind) {
    requests.push(kind);
    return kind === "model.call" ? { parts: [{ type: "tool_call", id: "one", name: "write", arguments: {} }] }
      : { final: true, result: { ok: true } };
  } };
  const turn = await createTurn({ prompt: "模拟用户请求", tools: [tool], host }).run();
  if (turn.error || requests.join(",") !== "model.call,tool.call") throw new Error("Pi 轮次适配验证失败");
  result.checks.push("host_owned_turn");
  process.parentPort.on("message", () => process.exit(0));
  process.parentPort.postMessage({ ok: true, node: process.versions.node, ...result });
} catch (error) {
  process.parentPort.on("message", () => process.exit(1));
  process.parentPort.postMessage({ ok: false, error: String(error?.stack || error) });
}
