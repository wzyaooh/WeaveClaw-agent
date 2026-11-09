import assert from "node:assert/strict";
import test from "node:test";
import { createProjection } from "../src/context.mjs";
import { selectStrategy } from "../src/strategy.mjs";

test("strategy is fixed by available tools and contains no request data", () => {
  assert.deepEqual(selectStrategy([{}]), selectStrategy([{ secret: "private" }]));
  assert.equal(selectStrategy([{}]).id, "creation-v1");
  assert.equal(selectStrategy([]).id, "text-only-v1");
  assert.ok(!JSON.stringify(selectStrategy([{ secret: "private" }])).includes("private"));
});

test("projection is deterministic and contains only references to known messages", () => {
  const history = [{ role: "user", content: [{ type: "text", text: "private history" }], timestamp: 1 }];
  const prompt = { role: "user", content: [{ type: "text", text: "private prompt" }], timestamp: 2 };
  const response = { role: "assistant", content: [{ type: "toolCall", id: "one", name: "read", arguments: {} }], timestamp: 3 };
  const result = { role: "toolResult", toolCallId: "one", toolName: "read",
    content: [{ type: "text", text: '{"private":"host result"}' }], isError: false, timestamp: 4 };
  const projection = createProjection(history, "private prompt");
  projection.recordResponse(response);
  projection.recordToolResult("one", "read", { ok: true, result: { private: "host result" } });
  const messages = [{ role: "system" }, ...history, prompt, response, result];
  const expected = [{ ref: "history", index: 0 }, { ref: "prompt" }, { ref: "response", index: 1 },
    { ref: "tool", response: 1, id: "one" }];
  assert.deepEqual(projection.project(messages), expected);
  response.timestamp = 123;
  result.timestamp = 456;
  assert.deepEqual(projection.project(messages), expected);
  assert.ok(!JSON.stringify(expected).includes("private"));
  assert.throws(() => projection.project([...messages, { role: "assistant", content: [] }]), /invalid_context/);
  assert.throws(() => projection.project(messages.slice(0, -1)), /invalid_context/);
  assert.throws(() => projection.project([...messages.slice(0, -1), { ...result, content: [] }]), /invalid_context/);
});

test("unknown system, prompt, and unacknowledged tool results are rejected", () => {
  const projection = createProjection([], "target");
  const prompt = { role: "user", content: [{ type: "text", text: "target" }] };
  assert.throws(() => projection.project([{ role: "system" }, { role: "system" }, prompt]), /invalid_context/);
  assert.throws(() => projection.project([{ role: "system" }, { role: "user", content: [{ type: "text", text: "other" }] }]), /invalid_context/);
  assert.throws(() => projection.project([{ role: "system" }, prompt,
    { role: "toolResult", toolCallId: "unknown", toolName: "read", content: [], isError: false }]), /invalid_context/);
});
