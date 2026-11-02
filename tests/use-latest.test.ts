import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Packages } from "../src/packages.ts";
import { appFolder } from "../src/layout.ts";
import { capture, sha256 } from "../src/util.ts";

const work = await mkdtemp(join(tmpdir(), "piko-use-latest-"));
const servers: ReturnType<typeof Bun.serve>[] = [];
const auto = { installLatest: true };
async function fixture() {
  const settings = {
    latest: "2.0.0",
    unavailable: false,
    badChecksum: false,
    indexes: 0,
    downloads: 0,
  };
  const all: Record<string, string[]> = {
    tool: ["1.0.0", "2.0.0", "3.0.0"],
    provider: ["1.0.0"],
    consumer: ["1.0.0"],
    vendor: ["5.2.6.32774", "5.2.7.32913"],
  };
  const payload = (name: string, version: string) =>
    Buffer.from(`verified fixture ${name} ${version}`);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request): Response {
      const parts = new URL(request.url).pathname.slice(1).split("/");
      if (parts[0] === "index.json") {
        settings.indexes++;
        if (settings.unavailable)
          return new Response("source unavailable", { status: 404 });
        return Response.json({
          schemaVersion: 1,
          packages: Object.fromEntries(
            Object.entries(all).map(([name, versions]) => [
              name,
              {
                latest: name === "tool" ? settings.latest : versions.at(-1),
                versions: Object.fromEntries(
                  versions.map((v) => [v, `${name}/${v}.json`]),
                ),
                ...(name === "tool" ? { aliases: { stable: "2" } } : {}),
              },
            ]),
          ),
        });
      }
      const [name, file] = parts;
      const version = file?.replace(/\.(json|exe)$/, "");
      if (!name || !version || !all[name]?.includes(version))
        return new Response("not found", { status: 404 });
      const bytes = payload(name, version);
      if (file!.endsWith(".exe")) {
        settings.downloads++;
        return new Response(bytes);
      }
      return Response.json({
        schemaVersion: 1,
        name,
        version,
        platforms: {
          "windows-x64": {
            url: `http://127.0.0.1:${server.port}/${name}/${version}.exe`,
            sha256:
              settings.badChecksum && name === "tool" && version !== "1.0.0"
                ? "0".repeat(64)
                : sha256(bytes),
            format: "file",
            file: "tool.exe",
            bin:
              name === "tool" || name === "provider"
                ? { "fixture-use-latest": "tool.exe" }
                : {},
            ...(name === "consumer"
              ? { depends: [{ package: "tool@1" }] }
              : {}),
          },
        },
      });
    },
  });
  servers.push(server);
  const manager = new Packages(join(work, crypto.randomUUID()));
  const url = `http://127.0.0.1:${server.port}/`;
  await manager.addSource("main", url);
  return { manager, settings, url };
}
afterAll(async () => {
  for (const server of servers) server.stop(true);
  await rm(work, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
});

test("explicit latest installs a missing package, verifies it and selects the exact resolved target", async () => {
  const { manager } = await fixture();
  await manager.use("main/tool@latest", auto);
  const state = await manager.store.read();
  const installed = Object.values(state.installs)[0]!;
  expect(installed.version).toBe("2.0.0");
  expect(installed.verified).toBe(true);
  expect(state.defaults[installed.key]).toMatchObject({
    id: installed.id,
    request: "latest",
  });
  expect(state.commands["fixture-use-latest"]).toBe(installed.key);
  expect(
    resolve(
      await readlink(
        join(manager.root, "apps", appFolder(installed), "current"),
      ),
    ).toLowerCase(),
  ).toBe(resolve(manager.root, installed.dir).toLowerCase());
});

test("latest refreshes the original source and preserves the selected request", async () => {
  const { manager, settings } = await fixture();
  const old = await manager.install("main/tool@1.0.0");
  await manager.use("main/tool@1.0.0");
  settings.latest = "3.0.0";
  await manager.use("tool@latest", auto);
  const state = await manager.store.read();
  expect(state.installs[state.defaults[old.key]!.id]!.version).toBe("3.0.0");
  expect(state.defaults[old.key]!.request).toBe("latest");
  expect(state.installs[old.id]).toBeDefined();
});

test("already installed latest is reused without downloading it again", async () => {
  const { manager, settings } = await fixture();
  await manager.install("main/tool@2.0.0");
  const downloads = settings.downloads;
  await manager.use("main/tool@latest", auto);
  await manager.use("main/tool@latest", auto);
  expect(settings.downloads).toBe(downloads);
  expect(Object.keys((await manager.store.read()).installs)).toHaveLength(1);
});

test("vendor latest uses the source designation and no-commands remains respected", async () => {
  const { manager } = await fixture();
  await manager.use("main/vendor@latest", { ...auto, noCommands: true });
  const state = await manager.store.read();
  const installed = Object.values(state.installs)[0]!;
  expect(installed.version).toBe("5.2.7.32913");
  expect(state.defaults[installed.key]!.commands).toEqual([]);
  expect(state.commands).toEqual({});
});

test("unqualified latest stays on the installed source even if another source provides the package", async () => {
  const { manager } = await fixture();
  const other = await fixture();
  const original = await manager.install("main/tool@1.0.0");
  await manager.use("main/tool@1.0.0");
  await manager.addSource("other", other.url);
  const otherRequests = other.settings.indexes;
  await manager.use("tool@latest", auto);
  const state = await manager.store.read();
  const selected = state.installs[state.defaults[original.key]!.id]!;
  expect(selected.source.identity).toBe(original.source.identity);
  expect(selected.version).toBe("2.0.0");
  expect(other.settings.indexes).toBe(otherRequests);
});

test("ambiguous configured sources never silently select a provider", async () => {
  const { manager } = await fixture();
  const other = await fixture();
  await manager.addSource("other", other.url);
  await expect(manager.use("tool@latest", auto)).rejects.toThrow(
    "Ambiguous package",
  );
  expect(Object.keys((await manager.store.read()).installs)).toHaveLength(0);
});

test("source and checksum failures leave the existing default and current untouched", async () => {
  for (const problem of ["unavailable", "badChecksum"] as const) {
    const { manager, settings } = await fixture();
    const old = await manager.install("main/tool@1.0.0");
    await manager.use("main/tool@1.0.0");
    const before = await readFile(manager.store.statePath);
    const current = join(manager.root, "apps", appFolder(old), "current");
    const target = await readlink(current);
    settings[problem] = true;
    await expect(manager.use("main/tool@latest", auto)).rejects.toThrow();
    expect(await readFile(manager.store.statePath)).toEqual(before);
    expect(await readlink(current)).toBe(target);
  }
});

test("selection conflicts retain the old default while leaving the verified candidate installed", async () => {
  const { manager } = await fixture();
  const provider = await manager.install("main/provider@1.0.0");
  await manager.use("main/provider@1.0.0");
  const before = await manager.store.read();
  await expect(manager.use("main/tool@latest", auto)).rejects.toThrow(
    "Command conflict",
  );
  const state = await manager.store.read();
  expect(state.defaults).toEqual(before.defaults);
  expect(state.commands["fixture-use-latest"]).toBe(provider.key);
  expect(
    Object.values(state.installs).some((i) => i.name === "tool" && i.verified),
  ).toBe(true);
});

test("automatic latest does not install missing dependencies or bypass a preapproved plan", async () => {
  const { manager } = await fixture();
  const before = await readFile(manager.store.statePath);
  await expect(manager.use("main/consumer@latest", auto)).rejects.toThrow(
    "Unmet dependencies",
  );
  expect(await readFile(manager.store.statePath)).toEqual(before);
  await expect(
    manager.use("main/tool@latest", {
      ...auto,
      expectedRevision: (await manager.store.read()).revision,
    }),
  ).rejects.toThrow("approved dependency plan");
  expect(await readFile(manager.store.statePath)).toEqual(before);
});

test("exact versions and channels remain selection-only", async () => {
  const { manager, settings } = await fixture();
  const requests = settings.indexes;
  for (const request of ["2.0.0", "stable"])
    await expect(manager.use(`main/tool@${request}`, auto)).rejects.toThrow(
      "not installed",
    );
  expect(settings.indexes).toBe(requests);
  expect(Object.keys((await manager.store.read()).installs)).toHaveLength(0);
});

test("compiled CLI installs latest in one command and rejects dry-run before changing state", async () => {
  const { manager } = await fixture();
  const exe = join(work, "piko.exe");
  expect(
    (
      await Bun.build({
        entrypoints: ["src/cli.ts"],
        compile: {
          target: "bun-windows-x64",
          outfile: exe,
          autoloadDotenv: false,
          autoloadBunfig: false,
          autoloadTsconfig: false,
          autoloadPackageJson: false,
        },
      })
    ).success,
  ).toBe(true);
  const env = { ...process.env, PIKO_HOME: manager.root };
  await capture(exe, ["setup"], { env });
  const before = await readFile(manager.store.statePath);
  await expect(
    capture(exe, ["use", "main/tool@latest", "--dry-run"], { env }),
  ).rejects.toThrow("does not support --dry-run");
  expect(await readFile(manager.store.statePath)).toEqual(before);
  expect(
    await capture(exe, ["use", "main/tool@latest", "--no-commands"], { env }),
  ).toContain("Default and current updated");
  const state = await manager.store.read();
  const installed = Object.values(state.installs)[0]!;
  expect(installed.version).toBe("2.0.0");
  expect(state.defaults[installed.key]).toMatchObject({
    id: installed.id,
    request: "latest",
    commands: [],
  });
  const beforeUninstall = await readFile(manager.store.statePath);
  await expect(
    capture(exe, ["uninstall", "tool", "--dry-run"], { env }),
  ).rejects.toThrow("does not support --dry-run");
  expect(await readFile(manager.store.statePath)).toEqual(beforeUninstall);
  expect(await capture(exe, ["uninstall", "tool"], { env })).toContain(
    "Uninstalled",
  );
  expect((await manager.store.read()).installs).toEqual({});
  expect((await manager.store.read()).defaults).toEqual({});
}, 60000);
