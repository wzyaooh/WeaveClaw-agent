import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { connectHost } from "../src/transport.mjs";

const token = "isolated-orchestrator-token-".repeat(2);
const tool = { name: "write", description: "写入", parameters: { type: "object", properties: {}, additionalProperties: false } };

async function pair() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false });
  await once(server, "listening");
  const port = server.address().port;
  const accepted = once(server, "connection");
  let connection;
  try {
    connection = await connectHost({ url: `ws://127.0.0.1:${port}/api/v1/desktop/orchestrator/ws`, token });
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
  const [peer, request] = await accepted;
  assert.equal(request.headers["x-weaveclaw-orchestrator-token"], token);
  const frames = [];
  const waiters = [];
  peer.on("message", (raw) => {
    const frame = JSON.parse(raw.toString());
    if (waiters.length) waiters.shift()(frame); else frames.push(frame);
  });
  let sequence = 0;
  return {
    peer, connection,
    async next() {
      if (frames.length) return frames.shift();
      return await new Promise((resolve, reject) => {
        const receive = (frame) => { clearTimeout(timer); resolve(frame); };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(receive);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("frame_timeout"));
        }, 5000);
        waiters.push(receive);
      });
    },
    send(type, turn_id, request_id, payload = {}) {
      peer.send(JSON.stringify({ version: 2, type, sequence: ++sequence, turn_id, request_id, payload }));
    },
    async close() { connection.close(); await new Promise((resolve) => server.close(resolve)); },
  };
}

test("real local socket runs one verified write", { timeout: 10_000 }, async () => {
  const p = await pair();
  try {
    p.send("turn.start", "attempt-1", "start-1", { prompt: "当前创作目标", history: [], tools: [tool] });
    const accepted = await p.next();
    const model = await p.next();
    assert.equal(accepted.type, "turn.accept");
    assert.equal(accepted.request_id, "start-1");
    assert.equal(model.type, "model.call");
    assert.deepEqual(model.payload, {});
    p.send("model.result", "attempt-1", model.request_id,
      { parts: [{ type: "tool_call", id: "call-1", name: "write", arguments: {} }] });
    const call = await p.next();
    assert.equal(call.type, "tool.call");
    assert.deepEqual(call.payload, { tool_call_id: "call-1", name: "write", arguments: {} });
    p.send("tool.result", "attempt-1", call.request_id, { ok: true, final: true, result: { ok: true } });
    assert.equal((await p.next()).type, "turn.end");
    assert.equal(p.connection.connected, true);
  } finally { await p.close(); }
});

test("host abort terminates an in-flight attempt without retry", { timeout: 10_000 }, async () => {
  const p = await pair();
  try {
    p.send("turn.start", "attempt-1", "start-1", { prompt: "当前创作目标", history: [], tools: [] });
    assert.equal((await p.next()).type, "turn.accept");
    assert.equal((await p.next()).type, "model.call");
    p.send("turn.abort", "attempt-1", "abort-1");
    assert.equal((await p.next()).type, "turn.end");
  } finally { await p.close(); }
});

test("invalid request association and out-of-order frames close the connection", { timeout: 10_000 }, async () => {
  for (const invalid of ["request", "sequence"]) {
    const p = await pair();
    try {
      p.send("turn.start", "attempt-1", "start-1", { prompt: "当前创作目标", history: [], tools: [] });
      await p.next();
      await p.next();
      const closed = once(p.peer, "close");
      if (invalid === "request") p.send("model.result", "attempt-1", "forged", { parts: [] });
      else p.peer.send(JSON.stringify({ version: 2, type: "model.result", sequence: 99,
        turn_id: "attempt-1", request_id: "m", payload: { parts: [] } }));
      await closed;
      assert.equal(p.connection.connected, false);
    } finally { await p.close(); }
  }
});

test("only the local orchestrator endpoint is accepted", { timeout: 10_000 }, async () => {
  for (const url of ["ws://example.test:1234/api/v1/desktop/orchestrator/ws",
    "ws://127.0.0.1:1234/api/v1/desktop/orchestrator/ws?token=secret",
    "ws://localhost:1234/api/v1/desktop/orchestrator/ws", "wss://127.0.0.1:1234/api/v1/desktop/orchestrator/ws"]) {
    await assert.rejects(connectHost({ url, token }), /invalid_local_endpoint/);
  }
});


test("cancelling one concurrent turn tolerates its late reply and preserves another", { timeout: 10_000 }, async () => {
  const p = await pair();
  try {
    p.send("turn.start", "a", "start-a", { prompt: "当前创作目标", history: [], tools: [tool] });
    p.send("turn.start", "b", "start-b", { prompt: "当前创作目标", history: [], tools: [tool] });
    const initial = [await p.next(), await p.next(), await p.next(), await p.next()];
    const a = initial.find((item) => item.turn_id === "a" && item.type === "model.call");
    const b = initial.find((item) => item.turn_id === "b" && item.type === "model.call");
    assert.ok(a && b);
    p.send("turn.abort", "a", "abort-a");
    p.send("model.error", "a", a.request_id);
    p.send("model.result", "b", b.request_id,
      { parts: [{ type: "tool_call", id: "write-b", name: "write", arguments: {} }] });
    const ends = new Set();
    while (ends.size < 2) {
      const item = await p.next();
      if (item.type === "tool.call") {
        assert.equal(item.turn_id, "b");
        p.send("tool.result", "b", item.request_id, { ok: true, final: true, result: { ok: true } });
      } else if (item.type === "turn.end") ends.add(item.turn_id);
      else assert.fail(`unexpected message: ${item.type}`);
    }
    assert.deepEqual(ends, new Set(["a", "b"]));
    assert.equal(p.connection.connected, true);
  } finally { await p.close(); }
});

test("tool reply after cancellation is ignored without closing the connection", { timeout: 10_000 }, async () => {
  const p = await pair();
  try {
    p.send("turn.start", "a", "start", { prompt: "当前创作目标", history: [], tools: [tool] });
    await p.next();
    const model = await p.next();
    p.send("model.result", "a", model.request_id,
      { parts: [{ type: "tool_call", id: "call", name: "write", arguments: {} }] });
    const pending = await p.next();
    assert.equal(pending.type, "tool.call");
    p.send("turn.abort", "a", "abort");
    p.send("tool.result", "a", pending.request_id, { ok: true, final: true, result: { ok: true } });
    assert.equal((await p.next()).type, "turn.end");
    assert.equal(p.connection.connected, true);
  } finally { await p.close(); }
});

test("disconnect during an active attempt reports a bounded reason", { timeout: 10_000 }, async () => {
  const p = await pair();
  try {
    p.send("turn.start", "a", "start", { prompt: "当前创作目标", history: [], tools: [] });
    await p.next();
    assert.equal((await p.next()).type, "model.call");
    p.peer.terminate();
    assert.equal(await p.connection.closed, "host_disconnected");
    assert.equal(p.connection.connected, false);
  } finally { await p.close(); }
});

test("extra model result keys and replies to unknown turns fail closed", { timeout: 10_000 }, async () => {
  for (const mode of ["extra", "unknown"]) {
    const p = await pair();
    try {
      p.send("turn.start", "a", "start", { prompt: "当前创作目标", history: [], tools: [] });
      await p.next();
      const model = await p.next();
      const done = p.connection.closed;
      if (mode === "extra") p.send("model.result", "a", model.request_id, { parts: [], secret: "x" });
      else p.send("model.error", "unknown", model.request_id);
      assert.equal(await done, "protocol_error");
    } finally { await p.close(); }
  }
});

test("retired attempts accept only replies to their cancelled requests", { timeout: 10_000 }, async () => {
  const p = await pair();
  try {
    p.send("turn.start", "a", "start", { prompt: "当前创作目标", history: [], tools: [] });
    await p.next();
    const model = await p.next();
    p.send("turn.abort", "a", "abort");
    assert.equal((await p.next()).type, "turn.end");
    p.send("model.error", "a", model.request_id);
    p.send("turn.start", "b", "start-b", { prompt: "当前创作目标", history: [], tools: [] });
    const accepted = await p.next();
    assert.equal(accepted.type, "turn.accept");
    assert.equal(accepted.turn_id, "b");
    const nextModel = await p.next();
    assert.equal(nextModel.type, "model.call");
    p.send("model.result", "b", nextModel.request_id, { parts: [] });
    assert.equal((await p.next()).type, "turn.end");
    assert.equal(p.connection.connected, true);
  } finally { await p.close(); }
});

test("a mismatched late reply is rejected", { timeout: 10_000 }, async () => {
  const p = await pair();
  try {
    p.send("turn.start", "a", "start", { prompt: "当前创作目标", history: [], tools: [] });
    await p.next();
    const model = await p.next();
    p.send("turn.abort", "a", "abort");
    p.send("tool.result", "a", model.request_id, { ok: true, final: true, result: { ok: true } });
    assert.equal(await p.connection.closed, "protocol_error");
  } finally { await p.close(); }
});

test("normal host close and oversized frame report distinct reasons", { timeout: 10_000 }, async () => {
  for (const mode of ["normal", "oversized"]) {
    const p = await pair();
    try {
      p.send("turn.start", "a", "start", { prompt: "当前创作目标", history: [], tools: [] });
      await p.next();
      await p.next();
      if (mode === "normal") {
        p.send("turn.abort", "a", "abort");
        p.peer.close();
      } else p.peer.send("x".repeat(2 * 1024 * 1024 + 1));
      assert.equal(await p.connection.closed, mode === "normal" ? "host_disconnected" : "protocol_error");
    } finally { await p.close(); }
  }
});

test("cancelled model write proposal is ignored and cannot be repeated", { timeout: 10_000 }, async () => {
  const p = await pair();
  try {
    p.send("turn.start", "a", "start", { prompt: "当前创作目标", history: [], tools: [tool] });
    await p.next();
    const model = await p.next();
    p.send("turn.abort", "a", "abort");
    const proposal = { parts: [{ type: "tool_call", id: "write", name: "write", arguments: {} }] };
    p.send("model.result", "a", model.request_id, proposal);
    assert.equal((await p.next()).type, "turn.end");
    assert.equal(p.connection.connected, true);
    p.send("model.result", "a", model.request_id, proposal);
    assert.equal(await p.connection.closed, "protocol_error");
  } finally { await p.close(); }
});

test("late malformed model results are rejected", { timeout: 10_000 }, async () => {
  const p = await pair();
  try {
    p.send("turn.start", "a", "start", { prompt: "当前创作目标", history: [], tools: [] });
    await p.next();
    const model = await p.next();
    p.send("turn.abort", "a", "abort");
    p.send("model.result", "a", model.request_id, { parts: [{ type: "text", text: "private", extra: true }] });
    assert.equal(await p.connection.closed, "protocol_error");
  } finally { await p.close(); }
});


test("explicit close reports closed and sends a normal close frame", { timeout: 10_000 }, async () => {
  const p = await pair();
  try {
    const peerClosed = once(p.peer, "close");
    p.connection.close();
    assert.equal(await p.connection.closed, "closed");
    assert.equal(p.connection.connected, false);
    assert.equal((await peerClosed)[0], 1000);
  } finally { await p.close(); }
});


test("invalid start closes the connection while another attempt is active", { timeout: 10000 }, async () => {
  for (const payload of [
    { tools: [] },
    { prompt: "生成", history: [], tools: [], extra: true },
    { prompt: "😀".repeat(24001), history: [], tools: [] },
    { prompt: "", history: [], tools: [] },
  ]) {
    const p = await pair();
    try {
      p.send("turn.start", "active", "start-active", { prompt: "正在生成", history: [], tools: [] });
      assert.equal((await p.next()).type, "turn.accept");
      assert.equal((await p.next()).type, "model.call");
      p.send("turn.start", "bad", "start-bad", payload);
      assert.equal(await p.connection.closed, "protocol_error");
      assert.equal(p.connection.connected, false);
    } finally { await p.close(); }
  }
});

test("local socket accepts CJK and emoji history", { timeout: 10000 }, async () => {
  const p = await pair();
  try {
    p.send("turn.start", "a", "start", { prompt: "画第一集😀", history: [
      { role: "user", content: "素材已导入😀" }, { role: "assistant", content: "可以生成草图" },
    ], tools: [] });
    assert.equal((await p.next()).type, "turn.accept");
    const model = await p.next();
    p.send("model.result", "a", model.request_id, { parts: [] });
    assert.equal((await p.next()).type, "turn.end");
    assert.equal(p.connection.connected, true);
  } finally { await p.close(); }
});


test("socket forwards nonempty arguments and accepts text-only model completion", { timeout: 10000 }, async () => {
  const p = await pair();
  const named = { ...tool, parameters: { type: "object", properties: { episode: { type: "integer" } }, required: ["episode"], additionalProperties: false } };
  try {
    p.send("turn.start", "a", "start", { prompt: "生成", history: [], tools: [named] });
    assert.equal((await p.next()).type, "turn.accept");
    const model = await p.next();
    p.send("model.result", "a", model.request_id, { parts: [{ type: "text", text: "正在创建" },
      { type: "tool_call", id: "call", name: "write", arguments: { episode: 2 } }] });
    const call = await p.next();
    assert.deepEqual(call.payload.arguments, { episode: 2 });
    p.send("tool.result", "a", call.request_id, { ok: true, final: false, result: { ok: true, title: "第一集" } });
    const next = await p.next();
    assert.equal(next.type, "model.call");
    p.send("model.result", "a", next.request_id, { parts: [{ type: "text", text: "已完成" }] });
    assert.equal((await p.next()).type, "turn.end");
  } finally { await p.close(); }
});

test("oversized tool result closes the local connection", { timeout: 10000 }, async () => {
  const p = await pair();
  try {
    p.send("turn.start", "a", "start", { prompt: "生成", history: [], tools: [tool] });
    await p.next(); const model = await p.next();
    p.send("model.result", "a", model.request_id, { parts: [{ type: "tool_call", id: "call", name: "write", arguments: {} }] });
    const call = await p.next();
    p.send("tool.result", "a", call.request_id, { ok: true, final: false, result: { text: "x".repeat(256001) } });
    assert.equal(await p.connection.closed, "protocol_error");
  } finally { await p.close(); }
});

test("late valid text result after cancellation is discarded", { timeout: 10000 }, async () => {
  const p = await pair();
  try {
    p.send("turn.start", "a", "start", { prompt: "生成", history: [], tools: [] });
    await p.next(); const model = await p.next();
    p.send("turn.abort", "a", "abort");
    assert.equal((await p.next()).type, "turn.end");
    p.send("model.result", "a", model.request_id, { parts: [{ type: "text", text: "已取消" }] });
    p.send("turn.start", "b", "next", { prompt: "继续", history: [], tools: [] });
    assert.equal((await p.next()).type, "turn.accept");
    const next = await p.next();
    p.send("model.result", "b", next.request_id, { parts: [] });
    assert.equal((await p.next()).type, "turn.end");
    assert.equal(p.connection.connected, true);
  } finally { await p.close(); }
});


test("old protocol is rejected before requesting a model", { timeout: 10_000 }, async () => {
  const p = await pair();
  try {
    const closed = once(p.peer, "close");
    p.peer.send(JSON.stringify({ version: 1, type: "turn.start", sequence: 1,
      turn_id: "attempt-1", request_id: "start-1", payload: { prompt: "目标", history: [], tools: [] } }));
    await closed;
    assert.equal(p.connection.connected, false);
    await assert.rejects(p.next(), /frame_timeout/);
  } finally { await p.close(); }
});
