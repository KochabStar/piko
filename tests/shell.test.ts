import { afterAll, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Packages } from "../src/packages.ts";
import { integrate, inspectIntegration, shellInit } from "../src/shell.ts";
import {
  editProfile,
  profileBytes,
  profileJournal,
  profileKey,
  profileMarkers,
  recoverProfile,
  stageProfileChange,
} from "../src/profiles.ts";
import { normalizeManifest } from "../src/catalog.ts";
import {
  exportInventory,
  planInventory,
  importInventory,
} from "../src/inventory.ts";
import { emptyState } from "../src/store.ts";
import { atomicJson, exists, sha256 } from "../src/util.ts";

const work = await mkdtemp(join(tmpdir(), "piko-shell-中文-"));
const bytes = Buffer.from("fixture, not an executable");
let indexGate: Promise<void> | undefined;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/index.json" && indexGate) await indexGate;
    if (path === "/index.json")
      return Response.json({
        schemaVersion: 1,
        packages: {
          runtime: {
            latest: "1.0.0",
            versions: { "1.0.0": "runtime/1.0.0.json" },
            aliases: { lts: "1" },
          },
          consumer: {
            latest: "2.0.0",
            versions: {
              "1.0.0": "consumer/1.0.0.json",
              "2.0.0": "consumer/2.0.0.json",
            },
          },
        },
      });
    if (path === "/file") return new Response(bytes);
    const name = path.split("/")[1]!,
      version = path.split("/")[2]!.replace(".json", "");
    return Response.json({
      schemaVersion: 1,
      name,
      version,
      platforms: {
        "windows-x64": {
          url: `http://127.0.0.1:${server.port}/file`,
          format: "file",
          file: "tool.exe",
          sha256: sha256(bytes),
          bin: name === "runtime" ? { lua: "tool.exe" } : {},
          ...(name === "consumer"
            ? {
                shell: {
                  powershell: `function global:PikoShellFixture { '${version}' }`,
                },
                depends: [{ package: "runtime@lts", commands: ["lua"] }],
              }
            : {}),
        },
      },
    });
  },
});
async function fixture() {
  const root = join(work, crypto.randomUUID()),
    p = new Packages(root);
  await p.addSource("main", `http://127.0.0.1:${server.port}/`);
  await p.install("main/runtime@1.0.0");
  await p.use("main/runtime@1.0.0");
  const install = await p.install("main/consumer@1.0.0");
  await mkdir(join(root, "apps", "piko"), { recursive: true });
  await writeFile(join(root, "apps", "piko", "piko.exe"), "fixture executable");
  return {
    p,
    root,
    install,
    profile: join(work, crypto.randomUUID(), "Profile '中文.ps1"),
  };
}
afterAll(async () => {
  server.stop(true);
  await rm(work, {
    recursive: true,
    force: true,
    maxRetries: 12,
    retryDelay: 100,
  });
});

test("source declarations validate Shell text and script/native entry kinds", () => {
  const manifest = (shell: unknown, bin = {}) => ({
    schemaVersion: 1,
    name: "test",
    version: "1",
    platforms: {
      "windows-x64": {
        url: "https://example.com/file",
        format: "file",
        file: "tool.exe",
        bin,
        shell,
      },
    },
  });
  for (const shell of [
    null,
    {},
    [],
    { powershell: "" },
    { powershell: "x", arbitrary: "x" },
    { powershell: "x\0" },
  ])
    expect(() => normalizeManifest(manifest(shell), "test", "1")).toThrow();
  expect(() =>
    normalizeManifest(
      manifest(
        { powershell: "Import-Module x" },
        { test: { kind: "powershell", path: "tool.ps1" }, native: "tool.com" },
      ),
      "test",
      "1",
    ),
  ).not.toThrow();
  expect(() =>
    normalizeManifest(
      manifest(
        { powershell: "x" },
        { test: { kind: "powershell", path: "tool.exe" } },
      ),
      "test",
      "1",
    ),
  ).toThrow();
});

test("Profile integration requires content-bound approval; install does not activate or edit Profile", async () => {
  const { p, install, profile } = await fixture();
  expect(await profileBytes(profile)).toBeNull();
  const before = await p.store.read(),
    plan = await inspectIntegration(p.store, "main/consumer", profile);
  expect(plan.selected).toBe(false);
  await expect(
    integrate(p.store, "main/consumer", profile, { confirmed: true }),
  ).rejects.toThrow("--binding");
  expect(await p.store.read()).toEqual(before);
  await integrate(p.store, "main/consumer", profile, {
    confirmed: true,
    binding: plan.binding,
  });
  expect((await readFile(profile, "utf8")).includes("\0")).toBe(false);
  expect(await readFile(profile, "utf8")).toContain(' -join "`n"');
  expect(await shellInit(p.store, profile)).not.toContain("function global:");
  await p.use("main/consumer@1.0.0");
  expect(await shellInit(p.store, profile)).toContain(
    "function global:PikoShellFixture",
  );
  expect(await shellInit(p.store, profile)).toContain("$PikoDependencies = @{");
  await writeFile(join(p.root, install.dir, "tool.exe"), "changed");
  expect(await shellInit(p.store, profile)).toContain(
    "approve integration again",
  );
  expect(await shellInit(p.store, profile)).not.toContain("function global:");
});

test("approved initialization remains available during a real stalled source refresh and never removes its lock", async () => {
  const { p, profile } = await fixture();
  const plan = await inspectIntegration(p.store, "main/consumer", profile);
  await integrate(p.store, "main/consumer", profile, {
    confirmed: true,
    binding: plan.binding,
  });
  await p.use("main/consumer@1.0.0");
  const before = await readFile(p.store.statePath);
  let release!: () => void;
  indexGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const refresh = p.refreshSources("main");
  try {
    for (
      let n = 0;
      n < 100 && !(await exists(join(p.root, "mutation.lock", "owner.json")));
      n++
    )
      await Bun.sleep(5);
    expect(await exists(join(p.root, "mutation.lock", "owner.json"))).toBe(
      true,
    );
    const owner = await readFile(join(p.root, "mutation.lock", "owner.json"));
    const content = await shellInit(p.store, profile);
    expect(content).toContain("function global:PikoShellFixture");
    expect(content).not.toContain("approve integration again");
    expect(await readFile(join(p.root, "mutation.lock", "owner.json"))).toEqual(
      owner,
    );
    expect(await readFile(p.store.statePath)).toEqual(before);
    release();
    await refresh;
    expect(await readFile(p.store.statePath)).toEqual(before);
  } finally {
    indexGate = undefined;
    release();
    await refresh;
  }
  // A dead writer lock is not proof that approved executable content is invalid.
  const lock = join(p.root, "mutation.lock");
  await mkdir(lock);
  await writeFile(
    join(lock, "owner.json"),
    JSON.stringify({ pid: 2147483647, started: "2000-01-01T00:00:00.000Z" }),
  );
  try {
    expect(await shellInit(p.store, profile)).toContain(
      "function global:PikoShellFixture",
    );
    expect(await exists(lock)).toBe(true);
  } finally {
    await rm(lock, { recursive: true });
  }
});

test("initialization tolerates metadata revision changes, but rejects approval changes and pending destructive journals", async () => {
  const { p, profile, root } = await fixture();
  const plan = await inspectIntegration(p.store, "main/consumer", profile);
  await integrate(p.store, "main/consumer", profile, {
    confirmed: true,
    binding: plan.binding,
  });
  await p.use("main/consumer@1.0.0");
  const read = p.store.read.bind(p.store);
  let count = 0;
  p.store.read = async () => {
    const state = await read();
    if (++count === 2) {
      state.revision++;
      await atomicJson(p.store.statePath, state);
    }
    return state;
  };
  expect(await shellInit(p.store, profile)).toContain(
    "function global:PikoShellFixture",
  );
  count = 0;
  p.store.read = async () => {
    const state = await read();
    if (++count === 2) {
      state.profiles![profileKey(profile)]!.approvals = {};
    }
    return state;
  };
  await expect(shellInit(p.store, profile)).rejects.toThrow("state changed");
  p.store.read = read;
  await mkdir(join(root, "operations"), { recursive: true });
  for (const name of [
    "selection.json",
    "removal.json",
    "npm-rebuild.json",
    "data-removal.json",
    "profile.json",
    "desktop.json",
    "persist.json",
    "layout.json",
    "self-update.json",
    "install.json",
  ]) {
    const file = join(root, "operations", name);
    await writeFile(file, "{}");
    try {
      await expect(shellInit(p.store, profile)).rejects.toThrow(
        "Interrupted operation",
      );
    } finally {
      await rm(file);
    }
  }
  count = 0;
  p.store.read = async () => {
    const state = await read();
    if (++count === 2) await writeFile(p.store.journalPath, "{}");
    return state;
  };
  try {
    await expect(shellInit(p.store, profile)).rejects.toThrow(
      "Interrupted operation",
    );
  } finally {
    p.store.read = read;
    await rm(p.store.journalPath, { force: true });
  }
});

test("source-only commits publish metadata without touching current links or selection journals", async () => {
  const { p, profile } = await fixture();
  const sync = p.store["syncCurrents"].bind(p.store);
  p.store["syncCurrents"] = async () => {
    throw new Error("Source metadata must not rewrite currents");
  };
  try {
    await p.addSource("other", `http://127.0.0.1:${server.port}/`);
  } finally {
    p.store["syncCurrents"] = sync;
  }
  expect(await exists(p.store.journalPath)).toBe(false);
  expect(await shellInit(p.store, profile)).toContain("No approved");
});

test("Shell dependency aliases use local source metadata and fail closed when missing or changed", async () => {
  const { p, install, profile } = await fixture();
  const preview = await inspectIntegration(p.store, "main/consumer", profile);
  await integrate(p.store, "main/consumer", profile, {
    confirmed: true,
    binding: preview.binding,
  });
  await p.use("main/consumer@1.0.0");
  const indexPath = join(
    p.root,
    "sources",
    install.source.identity,
    "index.json",
  );
  const bytes = await readFile(indexPath);
  const index = JSON.parse(bytes.toString());
  expect(await shellInit(p.store, profile)).toContain("function global:");
  // A refreshed alias must still match the selected dependency, not merely its name.
  index.packages.runtime.aliases.lts = "2";
  await writeFile(indexPath, JSON.stringify(index));
  expect(await shellInit(p.store, profile)).not.toContain("function global:");
  await rm(indexPath);
  expect(await shellInit(p.store, profile)).not.toContain("function global:");
  await writeFile(indexPath, bytes);
  expect(await shellInit(p.store, profile)).toContain("function global:");
});

test("new version, dependency ownership, unuse, rollback and explicit revoke are respected", async () => {
  const { p, profile } = await fixture();
  const plan = await inspectIntegration(p.store, "main/consumer", profile);
  await integrate(p.store, "main/consumer", profile, {
    confirmed: true,
    binding: plan.binding,
  });
  await p.use("main/consumer@1.0.0");
  const original = await readFile(profile);
  await p.install("main/consumer@2.0.0");
  await p.use("main/consumer@2.0.0");
  expect(await shellInit(p.store, profile)).toContain(
    "approve integration again",
  );
  await p.use("main/consumer@1.0.0");
  expect(await shellInit(p.store, profile)).toContain("function global:");
  await expect(p.releaseCommand("lua")).rejects.toThrow(
    "Dependency protection",
  );
  await p.unuse("main/consumer");
  await p.releaseCommand("lua");
  await expect(p.use("main/consumer@1.0.0")).rejects.toThrow(
    "Dependency protection",
  );
  await p.claimCommand("lua", "main/runtime");
  expect(await shellInit(p.store, profile)).not.toContain("function global:");
  expect(await readFile(profile)).toEqual(original);
  const remove = await inspectIntegration(
    p.store,
    "main/consumer@1.0.0",
    profile,
    true,
  );
  await integrate(p.store, "main/consumer@1.0.0", profile, {
    confirmed: true,
    remove: true,
    binding: remove.binding,
  });
  expect(await readFile(profile, "utf8")).toBe("");
});

test("Profile preserves BOM, CRLF and unrelated edits; rejects changed managed blocks and stale previews", async () => {
  const { p, profile } = await fixture();
  await mkdir(join(profile, ".."), { recursive: true });
  const original = Buffer.concat([
    Buffer.from([255, 254]),
    Buffer.from("# 用户配置\r\n", "utf16le"),
  ]);
  await writeFile(profile, original);
  const plan = await inspectIntegration(p.store, "main/consumer", profile);
  await writeFile(
    profile,
    Buffer.concat([original, Buffer.from("# concurrent\r\n", "utf16le")]),
  );
  await expect(
    integrate(p.store, "main/consumer", profile, {
      confirmed: true,
      binding: plan.binding,
    }),
  ).rejects.toThrow("changed");
  await writeFile(profile, original);
  const fresh = await inspectIntegration(p.store, "main/consumer", profile);
  await integrate(p.store, "main/consumer", profile, {
    confirmed: true,
    binding: fresh.binding,
  });
  const enabled = await readFile(profile);
  expect(enabled.subarray(0, original.length)).toEqual(original);
  const fresh2 = await inspectIntegration(p.store, "main/consumer", profile);
  await integrate(p.store, "main/consumer", profile, {
    confirmed: true,
    binding: fresh2.binding,
  });
  expect(await readFile(profile)).toEqual(enabled);
  await writeFile(
    profile,
    Buffer.concat([enabled, Buffer.from("\r\n# user addition\r\n", "utf16le")]),
  );
  const revoke = await inspectIntegration(
    p.store,
    "main/consumer",
    profile,
    true,
  );
  await integrate(p.store, "main/consumer", profile, {
    confirmed: true,
    binding: revoke.binding,
    remove: true,
  });
  expect((await readFile(profile)).toString("utf16le")).toContain(
    "# user addition",
  );
  const edited = await inspectIntegration(p.store, "main/consumer", profile);
  await integrate(p.store, "main/consumer", profile, {
    confirmed: true,
    binding: edited.binding,
  });
  await writeFile(
    profile,
    (await readFile(profile))
      .toString("utf16le")
      .replace("try {", "try { # edit"),
    "utf16le",
  );
  await expect(
    inspectIntegration(p.store, "main/consumer", profile),
  ).rejects.toThrow("block changed");
});

test("Profile edits recover from precommit crash and preserve conflicting external edits", async () => {
  const root = join(work, crypto.randomUUID()),
    path = join(root, "profile.ps1"),
    state = emptyState();
  await mkdir(root, { recursive: true });
  await writeFile(path, "# original\n");
  const before = await profileBytes(path),
    markers = profileMarkers(root),
    profile = {
      path,
      block: markers.start + "\n" + markers.end,
      approvals: {},
    },
    after = editProfile(root, before, undefined, profile.block);
  await stageProfileChange(root, state, path, before, after, profile);
  await recoverProfile(root, state);
  expect(await profileBytes(path)).toEqual(before);
  await stageProfileChange(root, state, path, before, after, profile);
  const committed = {
    ...state,
    schemaVersion: 5 as const,
    revision: 1,
    profiles: { [profileKey(path)]: profile },
  };
  await recoverProfile(root, committed);
  expect(await profileBytes(path)).toEqual(after);
  await stageProfileChange(
    root,
    committed,
    path,
    after,
    editProfile(root, after, profile.block, undefined),
    null,
  );
  await writeFile(path, "external change");
  await expect(recoverProfile(root, committed)).rejects.toThrow(
    "changed during interrupted",
  );
  expect(await readFile(path, "utf8")).toBe("external change");
});

test("linked Profile paths are refused", async () => {
  const root = join(work, crypto.randomUUID());
  await mkdir(root);
  const real = join(root, "real");
  await mkdir(real);
  const linked = join(root, "linked");
  await symlink(real, linked, "junction");
  await expect(profileBytes(join(linked, "profile.ps1"))).rejects.toThrow(
    "linked",
  );
});

test("inventory exports integration intent, never paths or approvals, and restore requires fresh approval", async () => {
  const { p, profile } = await fixture();
  const plan = await inspectIntegration(p.store, "main/consumer", profile);
  await integrate(p.store, "main/consumer", profile, {
    confirmed: true,
    binding: plan.binding,
  });
  const inventory = exportInventory(await p.store.read());
  expect(inventory.integrations).toEqual([
    { package: "main/consumer", shell: "powershell" },
  ]);
  expect(JSON.stringify(inventory)).not.toContain(profile);
  expect(JSON.stringify(inventory)).not.toContain(plan.binding);
  const target = new Packages(join(work, crypto.randomUUID()));
  const preview = await planInventory(target, inventory);
  expect(preview.conflicts).toEqual([]);
  expect(
    preview.steps.some(
      (s) => s.action === "shell-integration-needs-new-approval",
    ),
  ).toBe(true);
  const result = await importInventory(target, inventory, {
    confirmed: true,
    binding: preview.binding,
  });
  expect(result.pendingIntegrations).toEqual(inventory.integrations!);
  expect((await target.store.read()).profiles).toBeUndefined();
});

test("last uninstall revokes multiple Profiles, but edited blocks stop removal and restore earlier edits", async () => {
  const { p, profile, install } = await fixture();
  const other = profile + ".other.ps1";
  for (const path of [profile, other]) {
    const plan = await inspectIntegration(p.store, "main/consumer", path);
    await integrate(p.store, "main/consumer", path, {
      confirmed: true,
      binding: plan.binding,
    });
  }
  const original = await readFile(profile),
    originalOther = await readFile(other);
  await writeFile(
    other,
    originalOther.toString().replace("try {", "try { # user edit"),
  );
  await expect(p.uninstall("main/consumer@1.0.0")).rejects.toThrow(
    "block changed",
  );
  expect(await readFile(profile)).toEqual(original);
  expect((await p.store.read()).installs[install.id]).toBeDefined();
  await writeFile(other, originalOther);
  await p.uninstall("main/consumer@1.0.0");
  expect(await readFile(profile, "utf8")).toBe("");
  expect(await readFile(other, "utf8")).toBe("");
  expect(Object.keys((await p.store.read()).profiles!)).toEqual([]);
});

test("Profile recovery rejects forged replacement bytes and validates every change before writing", async () => {
  const root = join(work, crypto.randomUUID()),
    state = emptyState();
  await mkdir(root);
  const markers = profileMarkers(root),
    paths = [join(root, "one.ps1"), join(root, "two.ps1")];
  for (const path of paths) {
    const before = Buffer.from("# original user code\r\n"),
      profile = {
        path,
        block: markers.start + "\r\n" + markers.end,
        approvals: {},
      };
    await writeFile(path, before);
    await stageProfileChange(
      root,
      state,
      path,
      before,
      editProfile(root, before, undefined, profile.block),
      profile,
    );
  }
  const journal = profileJournal(root),
    original = JSON.parse(await readFile(journal, "utf8")),
    bytes = await Promise.all(paths.map((path) => readFile(path)));
  for (const mutation of [
    (j: any) => {
      j.changes[1].after = Buffer.from("arbitrary shell code").toString(
        "base64",
      );
    },
    (j: any) => {
      j.changes.push(j.changes[0]);
    },
    (j: any) => {
      j.changes[1].beforeRevision = -1;
    },
    (j: any) => {
      j.changes[1].beforeProfile = null;
      j.changes[1].afterProfile = null;
    },
  ]) {
    const modified = structuredClone(original);
    mutation(modified);
    await writeFile(journal, JSON.stringify(modified));
    await expect(recoverProfile(root, state)).rejects.toThrow();
    expect(await Promise.all(paths.map((path) => readFile(path)))).toEqual(
      bytes,
    );
    expect(await readFile(journal, "utf8")).toBe(JSON.stringify(modified));
  }
  await writeFile(journal, JSON.stringify(original));
  await writeFile(paths[1]!, "# external edit\r\n");
  await expect(recoverProfile(root, state)).rejects.toThrow(
    "changed during interrupted",
  );
  expect(await readFile(paths[0]!)).toEqual(bytes[0]!);
  expect(await readFile(paths[1]!, "utf8")).toBe("# external edit\r\n");
  await writeFile(paths[1]!, bytes[1]!);
  await recoverProfile(root, state);
  for (const path of paths)
    expect(await readFile(path, "utf8")).toBe("# original user code\r\n");
});

test("Profile staging refuses edits outside the managed block", async () => {
  const root = join(work, crypto.randomUUID()),
    state = emptyState(),
    path = join(root, "profile.ps1");
  await mkdir(root);
  const before = Buffer.from("# user code\n"),
    markers = profileMarkers(root),
    profile = {
      path,
      block: markers.start + "\n" + markers.end,
      approvals: {},
    };
  await writeFile(path, before);
  await expect(
    stageProfileChange(
      root,
      state,
      path,
      before,
      Buffer.from("overwritten"),
      profile,
    ),
  ).rejects.toThrow("managed block edit");
  expect(await readFile(path)).toEqual(before);
});
