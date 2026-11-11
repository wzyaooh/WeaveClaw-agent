/** A single ephemeral Pi turn; model and business operations remain host-owned. */
import { Agent } from "@earendil-works/pi-agent-core";
import { compile } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";
import { isDeepStrictEqual } from "node:util";
import { createAssistantMessageEventStream, validateToolArguments } from "@earendil-works/pi-ai";
import { createProjection } from "./context.mjs";
import { selectStrategy } from "./strategy.mjs";
import { createWorkflow } from "./workflow.mjs";

const MAX_PROMPT_CHARS = 24_000;
const MAX_HISTORY_MESSAGES = 40;
const MAX_HISTORY_CHARS = 48_000;

function codePointCountWithin(value, limit) {
  if (value.length > limit * 2) return -1;
  let count = 0;
  for (const _character of value) if (++count > limit) return -1;
  return count;
}

const JSON_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
function checkSchemaTypes(schema) {
  if (typeof schema === "boolean") return;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("invalid_schema");
  if (Object.hasOwn(schema, "$ref") &&
      (typeof schema.$ref !== "string" || !/^#\/(?:\$defs|definitions)\/[^/]+$/.test(schema.$ref))) throw new Error("invalid_schema");
  if (Object.hasOwn(schema, "type")) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.length || types.some((type) => typeof type !== "string" || !JSON_TYPES.has(type))) throw new Error("invalid_schema");
  }
  for (const key of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]) {
    if (schema[key] && typeof schema[key] === "object" && !Array.isArray(schema[key])) {
      for (const child of Object.values(schema[key])) checkSchemaTypes(child);
    }
  }
  if (schema.dependencies && typeof schema.dependencies === "object" && !Array.isArray(schema.dependencies)) {
    for (const child of Object.values(schema.dependencies)) if (!Array.isArray(child)) checkSchemaTypes(child);
  }
  for (const key of ["items", "additionalProperties", "unevaluatedProperties", "unevaluatedItems", "additionalItems", "contains", "propertyNames", "not", "if", "then", "else"]) {
    if (schema[key] !== undefined) {
      if (Array.isArray(schema[key])) for (const child of schema[key]) checkSchemaTypes(child);
      else checkSchemaTypes(schema[key]);
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    if (Array.isArray(schema[key])) for (const child of schema[key]) checkSchemaTypes(child);
  }
}
function safeNumbers(value) {
  if (typeof value === "number") return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  if (Array.isArray(value)) return value.every(safeNumbers);
  if (value && typeof value === "object") return Object.values(value).every(safeNumbers);
  return true;
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
    if (part?.type === "text" && Object.keys(part).sort().join(",") === "text,type" && typeof part.text === "string") {
      return { type: "text", text: part.text };
    }
    if (part?.type === "tool_call" && Object.keys(part).sort().join(",") === "arguments,id,name,type" &&
        typeof part.id === "string" && part.id && typeof part.name === "string" &&
        (!allowed || allowed.has(part.name)) && part.arguments &&
        typeof part.arguments === "object" && !Array.isArray(part.arguments)) {
      return { type: "toolCall", id: part.id, name: part.name, arguments: part.arguments };
    }
    throw new Error("invalid_model_result");
  });
}

export function validToolResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.final !== "boolean" || typeof value.ok !== "boolean" ||
      Object.keys(value).sort().join(",") !== "final,ok,result" ||
      !value.result || typeof value.result !== "object" || Array.isArray(value.result)) return false;
  try { return Buffer.byteLength(JSON.stringify(value.result), "utf8") <= 256_000; }
  catch { return false; }
}

/**
 * `host.request` is a local transport abstraction; it does not grant model or
 * tool access. The bounded prompt and text history are provided to Pi locally.
 * Python must verify complete model responses and authorize every
 * proposed tool call. The host supplies schemas, complete validated model text
 * and tool proposals, and bounded business results over the authenticated local
 * link. Python remains authoritative for execution, access and receipts.
 * `model.call` contains only references; `tool.call` includes Pi-validated args.
 * Each pending request receives its own abort signal, detached on settlement.
 */
export function createTurn(input) {
  if (!input || typeof input !== "object" || Object.keys(input).filter((key) => key !== "last_episode").sort().join(",") !== "history,host,limits,prompt,scope,tools") {
    throw new TypeError("invalid_turn_start");
  }
  const { tools, host, prompt, history, scope, limits, last_episode = null } = input;
  if (last_episode !== null && (!Number.isSafeInteger(last_episode) || last_episode < 1 || last_episode > 10000)) {
    throw new TypeError("invalid_turn_start");
  }
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
  if (!Array.isArray(tools) || typeof host?.request !== "function" || !["home", "project"].includes(scope)) {
    throw new TypeError("invalid_turn_start");
  }
  if (!limits || typeof limits !== "object" || Array.isArray(limits) ||
      Object.keys(limits).sort().join(",") !== "max_model_calls,max_tool_calls_per_response" ||
      !Number.isSafeInteger(limits.max_model_calls) || limits.max_model_calls < 1 || limits.max_model_calls > 100 ||
      !Number.isSafeInteger(limits.max_tool_calls_per_response) || limits.max_tool_calls_per_response < 1 || limits.max_tool_calls_per_response > 100) {
    throw new TypeError("invalid_turn_start");
  }
  let finished = false;
  let used = false;
  let failure;
  let expectedCalls = 0;
  let deliveredCalls = 0;
  const names = new Set();
  const validators = new Map();
  let originals = new Map();
  const strategy = selectStrategy(tools, last_episode);
  const priorMessages = history.map((item) => item.role === "user"
    ? { role: "user", content: [{ type: "text", text: item.content }], timestamp: Date.now() }
    : assistant([{ type: "text", text: item.content }], "stop"));
  const projection = createProjection(priorMessages, prompt);
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
        Array.isArray(tool.parameters.properties)) {
      throw new TypeError("invalid_tool_definition");
    }
    try { checkSchemaTypes(tool.parameters); validators.set(tool.name, compile(tool.parameters, { formats })); }
    catch { throw new TypeError("invalid_tool_definition"); }
    names.add(tool.name);
    return {
      name: tool.name, label: tool.name, description: tool.description, parameters: tool.parameters,
      execute: async (id, args, signal) => {
        if (finished || signal?.aborted) throw new Error("turn_finished");
        try {
          const original = originals.get(id);
          if (!original || original.name !== tool.name || !isDeepStrictEqual(args, original.arguments)) {
            throw new Error("tool_arguments_changed");
          }
          deliveredCalls += 1;
          const value = await request("tool.call", { tool_call_id: id, name: tool.name, arguments: original.arguments }, signal);
          if (!validToolResult(value)) throw new Error("invalid_tool_result");
          projection.recordToolResult(id, tool.name, value);
          workflow.observe(tool.name, original.arguments, value);
          if (value.final) {
            finished = true;
            agent.abort();
          }
          return { content: [{ type: "text", text: JSON.stringify(value.result) }], details: {},
            isError: !value.ok, terminate: value.final };
        } catch (error) {
          finished = true;
          failure = signal?.aborted ? "aborted" : "host_tool_failed";
          throw error;
        }
      },
    };
  });
  const workflow = createWorkflow([...names], last_episode, null, scope);
  const streamFn = (_model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const signal = options.signal;
    const partial = assistant([], "stop");
    stream.push({ type: "start", partial });
    Promise.resolve().then(async () => {
      try {
        if (signal?.aborted) throw new Error("aborted");
        const proposal = workflow.plan();
        // Protocol v2 sends only host-validated references and plan fields. Progress and batch remain local.
        const result = await request("model.call", { context: projection.project(context.messages), tools: proposal.tools, plan: proposal.plan }, signal);
        if (signal?.aborted) throw new Error("aborted");
        const content = contentFromHost(result?.parts, new Set(proposal.tools));
        // Reject invalid, duplicated or SDK-coerced calls before the first tool.
        const batch = new Map();
        for (const part of content) {
          if (part.type !== "toolCall") continue;
          const tool = mappedTools.find((item) => item.name === part.name);
          if (batch.has(part.id) || !workflow.allows(part.name, part.arguments) || !safeNumbers(part.arguments) || !validators.get(part.name).check(part.arguments) ||
              !isDeepStrictEqual(validateToolArguments(tool, part), part.arguments)) {
            throw new Error("invalid_tool_arguments");
          }
          batch.set(part.id, { name: part.name, arguments: structuredClone(part.arguments) });
        }
        originals = batch;
        expectedCalls = content.filter((part) => part.type === "toolCall").length;
        deliveredCalls = 0;
        const message = assistant(content, content.some((part) => part.type === "toolCall") ? "toolUse" : "stop");
        projection.recordResponse(message);
        stream.push({ type: "done", reason: message.stopReason, message });
      } catch (error) {
        failure = signal?.aborted ? "aborted" : "host_model_failed";
        const message = assistant([], signal?.aborted ? "aborted" : "error", failure);
        stream.push({ type: "error", reason: message.stopReason, error: message });
      }
    });
    return stream;
  };
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
    strategy,
    abort: () => agent.abort(),
    async run() {
      if (used) throw new Error("turn_already_used");
      used = true;
      await agent.prompt(prompt);
      return { aborted: failure === "aborted", error: failure };
    },
  };
}
