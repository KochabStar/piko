import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Packages } from "../src/packages.ts";
import { chooseVersion, versionNewer } from "../src/catalog.ts";
import { updateTable } from "../src/display.ts";
import { sha256 } from "../src/util.ts";

// Sources repack an unchanged upstream version as `<upstream>-piko.N`; those
// builds are published later and must compare as newer than the plain release.
const root = await mkdtemp(join(tmpdir(), "piko-repack-"));
const bytes = Buffer.from("repack fixture payload");
let available: Record<string, string[]> = {
  app: ["5.13.1", "5.13.1-piko.1"],
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request): Response {
    const path = new URL(request.url).pathname;
    if (path === "/index.json")
      return Response.json({
        schemaVersion: 1,
        packages: Object.fromEntries(
          Object.entries(available).map(([name, all]) => [
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
    if (!name || !version || !available[name]?.includes(version))
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

test("repack ordering treats -piko.N as newer builds of the same release", () => {
  expect(versionNewer("5.13.1-piko.1", "5.13.1")).toBe(true);
  expect(versionNewer("5.13.1", "5.13.1-piko.1")).toBe(false);
  expect(versionNewer("5.13.1-piko.2", "5.13.1-piko.1")).toBe(true);
  expect(versionNewer("5.13.1-piko.1", "5.13.1-piko.2")).toBe(false);
  expect(versionNewer("5.13.2", "5.13.1-piko.9")).toBe(true);
  expect(versionNewer("5.13.1-piko.9", "5.13.2")).toBe(false);
  expect(versionNewer("5.13.1-piko.1", "5.13.1-piko.1")).toBe(false);
  expect(versionNewer("5.13.1", "5.13.1")).toBe(false);
  // Real prereleases keep their semver meaning below the release.
  expect(versionNewer("5.13.1-beta.1", "5.13.1")).toBe(false);
  expect(versionNewer("5.13.1", "5.13.1-beta.1")).toBe(true);
  // chooseVersion falls back to the newest stable-or-repack version.
  expect(chooseVersion(["5.13.1", "5.13.1-piko.1"], "latest")).toBe(
    "5.13.1-piko.1",
  );
  expect(chooseVersion(["5.13.1", "5.13.1-piko.1", "5.13.2"], "latest")).toBe(
    "5.13.2",
  );
  expect(chooseVersion(["5.13.1-beta.1", "5.13.0"], "latest")).toBe("5.13.0");
});

test("a repack of the installed release is an update, never a downgrade", async () => {
  const manager = new Packages(root);
  await manager.addSource("main", `http://127.0.0.1:${server.port}/`);
  await manager.install("main/app@5.13.1");
  await manager.use("main/app@latest");
  expect((await manager.outdated("main/app"))[0]).toMatchObject({
    status: "outdated",
    current: "5.13.1",
    candidate: "5.13.1-piko.1",
  });
  const updated = await manager.update("main/app");
  expect(updated.version).toBe("5.13.1-piko.1");
});

test("filtered update previews explain a pinned exact request instead of hiding it", () => {
  const pinned = [
    {
      package: "main/app",
      request: "5.13.1-piko.1",
      source: "http://127.0.0.1:1/",
      current: "5.13.1-piko.1",
      candidate: "5.13.1-piko.1",
      latest: "5.13.1-piko.1",
      status: "pinned",
      reason: "Exact version request; update keeps this version",
    },
  ];
  expect(updateTable(pinned)).toBe("All packages are up to date.");
  expect(updateTable(pinned, { focus: true })).toBe(
    "main/app (5.13.1-piko.1): pinned - Exact version request; update keeps this version\n\n1 pinned.",
  );
});
