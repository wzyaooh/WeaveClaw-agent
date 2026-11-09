/** A single ephemeral Pi turn; model and business operations remain host-owned. */
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const MAX_PROMPT_CHARS = 24_000;
const MAX_HISTORY_MESSAGES = 40;
const MAX_HISTORY_CHARS = 48_000;

function codePointCountWithin(value, limit) {
  if (value.length > limit * 2) return -1;
  let count = 0;
  for (const _character of value) if (++count > limit) return -1;
  return count;
}

const MODEL = Object.freeze({ id: "host", name: "host", provider: "host", api: "host", baseUrl: "",
  input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000, maxTokens: 4096 });
const USAGE = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

function assistant(content, stopReason, errorMessage) {
  return { role: "assistant", content, api: "host", provider: "host", model: "host", usage: USAGE,
    stopReason, timestamp: Date.now(), ...(errorMessage ? { errorMessage } : {}) };
}

export function contentFromHost(parts, allowed) {
  if (allowed === undefined) throw new TypeError("allowlist_required");
  if (!Array.isArray(parts)) throw new Error("invalid_model_result");
  return parts.map((part) => {
    if (part?.type === "tool_call" && Object.keys(part).sort().join(",") === "arguments,id,name,type" &&
        typeof part.id === "string" && part.id && typeof part.name === "string" &&
        (!allowed || allowed.has(part.name)) && part.arguments &&
        typeof part.arguments === "object" && !Array.isArray(part.arguments) && Object.keys(part.arguments).length === 0) {
      return { type: "toolCall", id: part.id, name: part.name, arguments: part.arguments };
    }
    throw new Error("invalid_model_result");
  });
}

/**
 * `host.request` is a local transport abstraction; it does not grant model or
 * tool access. The bounded prompt and text history are provided to Pi locally.
 * Python must verify complete model responses and authorize every
 * proposed tool call. `tools` contains only host-supplied empty schemas. Model
 * requests use `{}`; tool requests carry only the ID, name and empty arguments.
 * Model `{parts}` contain only empty-argument tool calls with nonempty IDs and
 * names declared in `tools`, never text; `{parts: []}` ends a text-only turn.
 * Tool results contain exactly `{ok, final}`. Each pending request receives its
 * own abort signal, which is detached once the request settles.
 */
export function createTurn(input) {
  if (!input || typeof input !== "object" || Object.keys(input).sort().join(",") !== "history,host,prompt,tools") {
    throw new TypeError("invalid_turn_start");
  }
  const { tools, host, prompt, history } = input;
  if (typeof prompt !== "string" || !prompt || codePointCountWithin(prompt, MAX_PROMPT_CHARS) < 0 ||
      !Array.isArray(history) || history.length > MAX_HISTORY_MESSAGES) {
    throw new TypeError("invalid_turn_context");
  }
  let remaining = MAX_HISTORY_CHARS;
  for (const item of history) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        Object.keys(item).sort().join(",") !== "content,role" ||
        !["user", "assistant"].includes(item.role) || typeof item.content !== "string" || !item.content) {
      throw new TypeError("invalid_turn_context");
    }
    const count = codePointCountWithin(item.content, remaining);
    if (count < 0) throw new TypeError("invalid_turn_context");
    remaining -= count;
  }
  if (!Array.isArray(tools) || typeof host?.request !== "function") {
    throw new TypeError("invalid_turn_start");
  }
  let finished = false;
  let used = false;
  let failure;
  let expectedCalls = 0;
  let deliveredCalls = 0;
  const names = new Set();
  const request = async (kind, payload, signal) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      if (controller.signal.aborted) throw new Error("aborted");
      return await host.request(kind, payload, controller.signal);
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  };
  const mappedTools = tools.map((tool) => {
    if (typeof tool?.name !== "string" || typeof tool.description !== "string" ||
        !tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters) ||
        names.has(tool.name) || tool.parameters.type !== "object" || tool.parameters.additionalProperties !== false ||
        !tool.parameters.properties || typeof tool.parameters.properties !== "object" ||
        Array.isArray(tool.parameters.properties) || Object.keys(tool.parameters.properties).length !== 0 ||
        Object.keys(tool.parameters).sort().join(",") !== "additionalProperties,properties,type") {
      throw new TypeError("invalid_tool_definition");
    }
    names.add(tool.name);
    return {
      name: tool.name, label: tool.name, description: tool.description, parameters: tool.parameters,
      execute: async (id, _args, signal) => {
        if (finished || signal?.aborted) throw new Error("turn_finished");
        try {
          deliveredCalls += 1;
          const value = await request("tool.call", { tool_call_id: id, name: tool.name, arguments: {} }, signal);
          if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.final !== "boolean" ||
              typeof value.ok !== "boolean" || Object.keys(value).sort().join(",") !== "final,ok") {
            throw new Error("invalid_tool_result");
          }
          if (value.final) {
            finished = true;
            agent.abort();
          }
          return { content: [{ type: "text", text: value.ok ? "ok" : "failed" }], details: {},
            isError: !value.ok, terminate: value.final };
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
        const result = await request("model.call", {}, signal);
        if (signal?.aborted) throw new Error("aborted");
        const content = contentFromHost(result?.parts, names);
        expectedCalls = content.length;
        deliveredCalls = 0;
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
  const priorMessages = history.map((item) => item.role === "user"
    ? { role: "user", content: [{ type: "text", text: item.content }], timestamp: Date.now() }
    : assistant([{ type: "text", text: item.content }], "stop"));
  const agent = new Agent({ initialState: { model: MODEL, systemPrompt: "Follow the host's creative workflow.",
    messages: priorMessages, tools: mappedTools },
    streamFn, toolExecution: "sequential", finishTurn: async (_turn, signal) => {
      if (!finished && deliveredCalls !== expectedCalls) {
        finished = true;
        failure = signal?.aborted ? "aborted" : "host_tool_failed";
      }
      return finished ? { action: "end" } : undefined;
    } });
  return {
    abort: () => agent.abort(),
    async run() {
      if (used) throw new Error("turn_already_used");
      used = true;
      await agent.prompt(prompt);
      return { aborted: failure === "aborted", error: failure };
    },
  };
}
