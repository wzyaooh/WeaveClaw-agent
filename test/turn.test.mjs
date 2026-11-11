import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { createTurn as rawCreateTurn, validToolResult } from "../src/turn.mjs";

const limits = { max_model_calls: 4, max_tool_calls_per_response: 6 };
const createTurn = (input) => rawCreateTurn({ limits, ...input });

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
const result = (final = false) => ({ kind: "tool.call", value: { final, ok: true, result: { ok: true } } });

test("turn accepts absent or null episode memory and rejects invalid episode values", async () => {
  for (const extra of [{}, { last_episode: null }]) {
    const host = mockHost([model()]);
    const turn = createTurn({ scope: "project", prompt: "继续", history: [], tools: [tool], host, ...extra });
    assert.ok(!turn.strategy.text.includes("当前正在处理第"));
    assert.equal((await turn.run()).error, undefined);
    assert.equal(host.requests[0].payload.plan, null);
  }
  for (const last_episode of ["7", 1.5, 0, -1, 10001, Number.MAX_SAFE_INTEGER + 1, {}, true]) {
    assert.throws(() => createTurn({ scope: "project", prompt: "继续", history: [], tools: [],
      host: mockHost([]), last_episode }), /invalid_turn_start/);
  }
});

test("turn reads target progress before showing the eligible creative write", async () => {
  const episodeSchema = { type: "object", properties: { episode: { type: "integer" } }, required: ["episode"], additionalProperties: false };
  const progress = { ...tool, name: "weaveclaw_get_creation_progress", parameters: episodeSchema };
  const script = { ...progress, name: "weaveclaw_generate_script" };
  const requests = [];
  const host = { async request(kind, payload) {
    requests.push({ kind, payload });
    if (kind === "tool.call" && payload.name === progress.name) return { ok: true, final: false, result: { ok: true, data: {
      version: 1, source: { uploads: 1, imported: true }, project: { characters: 1, episodes: 1, configured: true },
      episode: { number: 1, exists: true, identity_planned: true, beats: 0, all_beats_have_content: false,
        sketches_missing: 0, sketches_stale: 0, identity_detected: 0, first_frames_present: 0 }, active_steps: [],
    } } };
    if (kind === "tool.call") return { ok: true, final: true, result: { ok: true } };
    if (requests.length === 1) return { parts: [{ ...call(progress.name), arguments: { episode: 1 } }] };
    return { parts: [{ ...call(script.name), id: "write-1", arguments: { episode: 1 } }] };
  } };
  const output = await createTurn({ scope: "project", prompt: "生成第一集剧本", history: [], tools: [progress, script], host }).run();
  assert.equal(output.error, undefined);
  assert.deepEqual(requests[0].payload.tools, [progress.name]);
  assert.deepEqual(requests[2].payload.tools, [progress.name, script.name]);
  assert.deepEqual(requests[2].payload.plan, { episode: 1, next_tool: script.name, reason: "script_required" });
  assert.equal(requests[3].payload.name, script.name);
});

test("progress for one episode cannot authorize a different episode", async () => {
  const schema = { type: "object", properties: { episode: { type: "integer" } }, required: ["episode"], additionalProperties: false };
  const progress = { ...tool, name: "weaveclaw_get_creation_progress", parameters: schema };
  const script = { ...progress, name: "weaveclaw_generate_script" };
  const requests = [];
  const host = { async request(kind, payload) {
    requests.push({ kind, payload });
    if (kind === "tool.call") return { ok: true, final: false, result: { ok: true, data: {
      version: 1, source: { uploads: 1, imported: true }, project: { characters: 1, episodes: 2 },
      episode: { number: 1, exists: true, identity_planned: true, beats: 0, all_beats_have_content: false,
        sketches_missing: 0, sketches_stale: 0, identity_detected: 0, first_frames_present: 0 }, active_steps: [],
    } } };
    return requests.length === 1 ? { parts: [{ ...call(progress.name), arguments: { episode: 1 } }] }
      : { parts: [{ ...call(script.name), id: "wrong-episode", arguments: { episode: 2 } }] };
  } };
  const output = await createTurn({ scope: "project", prompt: "生成剧本", history: [], tools: [progress, script], host }).run();
  assert.equal(output.error, "host_model_failed");
  assert.deepEqual(requests.map((item) => item.kind), ["model.call", "tool.call", "model.call"]);
});

test("Pi asks the host for model and tool work and stops after a write", async () => {
  const host = mockHost([model(call("write_project")), result(true)]);
  const turn = createTurn({ scope: "project", prompt: "当前创作目标", history: [], tools: [write], host });
  assert.deepEqual(await turn.run(), { aborted: false, error: undefined });
  assert.deepEqual(host.requests, [
    { kind: "model.call", payload: { context: [{ ref: "prompt" }], tools: ["write_project"], plan: null } },
    { kind: "tool.call", payload: { tool_call_id: "tool-1", name: "write_project", arguments: {} } },
  ]);
  await assert.rejects(turn.run(), /turn_already_used/);
});

test("Pi returns a read result to the host before the next model call", async () => {
  const host = mockHost([model(call()), result(), model()]);
  const output = await createTurn({ scope: "project", prompt: "当前创作目标", history: [], tools: [tool], host }).run();
  assert.equal(output.error, undefined);
  assert.deepEqual(host.requests.map((item) => item.kind), ["model.call", "tool.call", "model.call"]);
  assert.deepEqual(host.requests[2].payload, { context: [{ ref: "prompt" }, { ref: "response", index: 1 },
    { ref: "tool", response: 1, id: "tool-1" }], tools: ["read_project"], plan: null });
});

test("Pi keeps repeated tool IDs distinct across response rounds", async () => {
  const host = mockHost([model(call()), result(), model(call()), result(), model()]);
  const output = await createTurn({ scope: "project", prompt: "目标", history: [], tools: [tool], host }).run();
  assert.equal(output.error, undefined);
  assert.deepEqual(host.requests[4].payload, { context: [{ ref: "prompt" },
    { ref: "response", index: 1 }, { ref: "tool", response: 1, id: "tool-1" },
    { ref: "response", index: 2 }, { ref: "tool", response: 2, id: "tool-1" }], tools: ["read_project"], plan: null });
});

test("Pi projects every acknowledged tool in a complete batch", async () => {
  const second = { ...call(), id: "tool-2" };
  const host = mockHost([model(call(), second), result(), result(), model()]);
  const output = await createTurn({ scope: "project", prompt: "目标", history: [], tools: [tool], host }).run();
  assert.equal(output.error, undefined);
  assert.deepEqual(host.requests[3].payload, { context: [{ ref: "prompt" }, { ref: "response", index: 1 },
    { ref: "tool", response: 1, id: "tool-1" }, { ref: "tool", response: 1, id: "tool-2" }], tools: ["read_project"], plan: null });
});

test("a failed model or tool request stops without another host call", async () => {
  for (const replies of [[new Error("lost")], [model(call()), new Error("lost")]]) {
    const host = mockHost(replies);
    const output = await createTurn({ scope: "project", prompt: "当前创作目标", history: [], tools: [tool], host }).run();
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
  const turn = createTurn({ scope: "project", prompt: "当前创作目标", history: [], tools: [tool], host });
  const running = turn.run();
  await entered;
  turn.abort();
  assert.equal((await running).aborted, true);
  assert.deepEqual(requests, ["model.call"]);
});


test("a final write prevents later calls in the same batch", async () => {
  const host = mockHost([model(call("write_project"), { ...call("read_project"), id: "tool-2" }), result(true)]);
  const output = await createTurn({ scope: "project", prompt: "当前创作目标", history: [], tools: [write, tool], host }).run();
  assert.equal(output.error, undefined);
  assert.deepEqual(host.requests.map((item) => item.kind), ["model.call", "tool.call"]);
});

test("schema-invalid arguments or an unknown tool fail before any tool request", async () => {
  for (const part of [{ ...call("write_project"), arguments: { episode: "3" } }, call("unknown")]) {
    const host = mockHost([model(part)]);
    const output = await createTurn({ scope: "project", prompt: "当前创作目标", history: [], tools: [write], host }).run();
    assert.equal(output.error, "host_model_failed");
    assert.deepEqual(host.requests.map((item) => item.kind), ["model.call"]);
  }
});

test("invalid tool results never cause another model request", async () => {
  const invalid = [{ final: true, ok: true }, { final: true }, { final: "true", ok: true }, null, []];
  for (const value of invalid) {
    const host = mockHost([model(call("write_project")), { kind: "tool.call", value }]);
    const output = await createTurn({ scope: "project", prompt: "当前创作目标", history: [], tools: [write], host }).run();
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
    return { ok: false, final: callNumber === 4, result: { ok: false } };
  } };
  const output = await createTurn({ scope: "project", prompt: "当前创作目标", history: [], tools: [tool, write], host }).run();
  assert.equal(output.error, undefined);
  assert.equal(output.aborted, false);
  assert.equal(callNumber, 4);
  assert.ok(signals.every((signal) => !signal.aborted));
});

test("turn definition rejects old shapes and invalid tool schemas", () => {
  const host = mockHost([]);
  assert.throws(() => createTurn({ scope: "project", tools: [tool], host }), /invalid_turn_start/);
  assert.throws(() => createTurn({ scope: "project", prompt: "private", tools: [tool], host }), /invalid_turn_start/);
  assert.throws(() => createTurn({ scope: "project", prompt: "当前创作目标", history: [], tools: [{ ...tool, parameters: { type: "object", required: ["x"], properties: null } }], host }), /invalid_tool_definition/);
});

test("batch cancellation remains aborted when the host still answers", async () => {
  let turn;
  const requests = [];
  const host = { async request(kind) {
    requests.push(kind);
    if (kind === "model.call") return { parts: [call(), { ...call(), id: "tool-2" }] };
    turn.abort();
    return { final: false, ok: true, result: { ok: true } };
  } };
  turn = createTurn({ scope: "project", prompt: "当前创作目标", history: [], tools: [tool], host });
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
  const turn = createTurn({ scope: "project", prompt: "当前创作目标", history: [], tools: [tool], host });
  const running = turn.run();
  await entered;
  turn.abort();
  assert.deepEqual(await running, { aborted: true, error: "aborted" });
  assert.equal(toolSignal.aborted, true);
  assert.deepEqual(requests, ["model.call", "tool.call"]);
});

test("a mixed valid and invalid batch never executes the valid call", async () => {
  for (const bad of [call("unknown"), { ...call("write_project"), id: "tool-2", arguments: { secret: "value" } }, { type: "text", text: "private", extra: true }]) {
    const host = mockHost([model(call("write_project"), bad)]);
    assert.equal((await createTurn({ scope: "project", prompt: "当前创作目标", history: [], tools: [write], host }).run()).error, "host_model_failed");
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
    const output = await createTurn({ scope: "project", prompt: "为第一集生成草图", history: [
      { role: "user", content: "先检查素材" }, { role: "assistant", content: "已检查" },
    ], tools: [], host }).run();
    assert.equal(output.error, undefined);
    assert.deepEqual(observed, { prompt: "为第一集生成草图", history: [
      { role: "user", text: "先检查素材" }, { role: "assistant", text: "已检查" },
    ] });
    assert.deepEqual(host.requests[0].payload, { context: [{ ref: "history", index: 0 },
      { ref: "history", index: 1 }, { ref: "prompt" }], tools: [], plan: null });
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
  ]) assert.throws(() => createTurn({ scope: "project", ...context, tools: [], host }), /invalid_turn_context/);
});


test("context accepts exact Unicode and history limits", async () => {
  const host = mockHost([model()]);
  const history = Array.from({ length: 40 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: "😀".repeat(1200) }));
  assert.equal((await createTurn({ scope: "project", prompt: "😀".repeat(24000), history, tools: [], host }).run()).error, undefined);
});


test("Pi uses host model text, validated tool arguments and read results in its context", async () => {
  const schema = { type: "object", properties: { episode: { type: "integer" } }, required: ["episode"], additionalProperties: false };
  const calls = [];
  let seenContext, messages;
  const original = Agent.prototype.prompt;
  Agent.prototype.prompt = async function (...args) {
    this.subscribe((event) => { if (event.type === "tool_execution_end") seenContext = event; });
    await original.apply(this, args);
    messages = this.state.messages;
  };
  try {
    const host = { async request(kind, payload) {
      calls.push({ kind, payload });
      if (kind === "tool.call") return { ok: true, final: false, result: { ok: true, episode: 2, title: "第一集" } };
      return calls.length === 1 ? { parts: [{ type: "text", text: "先读取当前进度" },
        { type: "tool_call", id: "read-1", name: "read_project", arguments: { episode: 2 } }] }
        : { parts: [{ type: "text", text: "已检查" }] };
    } };
    const output = await createTurn({ scope: "project", prompt: "检查第一集", history: [], tools: [{ ...tool, parameters: schema }], host }).run();
    assert.equal(output.error, undefined);
    assert.deepEqual(calls[2].payload, { context: [{ ref: "prompt" }, { ref: "response", index: 1 },
      { ref: "tool", response: 1, id: "read-1" }], tools: ["read_project"], plan: null });
    assert.ok(!JSON.stringify(calls[2].payload).includes("第一集"));
    assert.deepEqual(calls[1], { kind: "tool.call", payload: { tool_call_id: "read-1", name: "read_project", arguments: { episode: 2 } } });
    assert.ok(JSON.stringify(seenContext).includes("第一集"));
    assert.ok(messages.some((message) => message.role === "assistant" && message.content.some((part) => part.type === "text" && part.text === "先读取当前进度")));
    assert.ok(messages.some((message) => message.role === "toolResult" && JSON.stringify(message.content).includes("第一集")));
  } finally { Agent.prototype.prompt = original; }
});


test("strict whole-batch validation rejects coerced values and duplicate IDs before any tool", async () => {
  const schema = { type: "object", additionalProperties: false, properties: {
    flag: { type: "boolean" }, number: { type: "number" }, count: { type: "integer" },
    optional: { type: "string" }, list: { type: "array", items: { type: "integer" } },
  } };
  const target = { ...write, parameters: schema };
  for (const args of [{ flag: 1 }, { number: true }, { count: 2.9 }, { count: "3" }, { count: 9007199254740992 }, { optional: null }, { list: 1 }]) {
    const host = mockHost([model(call(), { ...call("write_project"), id: "tool-2", arguments: args })]);
    assert.equal((await createTurn({ scope: "project", prompt: "生成", history: [], tools: [tool, target], host }).run()).error, "host_model_failed");
    assert.deepEqual(host.requests.map((item) => item.kind), ["model.call"]);
  }
  const duplicate = mockHost([model(call(), { ...call("write_project"), arguments: { flag: true } })]);
  assert.equal((await createTurn({ scope: "project", prompt: "生成", history: [], tools: [tool, target], host: duplicate }).run()).error, "host_model_failed");
  assert.deepEqual(duplicate.requests.map((item) => item.kind), ["model.call"]);
});

test("invalid schemas fail before requesting the host model", () => {
  const host = mockHost([]);
  for (const properties of [{ item: "string" }, { item: { type: "string", pattern: "(?P<id>\\d+)" } },
    { item: { $ref: "#/$defs/Missing" } }, { item: { type: "strnig" } },
    { item: { items: { type: "strnig" } } }, { item: { anyOf: [{ type: "strnig" }] } },
    { item: { prefixItems: [{ type: "strnig" }] } }, { item: { $defs: { bad: { type: "strnig" } } } },
    { item: { dependencies: { a: { type: "strnig" } } } }, { item: { unevaluatedItems: { type: "strnig" } } },
    { item: { $ref: "#/x-shared" } }]) {
    assert.throws(() => createTurn({ scope: "project", prompt: "生成", history: [], tools: [{ ...tool, parameters: {
      type: "object", properties, additionalProperties: false,
    } }], host }), /invalid_tool_definition/);
  }
  assert.deepEqual(host.requests, []);
});

test("tool result limit uses UTF-8 bytes and rejects invalid structures", () => {
  const overhead = Buffer.byteLength(JSON.stringify({ text: "" }), "utf8");
  const room = 256000 - overhead;
  const exact = { text: "中".repeat(Math.floor(room / 3)) + "x".repeat(room % 3) };
  assert.equal(Buffer.byteLength(JSON.stringify(exact), "utf8"), 256000);
  assert.equal(validToolResult({ ok: true, final: false, result: exact }), true);
  assert.equal(validToolResult({ ok: true, final: false, result: { text: exact.text + "x" } }), false);
  for (const result of [null, [], "x", undefined]) assert.equal(validToolResult({ ok: true, final: false, result }), false);
});


test("nested valid definitions and nullable schema run without changing values", async () => {
  const parameters = { type: "object", additionalProperties: false,
    $defs: { Choice: { anyOf: [{ type: "string" }, { type: "null" }] } },
    properties: { item: { $ref: "#/$defs/Choice" } }, required: ["item"] };
  const host = mockHost([model({ ...call("write_project"), arguments: { item: null } }), result(true)]);
  assert.equal((await createTurn({ scope: "project", prompt: "生成", history: [], tools: [{ ...write, parameters }], host }).run()).error, undefined);
  assert.deepEqual(host.requests[1].payload.arguments, { item: null });
});


test("safe numeric boundaries and nested unsafe numbers are checked", async () => {
  const parameters = { type: "object", additionalProperties: false,
    properties: { list: { type: "array", items: { type: "number" } } }, required: ["list"] };
  for (const value of [9007199254740991, -9007199254740991]) {
    const host = mockHost([model({ ...call("write_project"), arguments: { list: [value] } }), result(true)]);
    assert.equal((await createTurn({ scope: "project", prompt: "生成", history: [], tools: [{ ...write, parameters }], host }).run()).error, undefined);
  }
  for (const value of [9007199254740992, -9007199254740992, 1e16]) {
    const host = mockHost([model({ ...call("write_project"), arguments: { list: [value] } })]);
    assert.equal((await createTurn({ scope: "project", prompt: "生成", history: [], tools: [{ ...write, parameters }], host }).run()).error, "host_model_failed");
    assert.deepEqual(host.requests.map((item) => item.kind), ["model.call"]);
  }
});
