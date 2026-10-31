import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Packages } from "../src/packages.ts";
import { sha256 } from "../src/util.ts";

const work = await mkdtemp(join(tmpdir(), "piko-update-performance-"));
const names = ["alpha", "beta", "gamma"];
const bytes = Buffer.from("verified portable fixture");
const hash = sha256(bytes);
afterAll(() =>
  rm(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
);

async function fixture() {
  let latest = "1.0.0";
  let unavailable = false;
  let changedManifest = false;
  const requests = new Map<string, number>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request): Response {
      const path = new URL(request.url).pathname;
      requests.set(path, (requests.get(path) ?? 0) + 1);
      if (path === "/index.json")
        return unavailable
          ? new Response("unavailable", { status: 503 })
          : Response.json({
              schemaVersion: 1,
              packages: Object.fromEntries(
                names.map((name) => [
                  name,
                  {
                    latest,
                    versions: {
                      "1.0.0": `${name}-1.0.0.json`,
                      "1.1.0": `${name}-1.1.0.json`,
                    },
                  },
                ]),
              ),
            });
      if (path === "/file.exe") return new Response(bytes);
      const match = /^\/(alpha|beta|gamma)-(1\.[01]\.0)\.json$/.exec(path);
      if (!match) return new Response("missing", { status: 404 });
      const [, name, version] = match;
      return Response.json({
        schemaVersion: 1,
        name,
        version,
        platforms: {
          "windows-x64": {
            url: `http://127.0.0.1:${server.port}/file.exe`,
            sha256: changedManifest ? "0".repeat(64) : hash,
            format: "file",
            file: `${name}.exe`,
            bin: { [name!]: `${name}.exe` },
          },
        },
      });
    },
  });
  try {
    const root = await mkdtemp(join(work, "home-"));
    const packages = new Packages(root);
    await packages.addSource("main", `http://127.0.0.1:${server.port}/`);
    for (const name of names) {
      await packages.install(`main/${name}`);
      await packages.use(`main/${name}@latest`);
    }
    requests.clear();
    return {
      packages,
      server,
      requests,
      publish() {
        latest = "1.1.0";
      },
      failSource() {
        unavailable = true;
      },
      changeManifest() {
        changedManifest = true;
      },
    };
  } catch (error) {
    server.stop(true);
    throw error;
  }
}

test("unchanged batches refresh a shared source once, revalidate manifests and never commit or reselect", async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.packages.store.statePath, "utf8");
    let commits = 0;
    const commit = f.packages.store.commit.bind(f.packages.store);
    f.packages.store.commit = async (...args) => {
      commits++;
      return commit(...args);
    };
    const rows = await f.packages.updateAll();
    expect(rows.map((row) => row.status)).toEqual(names.map(() => "unchanged"));
    expect(f.requests.get("/index.json")).toBe(1);
    expect(f.requests.has("/file.exe")).toBe(false);
    for (const name of names)
      expect(f.requests.get(`/${name}-1.0.0.json`)).toBe(1);
    expect(commits).toBe(0);
    expect(await readFile(f.packages.store.statePath, "utf8")).toBe(before);

    f.requests.clear();
    f.publish();
    expect((await f.packages.updateAll()).map((row) => row.status)).toEqual(
      names.map(() => "updated"),
    );
    expect(f.requests.get("/index.json")).toBe(1);
    const state = await f.packages.store.read();
    expect(Object.keys(state.installs)).toHaveLength(6);
    for (const selection of Object.values(state.defaults))
      expect(state.installs[selection.id]?.version).toBe("1.1.0");

    f.requests.clear();
    const after = await readFile(f.packages.store.statePath, "utf8");
    expect((await f.packages.updateAll()).map((row) => row.status)).toEqual(
      names.map(() => "unchanged"),
    );
    expect(f.requests.get("/index.json")).toBe(1);
    expect(await readFile(f.packages.store.statePath, "utf8")).toBe(after);
  } finally {
    f.server.stop(true);
  }
});

test("source failures are shared within a batch, never fall back to stale metadata, and retry next invocation", async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.packages.store.statePath, "utf8");
    f.failSource();
    expect((await f.packages.updateAll()).map((row) => row.status)).toEqual(
      names.map(() => "failed"),
    );
    expect(f.requests.get("/index.json")).toBe(1);
    expect(f.requests.size).toBe(1);
    expect(await readFile(f.packages.store.statePath, "utf8")).toBe(before);
    expect(
      (await f.packages.updateAll()).every((r) => r.status === "failed"),
    ).toBe(true);
    expect(f.requests.get("/index.json")).toBe(2);
    expect(await readFile(f.packages.store.statePath, "utf8")).toBe(before);
  } finally {
    f.server.stop(true);
  }
});

test("single and batch no-op updates still reject changed manifests without changing defaults", async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.packages.store.statePath, "utf8");
    f.changeManifest();
    await expect(f.packages.update("main/alpha")).rejects.toThrow(
      "different manifest content",
    );
    f.requests.clear();
    const rows = await f.packages.updateAll();
    expect(rows.every((row) => row.status === "failed")).toBe(true);
    expect(
      rows.every(
        (row) =>
          "error" in row && row.error?.includes("different manifest content"),
      ),
    ).toBe(true);
    expect(f.requests.get("/index.json")).toBe(1);
    expect(await readFile(f.packages.store.statePath, "utf8")).toBe(before);
  } finally {
    f.server.stop(true);
  }
});
