/** Local-only host transport. This module never invokes a model or business API. */
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { contentFromHost, createTurn, validToolResult } from "./turn.mjs";

const MAX_BYTES = 2 * 1024 * 1024;
const HOST_TYPES = new Set(["turn.start", "turn.abort", "model.result", "model.error", "tool.result"]);
const validId = (value) => typeof value === "string" && value.length > 0 && value.length <= 128 && !/[^A-Za-z0-9_-]/.test(value);
const newId = () => randomUUID().replaceAll("-", "");

function parseFrame(data, binary, expected) {
  if (binary || data.length > MAX_BYTES) throw new Error("invalid_frame");
  const frame = JSON.parse(data.toString("utf8"));
  if (!frame || typeof frame !== "object" || Array.isArray(frame) ||
      Object.keys(frame).sort().join(",") !== "payload,request_id,sequence,turn_id,type,version" ||
      frame.version !== 2 || !HOST_TYPES.has(frame.type) || !Number.isSafeInteger(frame.sequence) ||
      frame.sequence !== expected || !validId(frame.turn_id) || !validId(frame.request_id) ||
      !frame.payload || typeof frame.payload !== "object" || Array.isArray(frame.payload)) throw new Error("invalid_frame");
  return frame;
}

export function validateEndpoint(url, token) {
  let value;
  try { value = new URL(url); } catch { throw new Error("invalid_local_endpoint"); }
  if (value.protocol !== "ws:" || value.hostname !== "127.0.0.1" || !value.port ||
      value.pathname !== "/api/v1/desktop/orchestrator/ws" || value.search || value.hash ||
      value.username || value.password || typeof token !== "string" || token.length < 32 ||
      !/^[\x21-\x7e]+$/.test(token)) throw new Error("invalid_local_endpoint");
  return value.toString();
}

/** Connect once; any protocol violation or socket loss fails all active attempts.
 * `closed` resolves to `host_disconnected`, `protocol_error`, or `closed` when
 * the caller explicitly closes the connection. These are non-sensitive codes.
 */
export async function connectHost({ url, token }) {
  const socket = new WebSocket(validateEndpoint(url, token), {
    headers: { "x-weaveclaw-orchestrator-token": token },
    handshakeTimeout: 10_000, maxPayload: MAX_BYTES, perMessageDeflate: false,
  });
  let incoming = 0, outgoing = 0, closed = false;
  let resolveClosed;
  const disconnected = new Promise((resolve) => { resolveClosed = resolve; });
  const turns = new Map();
  const retired = new Map();
  const failAll = (reason = "host_disconnected") => {
    if (closed) return;
    closed = true;
    resolveClosed(reason);
    for (const attempt of turns.values()) {
      attempt.turn.abort();
      for (const pending of attempt.pending.values()) pending.reject(new Error("host_disconnected"));
      attempt.pending.clear();
    }
  };
  const stop = (reason = "protocol_error") => {
    failAll(reason);
    socket.terminate();
  };
  const send = (type, turnId, requestId, payload) => {
    if (closed || socket.readyState !== WebSocket.OPEN) throw new Error("host_disconnected");
    const frame = JSON.stringify({ version: 2, type, sequence: outgoing + 1,
      turn_id: turnId, request_id: requestId, payload });
    if (Buffer.byteLength(frame, "utf8") > MAX_BYTES) throw new Error("invalid_frame");
    outgoing += 1;
    socket.send(frame, (error) => { if (error) stop("host_disconnected"); });
  };
  const finish = (turnId, kind) => {
    const attempt = turns.get(turnId);
    if (!attempt) return;
    turns.delete(turnId);
    for (const [id, pending] of attempt.pending) {
      attempt.cancelled.set(id, pending.kind);
      pending.reject(new Error("turn_finished"));
    }
    attempt.pending.clear();
    retired.set(turnId, { cancelled: attempt.cancelled, discarded: 0 });
    if (retired.size > 512) retired.delete(retired.keys().next().value);
    if (!closed) {
      try { send(kind, turnId, newId(), {}); }
      catch (error) { stop(error?.message === "host_disconnected" ? "host_disconnected" : "protocol_error"); }
    }
  };
  const start = (frame) => {
    if (turns.size >= 32 || turns.has(frame.turn_id) || retired.has(frame.turn_id) ||
        Object.keys(frame.payload).sort().join(",") !== "history,prompt,scope,tools" || !Array.isArray(frame.payload.tools)) {
      throw new Error("invalid_turn_start");
    }
    const attempt = { pending: new Map(), cancelled: new Map(), turn: undefined };
    const host = { request(kind, payload, signal) {
      if (closed || signal?.aborted || turns.get(frame.turn_id) !== attempt || attempt.pending.size) {
        return Promise.reject(new Error("turn_finished"));
      }
      const id = newId();
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          if (attempt.pending.delete(id)) attempt.cancelled.set(id, kind);
          reject(new Error("aborted"));
        };
        const settle = (fn, value) => { signal?.removeEventListener("abort", onAbort); fn(value); };
        attempt.pending.set(id, { kind, resolve: (value) => settle(resolve, value), reject: (error) => settle(reject, error) });
        signal?.addEventListener("abort", onAbort, { once: true });
        try { send(kind, frame.turn_id, id, payload); } catch (error) {
          attempt.pending.delete(id);
          settle(reject, error);
          stop(error?.message === "host_disconnected" ? "host_disconnected" : "protocol_error");
        }
      });
    } };
    attempt.turn = createTurn({ tools: frame.payload.tools, prompt: frame.payload.prompt, history: frame.payload.history, scope: frame.payload.scope, host });
    turns.set(frame.turn_id, attempt);
    send("turn.accept", frame.turn_id, frame.request_id, { strategy: attempt.turn.strategy });
    void attempt.turn.run().then((result) => finish(frame.turn_id, result.error && !result.aborted ? "turn.error" : "turn.end"),
      () => finish(frame.turn_id, "turn.error"));
  };
  socket.on("message", (data, binary) => {
    if (closed) return;
    try {
      const frame = parseFrame(data, binary, incoming + 1);
      incoming = frame.sequence;
      if (frame.type === "turn.start") return start(frame);
      const attempt = turns.get(frame.turn_id);
      const old = retired.get(frame.turn_id);
      if (!attempt && !old) throw new Error("unknown_turn");
      if (frame.type === "turn.abort") {
        if (Object.keys(frame.payload).length) throw new Error("invalid_abort");
        if (attempt) attempt.turn.abort();
        else if (++old.discarded > 8) throw new Error("too_many_late_frames");
        return;
      }
      if (frame.type === "model.result") {
        if (Object.keys(frame.payload).join(",") !== "parts") throw new Error("invalid_result");
        contentFromHost(frame.payload.parts, null);
      }
      if (frame.type === "model.error" && Object.keys(frame.payload).length) throw new Error("invalid_result");
      if (frame.type === "tool.result" && !validToolResult(frame.payload)) throw new Error("invalid_result");
      const pending = attempt?.pending.get(frame.request_id);
      const cancelled = attempt?.cancelled ?? old.cancelled;
      const kind = pending?.kind ?? cancelled.get(frame.request_id);
      if (!kind || (kind === "model.call" && !["model.result", "model.error"].includes(frame.type)) ||
          (kind === "tool.call" && frame.type !== "tool.result")) throw new Error("invalid_result");
      if (!pending) {
        cancelled.delete(frame.request_id);
        if (old && ++old.discarded > 8) throw new Error("too_many_late_frames");
        return;
      }
      attempt.pending.delete(frame.request_id);
      if (frame.type === "model.error") pending.reject(new Error("host_model_failed"));
      else pending.resolve(frame.payload);
    } catch (error) { stop(error?.message === "host_disconnected" ? "host_disconnected" : "protocol_error"); }
  });
  socket.on("close", () => failAll());
  socket.on("error", (error) => failAll(error?.code?.startsWith("WS_ERR_") ? "protocol_error" : "host_disconnected"));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", () => reject(new Error("host_connection_failed")));
    socket.once("close", () => { if (socket.readyState !== WebSocket.OPEN) reject(new Error("host_connection_failed")); });
  });
  const close = () => {
    if (closed) return;
    failAll("closed");
    if (socket.readyState !== WebSocket.OPEN) { socket.terminate(); return; }
    const timer = setTimeout(() => socket.terminate(), 2000);
    timer.unref();
    socket.once("close", () => clearTimeout(timer));
    try { socket.close(1000); } catch { clearTimeout(timer); socket.terminate(); }
  };
  return { close, closed: disconnected, get connected() { return !closed; } };
}
