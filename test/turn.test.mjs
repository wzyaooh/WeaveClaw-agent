import assert from "node:assert/strict";
import test from "node:test";
import { createTurn } from "../src/turn.mjs";

const tool = { name: "read_project", description: "查看项目", parameters: { type: "object", properties: {}, additionalProperties: false } };
const write = { ...tool, name: "write_project" };
const text = { type: "text", text: "完成" };
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
const result = (final = false) => ({ kind: "tool.call", value: { final, result: { ok: true } } });

test("Pi asks the host for model and tool work and stops after a write", async () => {
  const host = mockHost([model(call("write_project")), result(true)]);
  const turn = createTurn({ prompt: "处理剧本", tools: [write], host });
  assert.deepEqual(await turn.run(), { aborted: false, error: undefined });
  assert.deepEqual(host.requests, [
    { kind: "model.call", payload: {} },
    { kind: "tool.call", payload: { tool_call_id: "tool-1", name: "write_project", arguments: {} } },
  ]);
  await assert.rejects(turn.run(), /turn_already_used/);
});

test("Pi returns a read result to the host before the next model call", async () => {
  const host = mockHost([model(call()), result(), model(text)]);
  const output = await createTurn({ prompt: "查看项目", tools: [tool], host }).run();
  assert.equal(output.error, undefined);
  assert.deepEqual(host.requests.map((item) => item.kind), ["model.call", "tool.call", "model.call"]);
});

test("a failed model or tool request stops without another host call", async () => {
  for (const replies of [[new Error("lost")], [model(call()), new Error("lost")]]) {
    const host = mockHost(replies);
    const output = await createTurn({ prompt: "查看项目", tools: [tool], host }).run();
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
  const turn = createTurn({ prompt: "查看项目", tools: [tool], host });
  const running = turn.run();
  await entered;
  turn.abort();
  assert.equal((await running).aborted, true);
  assert.deepEqual(requests, ["model.call"]);
});
