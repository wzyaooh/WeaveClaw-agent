/** Map Pi's in-memory messages to references for host-owned facts only. */
import { isDeepStrictEqual } from "node:util";

export function createProjection(historyMessages, prompt) {
  const references = new WeakMap();
  historyMessages.forEach((message, index) => references.set(message, { ref: "history", index }));
  let promptMessage;
  let responseIndex = 0;
  const deliveries = [];
  const mappedDeliveries = new WeakMap();

  return {
    recordResponse(message) {
      if (!message || typeof message !== "object" || references.has(message)) throw new Error("invalid_context");
      responseIndex += 1;
      references.set(message, { ref: "response", index: responseIndex });
    },
    recordToolResult(id, name, result) {
      if (!responseIndex || typeof id !== "string" || !id || typeof name !== "string" || !name) throw new Error("invalid_context");
      deliveries.push({ ref: { ref: "tool", response: responseIndex, id }, name,
        content: [{ type: "text", text: JSON.stringify(result.result) }], isError: !result.ok });
    },
    project(messages) {
      if (!Array.isArray(messages)) throw new Error("invalid_context");
      let delivered = 0;
      const result = [];
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (!message || typeof message !== "object") throw new Error("invalid_context");
        if (message.role === "system" && index === 0) continue;
        let ref = references.get(message) ?? mappedDeliveries.get(message);
        if (!ref && message.role === "user" && !promptMessage &&
            isDeepStrictEqual(message.content, [{ type: "text", text: prompt }])) {
          promptMessage = message;
          ref = { ref: "prompt" };
          references.set(message, ref);
        }
        if (message.role === "toolResult") {
          const delivery = deliveries[delivered++];
          if (!delivery || message.toolCallId !== delivery.ref.id || message.toolName !== delivery.name ||
              !isDeepStrictEqual(message.content, delivery.content) || message.isError !== delivery.isError) {
            throw new Error("invalid_context");
          }
          if (ref && !isDeepStrictEqual(ref, delivery.ref)) throw new Error("invalid_context");
          ref = delivery.ref;
          mappedDeliveries.set(message, ref);
        }
        if (!ref) throw new Error("invalid_context");
        result.push(ref);
      }
      if (!promptMessage || delivered !== deliveries.length) throw new Error("invalid_context");
      return result;
    },
  };
}
