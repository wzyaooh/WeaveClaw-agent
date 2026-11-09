import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { createTurn } from "../src/turn.mjs";

const tool = { name: "read_project", description: "查看项目", parameters: { type: "object", properties: {}, additionalProperties: false } };
const write = { ...tool, name: "write_project" };
const call = (name = "read_project") => ({ type: "tool_call", id: "tool-1", name, arguments: {} });

function mockHost(replies) {
  const requests = [];
  return { requests, async request(kind, payload) {
    requests.push({ kind, payload });
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    if (!reply || reply.kind !== kind) throw new Error("unexpected_host_request");
    return reply.value;
  } };
}

const model = (...parts) => ({ kind: "model.call", value: { parts } });
const result = (final = false) => ({ kind: "tool.call", value: { final, ok: true } });

test("Pi asks the host for model and tool work and stops after a write", async () => {
  const host = mockHost([model(call("write_project")), result(true)]);
  const turn = createTurn({ prompt: "当前创作目标", history: [], tools: [write], host });
  assert.deepEqual(await turn.run(), { aborted: false, error: undefined });
  assert.deepEqual(host.requests, [
    { kind: "model.call", payload: {} },
    { kind: "tool.call", payload: { tool_call_id: "tool-1", name: "write_project", arguments: {} } },
  ]);
  await assert.rejects(turn.run(), /turn_already_used/);
});

test("Pi returns a read result to the host before the next model call", async () => {
  const host = mockHost([model(call()), result(), model()]);
  const output = await createTurn({ prompt: "当前创作目标", history: [], tools: [tool], host }).run();
  assert.equal(output.error, undefined);
  assert.deepEqual(host.requests.map((item) => item.kind), ["model.call", "tool.call", "model.call"]);
});

test("a failed model or tool request stops without another host call", async () => {
  for (const replies of [[new Error("lost")], [model(call()), new Error("lost")]]) {
    const host = mockHost(replies);
    const output = await createTurn({ prompt: "当前创作目标", history: [], tools: [tool], host }).run();
    assert.match(output.error, /^host_(model|tool)_failed$/);
    assert.ok(host.requests.length <= 2);
  }
});

test("an abort during the model request does not execute a tool", async () => {
  const requests = [];
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  const host = { request(kind, _payload, signal) {
    requests.push(kind);
    started();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  } };
  const turn = createTurn({ prompt: "当前创作目标", history: [], tools: [tool], host });
  const running = turn.run();
  await entered;
  turn.abort();
  assert.equal((await running).aborted, true);
  assert.deepEqual(requests, ["model.call"]);
});


test("a final write prevents later calls in the same batch", async () => {
  const host = mockHost([model(call("write_project"), { ...call("read_project"), id: "tool-2" }), result(true)]);
  const output = await createTurn({ prompt: "当前创作目标", history: [], tools: [write, tool], host }).run();
  assert.equal(output.error, undefined);
  assert.deepEqual(host.requests.map((item) => item.kind), ["model.call", "tool.call"]);
});

test("private arguments or an unknown tool fail before any tool request", async () => {
  for (const part of [{ ...call("write_project"), arguments: { episode: "3" } }, call("unknown")]) {
    const host = mockHost([model(part)]);
    const output = await createTurn({ prompt: "当前创作目标", history: [], tools: [write], host }).run();
    assert.equal(output.error, "host_model_failed");
    assert.deepEqual(host.requests.map((item) => item.kind), ["model.call"]);
  }
});

test("invalid tool results never cause another model request", async () => {
  const invalid = [{ final: true, ok: true, result: {} }, { final: true }, { final: "true", ok: true }, null, []];
  for (const value of invalid) {
    const host = mockHost([model(call("write_project")), { kind: "tool.call", value }]);
    const output = await createTurn({ prompt: "当前创作目标", history: [], tools: [write], host }).run();
    assert.equal(output.error, "host_tool_failed");
    assert.deepEqual(host.requests.map((item) => item.kind), ["model.call", "tool.call"]);
    assert.deepEqual(host.requests[1].payload.arguments, {});
  }
});

test("failed read can proceed, final failure stops, and settled requests are not aborted", async () => {
  const signals = [];
  let callNumber = 0;
  const host = { async request(kind, _payload, signal) {
    signals.push(signal);
    callNumber += 1;
    if (kind === "model.call") return { parts: [call(callNumber === 1 ? "read_project" : "write_project")] };
    return { ok: false, final: callNumber === 4 };
  } };
  const output = await createTurn({ prompt: "当前创作目标", history: [], tools: [tool, write], host }).run();
  assert.equal(output.error, undefined);
  assert.equal(output.aborted, false);
  assert.equal(callNumber, 4);
  assert.ok(signals.every((signal) => !signal.aborted));
});

test("turn definition rejects old shapes and nonempty tool schemas", () => {
  const host = mockHost([]);
  assert.throws(() => createTurn({ tools: [tool], host }), /invalid_turn_start/);
  assert.throws(() => createTurn({ prompt: "private", tools: [tool], host }), /invalid_turn_start/);
  assert.throws(() => createTurn({ prompt: "当前创作目标", history: [], tools: [{ ...tool, parameters: { type: "object", required: ["x"], properties: {} } }], host }), /invalid_tool_definition/);
});

test("batch cancellation remains aborted when the host still answers", async () => {
  let turn;
  const requests = [];
  const host = { async request(kind) {
    requests.push(kind);
    if (kind === "model.call") return { parts: [call(), { ...call(), id: "tool-2" }] };
    turn.abort();
    return { final: false, ok: true };
  } };
  turn = createTurn({ prompt: "当前创作目标", history: [], tools: [tool], host });
  assert.deepEqual(await turn.run(), { aborted: true, error: "aborted" });
  assert.deepEqual(requests, ["model.call", "tool.call"]);
});

test("cancelling an in-flight tool forwards abort without another request", async () => {
  const requests = [];
  let started, toolSignal;
  const entered = new Promise((resolve) => { started = resolve; });
  const host = { async request(kind, _payload, signal) {
    requests.push(kind);
    if (kind === "model.call") return { parts: [call()] };
    toolSignal = signal;
    started();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  } };
  const turn = createTurn({ prompt: "当前创作目标", history: [], tools: [tool], host });
  const running = turn.run();
  await entered;
  turn.abort();
  assert.deepEqual(await running, { aborted: true, error: "aborted" });
  assert.equal(toolSignal.aborted, true);
  assert.deepEqual(requests, ["model.call", "tool.call"]);
});

test("a mixed valid and invalid batch never executes the valid call", async () => {
  for (const bad of [call("unknown"), { ...call("write_project"), id: "tool-2", arguments: { secret: "value" } }, { type: "text", text: "private" }]) {
    const host = mockHost([model(call("write_project"), bad)]);
    assert.equal((await createTurn({ prompt: "当前创作目标", history: [], tools: [write], host }).run()).error, "host_model_failed");
    assert.deepEqual(host.requests.map((item) => item.kind), ["model.call"]);
  }
});


test("Pi receives the bounded host conversation and current creative goal", async () => {
  const originalPrompt = Agent.prototype.prompt;
  let observed;
  Agent.prototype.prompt = async function (prompt) {
    observed = { prompt, history: this.state.messages.filter((item) => item.role !== "system").map((item) => ({ role: item.role, text: item.content[0].text })) };
    return originalPrompt.call(this, prompt);
  };
  try {
    const host = mockHost([model()]);
    const output = await createTurn({ prompt: "为第一集生成草图", history: [
      { role: "user", content: "先检查素材" }, { role: "assistant", content: "已检查" },
    ], tools: [], host }).run();
    assert.equal(output.error, undefined);
    assert.deepEqual(observed, { prompt: "为第一集生成草图", history: [
      { role: "user", text: "先检查素材" }, { role: "assistant", text: "已检查" },
    ] });
  } finally { Agent.prototype.prompt = originalPrompt; }
});

test("turn context rejects extra fields and oversized conversation", () => {
  const host = mockHost([]);
  for (const context of [
    { prompt: "", history: [] }, { prompt: 1, history: [] }, { prompt: "x", history: null },
    { prompt: "x".repeat(24001), history: [] }, { prompt: "😀".repeat(24001), history: [] },
    { prompt: "😀".repeat(23999) + "xx", history: [] },
    { prompt: "x", history: [null] }, { prompt: "x", history: [[]] },
    { prompt: "x", history: [{ role: "user", content: "" }] },
    { prompt: "x", history: [{ role: "user", content: 1 }] },
    { prompt: "x", history: [{ role: "user", content: "x".repeat(24001) },
      { role: "assistant", content: "x".repeat(24000) }] },
    { prompt: "x", history: [{ role: "system", content: "x" }] },
    { prompt: "x", history: [{ role: "user", content: "x", secret: "x" }] },
    { prompt: "x", history: Array.from({ length: 41 }, () => ({ role: "user", content: "x" })) },
    { prompt: "x", history: [{ role: "user", content: "x".repeat(48001) }] },
  ]) assert.throws(() => createTurn({ ...context, tools: [], host }), /invalid_turn_context/);
});


test("context accepts exact Unicode and history limits", async () => {
  const host = mockHost([model()]);
  const history = Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: "😀".repeat(1200) }));
  assert.equal((await createTurn({ prompt: "😀".repeat(24000), history, tools: [], host }).run()).error, undefined);
});
