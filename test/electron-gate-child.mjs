import { verifyPiGate } from "./pi-gate.mjs";

try {
  if (process.env.PI_GATE_FAIL_FOR_TEST === "1") throw new Error("模拟门禁失败");
  const result = await verifyPiGate();
  process.parentPort.on("message", () => process.exit(0));
  process.parentPort.postMessage({ ok: true, node: process.versions.node, ...result });
} catch (error) {
  process.parentPort.on("message", () => process.exit(1));
  process.parentPort.postMessage({ ok: false, error: String(error?.stack || error) });
}
