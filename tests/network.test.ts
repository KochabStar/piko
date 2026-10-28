import { expect, test } from "bun:test";
import { download } from "../src/util.ts";

test("connection errors identify the failing endpoint without leaking URL query secrets", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("unused"),
  });
  const port = server.port;
  server.stop(true);
  const endpoint = `http://127.0.0.1:${port}/artifact.zip?token=DO_NOT_LOG_THIS`;
  try {
    await download(endpoint);
    throw new Error("Expected a refused connection");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain(`http://127.0.0.1:${port}/artifact.zip`);
    expect(message).toContain("ECONNREFUSED");
    expect(message).not.toContain("DO_NOT_LOG_THIS");
  }
});
