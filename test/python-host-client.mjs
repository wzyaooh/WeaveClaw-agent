/** Test-only helper: the parent sends a local endpoint and token via stdin. */
import { createInterface } from "node:readline";
import { connectHost } from "../src/transport.mjs";

if (Object.keys(process.env).some((key) => key.toUpperCase().startsWith("WEAVECLAW_"))) {
  process.stderr.write("INHERITED_APPLICATION_ENVIRONMENT\n");
  process.exit(1);
}
const input = createInterface({ input: process.stdin });
input.once("line", async (line) => {
  try {
    const connection = await connectHost(JSON.parse(line));
    process.stdout.write("READY\n");
    process.once("SIGTERM", () => { connection.close(); process.exit(0); });
  } catch {
    process.stderr.write("CONNECTION_FAILED\n");
    process.exit(1);
  }
});
