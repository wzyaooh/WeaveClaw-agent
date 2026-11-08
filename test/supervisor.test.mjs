import assert from "node:assert/strict";
import test from "node:test";
import { createSupervisor } from "../src/supervisor.mjs";

const url = "ws://127.0.0.1:8780/api/v1/desktop/orchestrator/ws";
const token = "orchestrator-test-token-".repeat(2);
const start = { type: "start", url, token };

function fixture({ connect, env = {} } = {}) {
  const messages = [], exits = [];
  const port = { postMessage: (value) => messages.push(value) };
  const supervisor = createSupervisor({ port, connect, env, exit: (code) => exits.push(code) });
  return { supervisor, messages, exits };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function opened() {
  const close = deferred();
  let closeCount = 0;
  return { closed: close.promise, close: () => { closeCount += 1; },
    disconnected: close.resolve, get closeCount() { return closeCount; } };
}

test("invalid and duplicate starts report specific errors", async () => {
  for (const message of [{ ...start, url: "ws://localhost:8780/api/v1/desktop/orchestrator/ws" },
    { ...start, token: "short" }, { ...start, extra: true }]) {
    const state = fixture({ connect: async () => { assert.fail("must not connect"); } });
    await state.supervisor.handle(message);
    assert.deepEqual(state.messages, [{ type: "error", code: "invalid_start" }]);
    assert.deepEqual(state.exits, [1]);
  }
  const pending = deferred();
  const state = fixture({ connect: () => pending.promise });
  const running = state.supervisor.handle(start);
  await state.supervisor.handle(start);
  assert.deepEqual(state.messages, [{ type: "error", code: "already_started" }]);
  const connection = opened();
  pending.resolve(connection);
  await running;
  assert.equal(connection.closeCount, 1);
});

test("stop before or during connect prevents ready", async () => {
  const pending = deferred();
  const state = fixture({ connect: () => pending.promise });
  const running = state.supervisor.handle(start);
  await state.supervisor.handle({ type: "stop" });
  const connection = opened();
  pending.resolve(connection);
  await running;
  assert.deepEqual(state.messages, []);
  assert.deepEqual(state.exits, [0]);
  assert.equal(connection.closeCount, 1);
  const idle = fixture({ connect: async () => { assert.fail("must not connect"); } });
  await idle.supervisor.handle({ type: "stop" });
  assert.deepEqual(idle.exits, [0]);
});

test("connection errors and later disconnects are observable", async () => {
  const failed = fixture({ connect: async () => { throw new Error("private details"); } });
  await failed.supervisor.handle(start);
  assert.deepEqual(failed.messages, [{ type: "error", code: "connection_failed" }]);
  for (const reason of ["host_disconnected", "protocol_error"]) {
    const connection = opened();
    const state = fixture({ connect: async () => connection });
    await state.supervisor.handle(start);
    assert.deepEqual(state.messages, [{ type: "ready" }]);
    connection.disconnected(reason);
    await Promise.resolve();
    assert.deepEqual(state.messages.at(-1), { type: "error", code: reason });
    assert.deepEqual(state.exits, [1]);
  }
});

test("unsafe inherited application or model secrets fail before connecting", () => {
  for (const env of [{ WEAVECLAW_DESKTOP_TOKEN: "private" }, { MODEL_API_KEY: "private" }, { NODE_OPTIONS: "--inspect" },
    { HF_TOKEN: "private" }, { ANTHROPIC_AUTH_TOKEN: "private" }, { GOOGLE_APPLICATION_CREDENTIALS: "private" },
    { AWS_WEB_IDENTITY_TOKEN_FILE: "private" }, { NODE_PATH: "private" }]) {
    const state = fixture({ env, connect: async () => { assert.fail("must not connect"); } });
    assert.deepEqual(state.messages, [{ type: "error", code: "unsafe_environment" }]);
    assert.deepEqual(state.exits, [1]);
  }
});


test("SystemRoot is the only permitted inherited environment key", async () => {
  for (const env of [{ SystemRoot: "C:\\Windows" }, { systemroot: "x" }]) {
    const connection = opened();
    const state = fixture({ env, connect: async () => connection });
    await state.supervisor.handle(start);
    assert.deepEqual(state.messages, [{ type: "ready" }]);
    await state.supervisor.handle({ type: "stop" });
    assert.deepEqual(state.exits, [0]);
  }
});
