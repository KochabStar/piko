import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Packages } from "../src/packages.ts";
import { sha256 } from "../src/util.ts";

const root = await mkdtemp(join(tmpdir(), "piko-vendor-latest-"));
const bytes = Buffer.from("fixture payload");
let online = true;
const versions: Record<string, string[]> = {
  vendor: ["5.2.6.32774", "5.2.7.32913"],
  build: ["4-4214", "4-4215"],
  semantic: ["1.0.0", "2.0.0"],
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request): Response {
    if (!online) return new Response("offline", { status: 503 });
    const path = new URL(request.url).pathname;
    if (path === "/index.json")
      return Response.json({
        schemaVersion: 1,
        packages: Object.fromEntries(
          Object.entries(versions).map(([name, all]) => [
            name,
            {
              latest: all.at(-1),
              versions: Object.fromEntries(
                all.map((v) => [v, `${name}/${v}.json`]),
              ),
            },
          ]),
        ),
      });
    if (path === "/file") return new Response(bytes);
    const [name, filename] = path.slice(1).split("/");
    const version = filename?.replace(/\.json$/, "");
    if (!name || !version || !versions[name]?.includes(version))
      return new Response("not found", { status: 404 });
    return Response.json({
      schemaVersion: 1,
      name,
      version,
      platforms: {
        "windows-x64": {
          url: `http://127.0.0.1:${server.port}/file`,
          sha256: sha256(bytes),
          format: "file",
          file: "tool.exe",
          bin: {},
        },
      },
    });
  },
});
afterAll(async () => {
  server.stop(true);
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
});
test("use latest respects cached source vendor/build versions offline, without guessing or installing missing versions", async () => {
  const manager = new Packages(root);
  await manager.addSource("main", `http://127.0.0.1:${server.port}/`);
  for (const name of ["vendor", "build"])
    for (const version of versions[name]!)
      await manager.install(`main/${name}@${version}`);
  await manager.install("main/semantic@1.0.0");
  online = false;
  for (const name of ["vendor", "build", "semantic"])
    await manager.use(`main/${name}@latest`);
  let state = await manager.store.read();
  for (const [name, expected] of [
    ["vendor", "5.2.7.32913"],
    ["build", "4-4215"],
    ["semantic", "1.0.0"],
  ]) {
    const chosen = Object.values(state.installs).find(
      (i) => i.name === name && state.defaults[i.key]?.id === i.id,
    )!;
    expect(chosen.version).toBe(expected);
    expect(state.defaults[chosen.key]?.request).toBe("latest");
  }
  expect(Object.keys(state.installs)).toHaveLength(5);
  await manager.use("main/vendor@5.2.6.32774");
  state = await manager.store.read();
  const before = await readFile(manager.store.statePath, "utf8");
  const selected = Object.values(state.installs).find(
    (i) => i.name === "vendor" && state.defaults[i.key]?.id === i.id,
  )!;
  expect(selected.version).toBe("5.2.6.32774");
  await expect(manager.use("main/vendor@5")).rejects.toThrow();
  expect(await readFile(manager.store.statePath, "utf8")).toBe(before);
});
