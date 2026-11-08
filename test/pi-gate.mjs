import assert from "node:assert/strict";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { obj, str } from "@earendil-works/pi-schema";

const model = { id: "fixture", name: "fixture", provider: "fixture", api: "fixture", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 256 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function message(content, stopReason = "toolUse") {
  return { role: "assistant", content, api: "fixture", provider: "fixture", model: "fixture", usage, stopReason, timestamp: Date.now() };
}

function call(id) {
  return { type: "toolCall", id, name: "write", arguments: { value: id } };
}

async function run(calls, { stopReason = "toolUse", cancelDuringStream = false } = {}) {
  const effects = [];
  const events = [];
  let streamedToolEvents = 0;
  let streamedEffects = 0;
  let finishCalls = 0;
  const tool = {
    name: "write", label: "模拟写入", description: "测试工具", parameters: obj({ value: str() }),
    execute: async (_id, args) => {
      effects.push(args.value);
      return { content: [{ type: "text", text: "accepted" }], details: {}, terminate: true };
    },
  };
  const streamFn = (_model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    const final = message(calls, stopReason);
    options.signal.addEventListener("abort", () => {
      const aborted = message([], "aborted");
      stream.push({ type: "error", reason: "aborted", error: aborted });
    }, { once: true });
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message([]) });
      if (cancelDuringStream) return;
      if (calls.length) {
        const partial = message([calls[0]]);
        stream.push({ type: "toolcall_start", contentIndex: 0, partial });
        stream.push({ type: "toolcall_delta", contentIndex: 0, delta: '{"value":', partial });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: calls[0], partial });
      }
      stream.push({ type: "done", reason: final.stopReason, message: final });
    });
    return stream;
  };
  const agent = new Agent({
    initialState: { model, systemPrompt: "模拟创作助手", tools: [tool] },
    streamFn,
    toolExecution: "sequential",
    finishTurn: async () => { finishCalls += 1; return { action: "end" }; },
    beforeToolCall: async ({ assistantMessage }) => {
      const batch = assistantMessage.content.filter((part) => part.type === "toolCall");
      if (batch.filter((part) => part.name === "write").length > 1) return { block: true, terminate: true, reason: "多次写入被拒绝" };
    },
  });
  agent.subscribe((event) => {
    events.push(event);
    if (event.type === "message_update" && event.assistantMessageEvent.type.startsWith("toolcall_")) {
      streamedToolEvents += 1;
      streamedEffects = Math.max(streamedEffects, effects.length);
    }
    if (cancelDuringStream && event.type === "message_start" && event.message.role === "assistant") agent.abort();
  });
  await agent.prompt("模拟用户请求");
  assert.equal(streamedEffects, 0, "流式工具参数尚未完成时不得执行");
  return { effects, events, streamedToolEvents, finishCalls };
}

export async function verifyPiGate() {
  const single = await run([call("first")]);
  assert.deepEqual(single.effects, ["first"]);
  assert.equal(single.streamedToolEvents, 3);
  const assistantEnd = single.events.findIndex((event) => event.type === "message_end" && event.message.role === "assistant");
  const executionStart = single.events.findIndex((event) => event.type === "tool_execution_start");
  assert.ok(assistantEnd >= 0 && executionStart > assistantEnd, "完整助手消息应早于工具执行");

  const multiple = await run([call("second"), call("third")]);
  assert.deepEqual(multiple.effects, []);
  const multipleTurn = multiple.events.find((event) => event.type === "turn_end");
  assert.equal(multipleTurn.toolResults.length, 2);
  assert.ok(multipleTurn.toolResults.every((result) => result.isError));
  assert.equal(multiple.finishCalls, 1);

  const truncated = await run([call("truncated")], { stopReason: "length" });
  assert.deepEqual(truncated.effects, []);
  const truncatedTurn = truncated.events.find((event) => event.type === "turn_end");
  assert.equal(truncatedTurn.toolResults.length, 1);
  assert.equal(truncatedTurn.toolResults[0].isError, true);
  assert.equal(truncated.finishCalls, 1);

  const cancelled = await run([call("cancelled")], { cancelDuringStream: true });
  assert.deepEqual(cancelled.effects, []);
  assert.equal(cancelled.events.some((event) => event.type === "tool_execution_start"), false);
  assert.equal(cancelled.events.find((event) => event.type === "turn_end").message.stopReason, "aborted");
  return { checks: ["single_write", "complete_before_tool", "multiple_writes_blocked", "truncated_response_blocked", "cancelled_during_stream"] };
}
