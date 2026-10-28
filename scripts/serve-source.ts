import { resolve, join } from "node:path";
import { relativeFile } from "../src/util.ts";
const root = resolve("examples/source");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 8765),
  async fetch(request) {
    try {
      const path = decodeURIComponent(new URL(request.url).pathname).replace(
        /^\//,
        "",
      );
      relativeFile(path);
      if (!path.endsWith(".json"))
        return new Response("not found", { status: 404 });
      const file = Bun.file(join(root, path));
      if (!(await file.exists()))
        return new Response("not found", { status: 404 });
      return new Response(file, {
        headers: { "Content-Type": "application/json" },
      });
    } catch {
      return new Response("bad request", { status: 400 });
    }
  },
});
console.log(
  `Piko example source: http://127.0.0.1:${server.port}/ (loopback only)`,
);
