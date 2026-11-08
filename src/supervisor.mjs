/** Supervises one local connection without holding model or desktop credentials. */
import { connectHost, validateEndpoint } from "./transport.mjs";

export function createSupervisor({ port, connect = connectHost, exit, env = process.env }) {
  let state = "idle";
  let connection;
  const finish = (code, status = 1) => {
    if (state === "done") return;
    state = "done";
    connection?.close();
    if (code) port.postMessage({ type: "error", code });
    exit(status);
  };
  // The Electron parent must supply an explicit minimal environment. Checking
  // names here is defense in depth; NODE_OPTIONS can act before this code runs.
  const unsafe = Object.keys(env).some((key) => key.toUpperCase() !== "SYSTEMROOT");
  if (unsafe) { finish("unsafe_environment"); return { handle: () => {} }; }
  const handle = async (message) => {
    if (state === "done") return;
    if (message?.type === "stop" && Object.keys(message).join(",") === "type") {
      finish(undefined, 0);
      return;
    }
    if (message?.type !== "start") { finish("invalid_message"); return; }
    if (state !== "idle") { finish("already_started"); return; }
    if (Object.keys(message).sort().join(",") !== "token,type,url") { finish("invalid_start"); return; }
    try { validateEndpoint(message.url, message.token); }
    catch { finish("invalid_start"); return; }
    state = "starting";
    try {
      const opened = await connect({ url: message.url, token: message.token });
      if (state === "done") { opened.close(); return; }
      connection = opened;
      state = "ready";
      opened.closed.then((reason) => {
        if (state === "ready") finish(reason);
      });
      port.postMessage({ type: "ready" });
    } catch {
      if (state !== "done") finish("connection_failed");
    }
  };
  return { handle };
}
