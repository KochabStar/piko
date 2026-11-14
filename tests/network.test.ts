import { expect, test } from "bun:test";
import {
  download,
  downloadResponse,
  stallMessage,
  transferWatch,
} from "../src/util.ts";

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

test("a slow but progressing transfer is never cut off, only a silent one is", async () => {
  const chunks = 8,
    size = 8,
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      async fetch() {
        const stream = new ReadableStream({
          async start(controller) {
            for (let i = 0; i < chunks; i++) {
              controller.enqueue(new Uint8Array(size));
              // Each gap is longer than the watchdog, the transfer is not idle.
              await Bun.sleep(150);
            }
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { "Content-Length": String(chunks * size) },
        });
      },
    });
  const url = `http://127.0.0.1:${server.port}/slow`;
  try {
    const watch = transferWatch(300);
    try {
      const response = await downloadResponse(url, { signal: watch.signal });
      const reader = response.body!.getReader();
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        watch.touch();
        received += value.length;
      }
      expect(received).toBe(chunks * size);
      expect(watch.stalled()).toBe(false);
    } finally {
      watch.dispose();
    }
    // The same watchdog aborts a transfer that stops delivering bytes.
    const stalled = transferWatch(100);
    try {
      const response = await downloadResponse(url, {
        signal: stalled.signal,
      });
      const reader = response.body!.getReader();
      await expect(
        (async () => {
          for (;;) if ((await reader.read()).done) return;
        })(),
      ).rejects.toThrow();
      expect(stalled.stalled()).toBe(true);
    } finally {
      stalled.dispose();
    }
  } finally {
    server.stop(true);
  }
});

test("stall and drop errors stay retryable and never disclose URL secrets", async () => {
  const bytes = new Uint8Array(64 * 1024),
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      async fetch() {
        const stream = new ReadableStream({
          async start(controller) {
            controller.enqueue(bytes.subarray(0, 1024));
            await Bun.sleep(50);
            controller.error(new Error("connection reset"));
          },
        });
        return new Response(stream, {
          headers: { "Content-Length": String(bytes.length) },
        });
      },
    });
  const url = `http://127.0.0.1:${server.port}/file?token=DO_NOT_LOG_THIS`;
  try {
    await expect(download(url)).rejects.toMatchObject({ transient: true });
    const message = stallMessage(url);
    expect(message).toContain("stalled");
    expect(message).not.toContain("DO_NOT_LOG_THIS");
  } finally {
    server.stop(true);
  }
});
