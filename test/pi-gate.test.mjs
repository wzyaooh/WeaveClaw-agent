import test from "node:test";
import assert from "node:assert/strict";
import { verifyPiGate } from "./pi-gate.mjs";

test("Pi 工具执行与取消边界的最小验证", { timeout: 30_000 }, async () => {
  const result = await verifyPiGate();
  assert.equal(result.checks.length, 5);
});
