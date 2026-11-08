import { connectHost } from "../src/transport.mjs";

let connection;
let stopping = false;
process.parentPort.on("message", async (event) => {
  if (event.data?.start && !connection) {
    try {
      connection = await connectHost(event.data.start);
      connection.closed.then((reason) => {
        if (!stopping) { process.parentPort.postMessage({ error: reason }); process.exit(1); }
      });
      process.parentPort.postMessage({ ready: true });
    } catch {
      process.parentPort.postMessage({ error: "connection_failed" });
      process.exit(1);
    }
  } else if (event.data?.stop) {
    stopping = true;
    connection?.close();
    process.exit(0);
  }
});
