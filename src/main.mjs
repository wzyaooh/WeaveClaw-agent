/** Electron utilityProcess entry. Credentials arrive only over the parent port. */
import { createSupervisor } from "./supervisor.mjs";

if (!process.parentPort) throw new Error("utility_process_required");
const port = process.parentPort;
const supervisor = createSupervisor({ port, exit: (code) => setImmediate(() => process.exit(code)) });
port.on("message", (event) => { void supervisor.handle(event.data); });
for (const event of ["uncaughtException", "unhandledRejection"]) {
  process.once(event, () => {
    port.postMessage({ type: "error", code: "internal_error" });
    setImmediate(() => process.exit(1));
  });
}
