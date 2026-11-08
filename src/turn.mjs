/** A single ephemeral Pi turn; model and business operations remain host-owned. */
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const MODEL = Object.freeze({ id: "host", name: "host", provider: "host", api: "host", baseUrl: "",
  input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000, maxTokens: 4096 });
const USAGE = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

function assistant(content, stopReason, errorMessage) {
  return { role: "assistant", content, api: "host", provider: "host", model: "host", usage: USAGE,
    stopReason, timestamp: Date.now(), ...(errorMessage ? { errorMessage } : {}) };
}

function contentFromHost(parts) {
  if (!Array.isArray(parts)) throw new Error("invalid_model_result");
  return parts.map((part) => {
    if (part?.type === "text" && typeof part.text === "string") return { type: "text", text: part.text };
    if (part?.type === "tool_call" && typeof part.id === "string" && typeof part.name === "string" &&
        part.arguments && typeof part.arguments === "object" && !Array.isArray(part.arguments)) {
      return { type: "toolCall", id: part.id, name: part.name, arguments: part.arguments };
    }
    throw new Error("invalid_model_result");
  });
}

/**
 * `host.request` is a local transport abstraction; it does not grant model or
 * tool access. Python must verify complete model responses and authorize every
 * proposed tool call. `tools` contains only host-supplied public definitions.
 */
export function createTurn({ prompt, tools, host }) {
  if (typeof prompt !== "string" || !Array.isArray(tools) || typeof host?.request !== "function") {
    throw new TypeError("invalid_turn_start");
  }
  let finished = false;
  let used = false;
  let failure;
  const mappedTools = tools.map((tool) => {
    if (typeof tool?.name !== "string" || typeof tool.description !== "string" ||
        !tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
      throw new TypeError("invalid_tool_definition");
    }
    return {
      name: tool.name, label: tool.name, description: tool.description, parameters: tool.parameters,
      execute: async (id, args, signal) => {
        if (finished || signal?.aborted) throw new Error("turn_finished");
        try {
          const value = await host.request("tool.call", { tool_call_id: id, name: tool.name, arguments: args }, signal);
          if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.final !== "boolean" ||
              !value.result || typeof value.result !== "object" || Array.isArray(value.result)) {
            throw new Error("invalid_tool_result");
          }
          if (value.final) finished = true;
          return { content: [{ type: "text", text: JSON.stringify(value.result) }], details: {},
            isError: value.result.ok === false, terminate: value.final };
        } catch (error) {
          finished = true;
          failure = signal?.aborted ? "aborted" : "host_tool_failed";
          throw error;
        }
      },
    };
  });
  const streamFn = (_model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    const signal = options.signal;
    const partial = assistant([], "stop");
    stream.push({ type: "start", partial });
    Promise.resolve().then(async () => {
      try {
        if (signal?.aborted) throw new Error("aborted");
        const result = await host.request("model.call", {}, signal);
        if (signal?.aborted) throw new Error("aborted");
        const content = contentFromHost(result?.parts);
        const message = assistant(content, content.some((part) => part.type === "toolCall") ? "toolUse" : "stop");
        stream.push({ type: "done", reason: message.stopReason, message });
      } catch (error) {
        failure = signal?.aborted ? "aborted" : "host_model_failed";
        const message = assistant([], signal?.aborted ? "aborted" : "error", failure);
        stream.push({ type: "error", reason: message.stopReason, error: message });
      }
    });
    return stream;
  };
  const agent = new Agent({ initialState: { model: MODEL, systemPrompt: "Follow the host's creative workflow.", tools: mappedTools },
    streamFn, toolExecution: "sequential", finishTurn: async () => finished ? { action: "end" } : undefined });
  return {
    abort: () => agent.abort(),
    async run() {
      if (used) throw new Error("turn_already_used");
      used = true;
      await agent.prompt(prompt);
      return { aborted: agent.signal?.aborted ?? failure === "aborted", error: failure };
    },
  };
}
