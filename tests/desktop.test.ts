import { appFolder } from "../src/layout.ts";
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Packages } from "../src/packages.ts";
import {
  desktopJournal,
  applyDesktop,
  inspectDesktop,
  inspectDesktopUpgrade,
  recoverDesktop,
  stageDesktopChange,
} from "../src/desktop.ts";
import { WindowsEffects, equalValue } from "../src/windows-effects.ts";
import { exportInventory, planInventory } from "../src/inventory.ts";
import { sha256 } from "../src/util.ts";
import { normalizeManifest } from "../src/catalog.ts";
import type { EffectTarget, EffectValue } from "../src/types.ts";

const work = await mkdtemp(join(tmpdir(), "piko-desktop-tests-"));
afterAll(() =>
  rm(work, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 }),
);
class IsolatedEffects extends WindowsEffects {
  registry = new Map<string, EffectValue>();
  failTarget = "";
  override async read(target: EffectTarget): Promise<EffectValue> {
    if (target.kind === "file") return await super.read(target);
    return structuredClone(this.registry.get(JSON.stringify(target)) ?? null);
  }
  override async write(
    target: EffectTarget,
    before: EffectValue,
    value: EffectValue,
    bytes?: Uint8Array,
  ) {
    if (this.failTarget && JSON.stringify(target).includes(this.failTarget))
      throw Error("injected external write failure");
    if (target.kind === "file")
      return await super.write(target, before, value, bytes);
    if (!equalValue(await this.read(target), before))
      throw Error("external registry drift");
    this.registry.set(JSON.stringify(target), structuredClone(value));
  }
  override async shortcut(target: string, args: string): Promise<Uint8Array> {
    return Buffer.from(JSON.stringify([target, args]));
  }
}
const artifact = Buffer.from("fixture executable; never launched");
const manifests = new Map<string, any>();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(r): Response {
    const path = new URL(r.url).pathname.slice(1);
    if (path === "index.json")
      return Response.json({
        schemaVersion: 1,
        packages: Object.fromEntries(
          [...manifests].map(([name, m]) => [
            name,
            { latest: m.version, versions: { [m.version]: name + ".json" } },
          ]),
        ),
      });
    if (path === "file") return new Response(artifact);
    return Response.json(manifests.get(path.replace(".json", "")));
  },
});
afterAll(() => server.stop(true));
async function fixture() {
  const root = join(work, crypto.randomUUID()),
    backend = new IsolatedEffects(join(root, "external")),
    p = new Packages(root, backend);
  const name = "desktop-" + crypto.randomUUID().slice(0, 8),
    manifest = {
      schemaVersion: 1,
      name,
      version: "1.0.0",
      platforms: {
        "windows-x64": {
          url: `http://127.0.0.1:${server.port}/file`,
          sha256: sha256(artifact),
          format: "file",
          file: "tool.exe",
          bin: { tool: "tool.exe" },
          desktop: {
            environment: { TOOL_HOME: "{root}" },
            path: ["."],
            shortcuts: [{ name: "Test App", path: "tool.exe" }],
            menus: [
              {
                id: "open",
                label: "Open in Test",
                target: "file",
                path: "tool.exe",
              },
            ],
          },
        },
      },
    };
  // Package paths are deliberately strict: use a concrete directory, not '.'.
  manifest.platforms["windows-x64"].desktop.path = [];
  manifests.set(name, manifest);
  await p.addSource("main", `http://127.0.0.1:${server.port}/`);
  const install = await p.install("main/" + name + "@1.0.0");
  await p.use("main/" + name + "@1.0.0");
  return { p, backend, name, spec: "main/" + name, install };
}
test("desktop preview is inert; explicit approval owns resources and removal preserves unrelated user data", async () => {
  const { p, backend, spec, install } = await fixture();
  const before = await p.store.read(),
    plan = await inspectDesktop(p.store, spec, false, backend);
  expect(await p.store.read()).toEqual(before);
  expect(backend.registry.size).toBe(0);
  await expect(
    applyDesktop(p.store, spec, { confirmed: true }, backend),
  ).rejects.toThrow("binding");
  await applyDesktop(
    p.store,
    spec,
    { confirmed: true, binding: plan.binding },
    backend,
  );
  const state = await p.store.read();
  expect(state.schemaVersion).toBe(8);
  expect(state.desktop?.[install.key]?.id).toBe(install.id);
  const folder = await backend.folders();
  expect(
    await readFile(join(folder.startMenu, "Piko/Test App.lnk"), "utf8"),
  ).toContain("current");
  await expect(p.uninstall(spec + "@1.0.0", true)).rejects.toThrow(
    "Revoke desktop",
  );
  await expect(p.unuse(spec)).rejects.toThrow("Revoke desktop");
  const remove = await inspectDesktop(p.store, spec, true, backend);
  await applyDesktop(
    p.store,
    spec,
    { confirmed: true, binding: remove.binding, remove: true },
    backend,
  );
  expect(Object.keys((await p.store.read()).desktop!)).toEqual([]);
  expect([...backend.registry.values()].every((v) => v === null)).toBe(true);
  await p.unuse(spec);
});
test("unchanged desktop integration survives update, rollback and removal", async () => {
  const { p, backend, name, spec, install } = await fixture();
  await p.use(spec + "@latest");
  const plan = await inspectDesktop(p.store, spec, false, backend);
  await applyDesktop(
    p.store,
    spec,
    { confirmed: true, binding: plan.binding },
    backend,
  );
  const registry = structuredClone(backend.registry);
  manifests.get(name).version = "2.0.0";
  const updated = await p.update(spec);
  expect(updated.version).toBe("2.0.0");
  expect((await p.store.read()).desktop?.[install.key]?.id).toBe(updated.id);
  expect(backend.registry).toEqual(registry);
  await p.use(spec + "@1.0.0");
  expect((await p.store.read()).desktop?.[install.key]?.id).toBe(install.id);
  const remove = await inspectDesktop(p.store, spec, true, backend);
  await applyDesktop(
    p.store,
    spec,
    { confirmed: true, binding: remove.binding, remove: true },
    backend,
  );
  expect([...backend.registry.values()].every((v) => v === null)).toBe(true);
});

test("desktop upgrade refuses changed declarations and external resource drift", async () => {
  const { p, backend, name, spec } = await fixture();
  const plan = await inspectDesktop(p.store, spec, false, backend);
  await applyDesktop(
    p.store,
    spec,
    { confirmed: true, binding: plan.binding },
    backend,
  );
  const manifest = manifests.get(name);
  manifest.version = "2.0.0";
  await p.install(spec + "@2.0.0");
  const before = await p.store.read();
  const target = plan.effects[0]!.target;
  backend.registry.set(JSON.stringify(target), {
    type: "String",
    value: "external edit",
  });
  await expect(p.use(spec + "@2.0.0")).rejects.toThrow("externally");
  expect(await p.store.read()).toEqual(before);
  backend.registry.set(JSON.stringify(target), plan.effects[0]!.after);
  manifest.version = "3.0.0";
  manifest.platforms["windows-x64"].desktop.environment.TOOL_HOME =
    "{root}/changed";
  await p.install(spec + "@3.0.0");
  const installed = await p.store.read();
  await expect(p.use(spec + "@3.0.0")).rejects.toThrow("declaration changed");
  expect(await p.store.read()).toEqual(installed);
});

test("changed desktop declaration upgrades in one approval and failed writes restore removed resources", async () => {
  const { p, backend, name, spec, install } = await fixture();
  const enable = await inspectDesktop(p.store, spec, false, backend);
  await applyDesktop(
    p.store,
    spec,
    { confirmed: true, binding: enable.binding },
    backend,
  );
  const manifest = manifests.get(name);
  manifest.version = "2.0.0";
  manifest.platforms["windows-x64"].desktop = {
    environment: { TOOL_VERSION: "{version}" },
  };
  const next = await p.install(spec + "@2.0.0");
  const before = await p.store.read(),
    registry = structuredClone(backend.registry);
  const shortcut = join(
    (await backend.folders()).startMenu,
    "Piko/Test App.lnk",
  );
  const shortcutBytes = await readFile(shortcut);
  const preview = await inspectDesktopUpgrade(
    p.store,
    spec + "@2.0.0",
    backend,
  );
  expect(await p.store.read()).toEqual(before);
  await expect(p.upgradeDesktop(spec + "@2.0.0", "wrong")).rejects.toThrow(
    "changed",
  );
  backend.failTarget = "TOOL_VERSION";
  await expect(
    p.upgradeDesktop(spec + "@2.0.0", preview.binding),
  ).rejects.toThrow("injected");
  expect(await p.store.read()).toEqual(before);
  expect(await readFile(shortcut)).toEqual(shortcutBytes);
  for (const [key, value] of registry)
    expect(backend.registry.get(key)).toEqual(value);
  backend.failTarget = "";
  const fresh = await inspectDesktopUpgrade(p.store, spec + "@2.0.0", backend);
  await p.upgradeDesktop(spec + "@2.0.0", fresh.binding);
  const after = await p.store.read();
  expect(after.defaults[install.key]?.id).toBe(next.id);
  expect(after.desktop?.[install.key]?.id).toBe(next.id);
  await expect(readFile(shortcut)).rejects.toThrow();
  const remove = await inspectDesktop(p.store, spec, true, backend);
  await applyDesktop(
    p.store,
    spec,
    { confirmed: true, binding: remove.binding, remove: true },
    backend,
  );
  expect([...backend.registry.values()].every((value) => value === null)).toBe(
    true,
  );
});

test("desktop confirmation rejects state/resource drift and does not overwrite foreign environment values", async () => {
  const { p, backend, spec } = await fixture();
  const plan = await inspectDesktop(p.store, spec, false, backend);
  const target: EffectTarget = {
    kind: "registry",
    key: "HKCU\\Environment",
    name: "TOOL_HOME",
  };
  backend.registry.set(JSON.stringify(target), {
    type: "String",
    value: "user-owned",
  });
  await expect(
    applyDesktop(
      p.store,
      spec,
      { confirmed: true, binding: plan.binding },
      backend,
    ),
  ).rejects.toThrow("conflicts");
  expect(await backend.read(target)).toEqual({
    type: "String",
    value: "user-owned",
  });
});
test("failed external writes roll back prior effects; user edits after apply prevent destructive removal", async () => {
  const { p, backend, spec } = await fixture();
  const plan = await inspectDesktop(p.store, spec, false, backend);
  backend.failTarget = "\\\\command";
  await expect(
    applyDesktop(
      p.store,
      spec,
      { confirmed: true, binding: plan.binding },
      backend,
    ),
  ).rejects.toThrow();
  backend.failTarget = "";
  await recoverDesktop(p.root, await p.store.read(), backend);
  expect((await p.store.read()).desktop).toBeUndefined();
  const next = await inspectDesktop(p.store, spec, false, backend);
  await applyDesktop(
    p.store,
    spec,
    { confirmed: true, binding: next.binding },
    backend,
  );
  const path = join((await backend.folders()).startMenu, "Piko/Test App.lnk");
  await writeFile(path, "user edit");
  await expect(inspectDesktop(p.store, spec, true, backend)).rejects.toThrow(
    "drift",
  );
  expect(await readFile(path, "utf8")).toBe("user edit");
});
test("desktop journals restore precommit resource changes without running package code", async () => {
  const { p, backend, spec, install } = await fixture(),
    state = await p.store.read(),
    preview = await inspectDesktop(p.store, spec, false, backend),
    target = preview.effects[0]!.target;
  await stageDesktopChange(
    p.root,
    state,
    install.key,
    preview.effects,
    {
      id: install.id,
      declaration: install.desktop!,
      effects: preview.effects,
      binding: preview.binding,
    },
    backend,
  );
  expect(await backend.read(target)).not.toBeNull();
  await recoverDesktop(p.root, state, backend);
  expect(await backend.read(target)).toBeNull();
  expect(
    (await inspectDesktop(p.store, spec, false, backend)).effects.length,
  ).toBeGreaterThan(0);
});
test("untrusted desktop manifests cannot request arbitrary registry paths, protected variables or script shortcuts", () => {
  const name = [...manifests.keys()][0]!,
    base = manifests.get(name);
  for (const desktop of [
    { environment: { PATH: "bad" } },
    { shortcuts: [{ name: "../bad", path: "tool.exe" }] },
    { shortcuts: [{ name: "Script", path: "script.ps1" }] },
    { registry: { key: "HKLM" } },
    { fonts: ["../bad.ttf"] },
    { menus: [{ id: "x", label: "x", target: "unknown", path: "tool.exe" }] },
  ])
    expect(() =>
      normalizeManifest(
        {
          ...base,
          platforms: {
            "windows-x64": { ...base.platforms["windows-x64"], desktop },
          },
        },
        name,
        "1.0.0",
      ),
    ).toThrow();
});

test("PATH integration owns only its appended segments and preserves other packages and later user edits", async () => {
  const first = await fixture(),
    second = await fixture(),
    backend = first.backend;
  const target: EffectTarget = {
    kind: "registry",
    key: "HKCU\\Environment",
    name: "Path",
  };
  backend.registry.set(JSON.stringify(target), {
    type: "ExpandString",
    value: "C:\\user-tools",
  });
  for (const item of [first, second]) {
    const m = manifests.get(item.name);
    m.platforms["windows-x64"].desktop = { path: ["."] };
    // New version carries the new declaration; install manifests are immutable.
    m.version = "2.0.0";
    await item.p.install(item.spec + "@2.0.0");
    await item.p.use(item.spec + "@2.0.0");
    const plan = await inspectDesktop(item.p.store, item.spec, false, backend);
    await applyDesktop(
      item.p.store,
      item.spec,
      { confirmed: true, binding: plan.binding },
      backend,
    );
  }
  const current = await backend.read(target);
  if (!current || !("value" in current)) throw Error("PATH missing");
  backend.registry.set(JSON.stringify(target), {
    type: "ExpandString",
    value: current.value + ";C:\\new-user-tools",
  });
  // Reapproval after unrelated PATH changes must not absorb those segments.
  const again = await inspectDesktop(first.p.store, first.spec, false, backend);
  await applyDesktop(
    first.p.store,
    first.spec,
    { confirmed: true, binding: again.binding },
    backend,
  );
  const undo = await inspectDesktop(first.p.store, first.spec, true, backend);
  await applyDesktop(
    first.p.store,
    first.spec,
    { confirmed: true, binding: undo.binding, remove: true },
    backend,
  );
  const value = await backend.read(target);
  expect(JSON.stringify(value)).toContain(appFolder(second.install));
  expect(JSON.stringify(value)).not.toContain(appFolder(first.install));
  const undo2 = await inspectDesktop(
    second.p.store,
    second.spec,
    true,
    backend,
  );
  await applyDesktop(
    second.p.store,
    second.spec,
    { confirmed: true, binding: undo2.binding, remove: true },
    backend,
  );
  expect(await backend.read(target)).toEqual({
    type: "ExpandString",
    value: "C:\\user-tools;C:\\new-user-tools",
  });
});

test("PATH integration preserves original empty segments and trailing separators through reapproval and removal", async () => {
  for (const [type, original] of [
    ["String", "C:\\user-tools;"],
    ["ExpandString", ";C:\\user-tools;;"],
    ["String", ""],
  ] as const) {
    const { p, backend, name, spec, install } = await fixture(),
      m = manifests.get(name);
    m.version = "2.0.0";
    m.platforms["windows-x64"].desktop = { path: ["."] };
    await p.install(spec + "@2.0.0");
    await p.use(spec + "@2.0.0");
    const target: EffectTarget = {
      kind: "registry",
      key: "HKCU\\Environment",
      name: "Path",
    };
    backend.registry.set(JSON.stringify(target), { type, value: original });
    const preview = await inspectDesktop(p.store, spec, false, backend);
    await applyDesktop(
      p.store,
      spec,
      { confirmed: true, binding: preview.binding },
      backend,
    );
    const integrated =
      (original ? original + ";" : "") +
      join(p.root, "apps", appFolder(install), "current");
    expect(await backend.read(target)).toEqual({ type, value: integrated });
    backend.registry.set(JSON.stringify(target), {
      type,
      value: integrated + ";C:\\later-user-tools",
    });
    const again = await inspectDesktop(p.store, spec, false, backend);
    await applyDesktop(
      p.store,
      spec,
      { confirmed: true, binding: again.binding },
      backend,
    );
    const remove = await inspectDesktop(p.store, spec, true, backend);
    await applyDesktop(
      p.store,
      spec,
      { confirmed: true, binding: remove.binding, remove: true },
      backend,
    );
    expect(await backend.read(target)).toEqual({
      type,
      value: (original ? original + ";" : "") + "C:\\later-user-tools",
    });
  }
});

test("desktop export contains only reapproval intent and never external registry snapshots", async () => {
  const { p, backend, spec } = await fixture();
  const preview = await inspectDesktop(p.store, spec, false, backend);
  await applyDesktop(
    p.store,
    spec,
    { confirmed: true, binding: preview.binding },
    backend,
  );
  const inventory = exportInventory(await p.store.read());
  expect(inventory.integrations).toContainEqual({
    package: spec,
    shell: "desktop",
  });
  expect(JSON.stringify(inventory)).not.toContain(p.root);
  expect(JSON.stringify(inventory)).not.toContain(preview.binding);
  const target = new Packages(join(work, crypto.randomUUID()));
  expect(
    (await planInventory(target, inventory)).steps.some(
      (s) => s.action === "desktop-integration-needs-new-approval",
    ),
  ).toBe(true);
});

test("desktop recovery rejects forged, duplicate and undeclared effects without partial restoration", async () => {
  const { p, backend, spec, install } = await fixture(),
    state = await p.store.read(),
    preview = await inspectDesktop(p.store, spec, false, backend),
    receipt = {
      id: install.id,
      declaration: install.desktop!,
      effects: preview.effects,
      binding: preview.binding,
    };
  await stageDesktopChange(
    p.root,
    state,
    install.key,
    preview.effects,
    receipt,
    backend,
  );
  const journal = desktopJournal(p.root),
    original = JSON.parse(await readFile(journal, "utf8")),
    registry = structuredClone(backend.registry),
    shortcut = join((await backend.folders()).startMenu, "Piko/Test App.lnk"),
    bytes = await readFile(shortcut);
  for (const mutation of [
    (j: any) => {
      j.effects[0].target.name = "UNDECLARED";
    },
    (j: any) => {
      j.effects[0].after.value = "forged value";
    },
    (j: any) => {
      j.effects.push(j.effects[0]);
    },
    (j: any) => {
      j.effects.at(-1).after = { type: "DWord", value: "not a number" };
    },
    (j: any) => {
      j.beforeRevision = -1;
    },
    (j: any) => {
      j.after = null;
    },
  ]) {
    const modified = structuredClone(original);
    mutation(modified);
    await writeFile(journal, JSON.stringify(modified));
    await expect(recoverDesktop(p.root, state, backend)).rejects.toThrow();
    expect(backend.registry).toEqual(registry);
    expect(await readFile(shortcut)).toEqual(bytes);
    expect(await readFile(journal, "utf8")).toBe(JSON.stringify(modified));
  }
  await writeFile(journal, JSON.stringify(original));
  await recoverDesktop(p.root, state, backend);
  expect(await backend.read(preview.effects[0]!.target)).toBeNull();
});

test("desktop recovery preflights all live resources before restoring any", async () => {
  const { p, backend, spec, install } = await fixture(),
    state = await p.store.read(),
    preview = await inspectDesktop(p.store, spec, false, backend);
  await stageDesktopChange(
    p.root,
    state,
    install.key,
    preview.effects,
    {
      id: install.id,
      declaration: install.desktop!,
      effects: preview.effects,
      binding: preview.binding,
    },
    backend,
  );
  const target = preview.effects[0]!.target;
  backend.registry.set(JSON.stringify(target), {
    type: "String",
    value: "external edit",
  });
  const registry = structuredClone(backend.registry),
    shortcut = join((await backend.folders()).startMenu, "Piko/Test App.lnk"),
    bytes = await readFile(shortcut);
  await expect(recoverDesktop(p.root, state, backend)).rejects.toThrow("drift");
  expect(backend.registry).toEqual(registry);
  expect(await readFile(shortcut)).toEqual(bytes);
  backend.registry.set(JSON.stringify(target), preview.effects[0]!.after);
  await recoverDesktop(p.root, state, backend);
  expect(await backend.read(target)).toBeNull();
});

test("desktop recovery handles interrupted removal on both sides of state commit", async () => {
  const { p, backend, spec, install } = await fixture();
  const enable = await inspectDesktop(p.store, spec, false, backend);
  await applyDesktop(
    p.store,
    spec,
    { confirmed: true, binding: enable.binding },
    backend,
  );
  const state = await p.store.read(),
    remove = await inspectDesktop(p.store, spec, true, backend);
  await stageDesktopChange(
    p.root,
    state,
    install.key,
    remove.effects,
    null,
    backend,
  );
  await recoverDesktop(p.root, state, backend);
  expect(await backend.read(enable.effects[0]!.target)).toEqual(
    enable.effects[0]!.after,
  );
  await stageDesktopChange(
    p.root,
    state,
    install.key,
    remove.effects,
    null,
    backend,
  );
  const committed = structuredClone(state);
  committed.revision++;
  delete committed.desktop![install.key];
  await recoverDesktop(p.root, committed, backend);
  expect(await backend.read(enable.effects[0]!.target)).toBeNull();
});

test("PATH removal recovery cannot claim unrelated user segments in its ownership receipt", async () => {
  const { p, backend, name, spec } = await fixture(),
    m = manifests.get(name);
  m.platforms["windows-x64"].desktop = { path: ["."] };
  m.version = "2.0.0";
  const install = await p.install(spec + "@2.0.0");
  await p.use(spec + "@2.0.0");
  const target: EffectTarget = {
    kind: "registry",
    key: "HKCU\\Environment",
    name: "Path",
  };
  backend.registry.set(JSON.stringify(target), {
    type: "String",
    value: "C:\\user-tools",
  });
  const enable = await inspectDesktop(p.store, spec, false, backend);
  await applyDesktop(
    p.store,
    spec,
    { confirmed: true, binding: enable.binding },
    backend,
  );
  const state = await p.store.read(),
    remove = await inspectDesktop(p.store, spec, true, backend);
  await stageDesktopChange(
    p.root,
    state,
    install.key,
    remove.effects,
    null,
    backend,
  );
  const journal = desktopJournal(p.root),
    original = JSON.parse(await readFile(journal, "utf8")),
    forged = structuredClone(original),
    committed = structuredClone(state);
  committed.revision++;
  delete committed.desktop![install.key];
  forged.before.effects[0].pathEntries.push("C:\\user-tools");
  forged.effects[0].after.value = "";
  await writeFile(journal, JSON.stringify(forged));
  await expect(recoverDesktop(p.root, committed, backend)).rejects.toThrow(
    "does not match",
  );
  expect(await backend.read(target)).toEqual({
    type: "String",
    value: "C:\\user-tools",
  });
  await writeFile(journal, JSON.stringify(original));
  await recoverDesktop(p.root, state, backend);
  expect(JSON.stringify(await backend.read(target))).toContain(
    appFolder(install),
  );
  expect(JSON.stringify(await backend.read(target))).toContain("user-tools");
  await stageDesktopChange(
    p.root,
    state,
    install.key,
    remove.effects,
    null,
    backend,
  );
  await recoverDesktop(p.root, committed, backend);
  expect(await backend.read(target)).toEqual({
    type: "String",
    value: "C:\\user-tools",
  });
});

test("committed desktop removal cannot forge prior ownership of an undeclared resource", async () => {
  const { p, backend, install } = await fixture(),
    state = await p.store.read(),
    target: EffectTarget = {
      kind: "registry",
      key: "HKCU\\Environment",
      name: "UNDECLARED",
    },
    effect = {
      target,
      before: null,
      after: { type: "String" as const, value: "unowned" },
    };
  backend.registry.set(JSON.stringify(target), effect.after);
  const journal = desktopJournal(p.root);
  await writeFile(
    journal,
    JSON.stringify({
      key: install.key,
      beforeRevision: state.revision,
      before: {
        id: install.id,
        declaration: install.desktop!,
        effects: [effect],
        binding: "a".repeat(64),
      },
      after: null,
      effects: [{ target, before: effect.after, after: null }],
    }),
  );
  const committed = structuredClone(state);
  committed.revision++;
  await expect(recoverDesktop(p.root, committed, backend)).rejects.toThrow();
  expect(await backend.read(target)).toEqual(effect.after);
});
