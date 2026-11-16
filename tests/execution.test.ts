import { persistentFolder } from "../src/layout.ts";
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Packages } from "../src/packages.ts";
import {
  inspectExecution,
  runExecution,
  persistentExecutable,
} from "../src/execution.ts";
import { sha256 } from "../src/util.ts";
import { nativeRequest } from "../src/windows-effects.ts";
import { normalizeManifest } from "../src/catalog.ts";
import { WindowsEffects } from "../src/windows-effects.ts";
import type { Manifest } from "../src/types.ts";
import {
  inspectSystemUpgrade,
  applySystemUpgrade,
} from "../src/integration-upgrade.ts";
const work = await mkdtemp(join(tmpdir(), "piko-execution-tests-"));
afterAll(() =>
  rm(work, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 }),
);
const payload = Buffer.from(
  "param([string]$Output)\n[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Output)) | Out-Null\n[IO.File]::WriteAllText($Output,'generated command fixture')\nif ($env:PIKO_EXEC_FAIL -eq '1') {exit 23}\n",
);
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
    if (path === "file") return new Response(payload);
    return Response.json(manifests.get(path.replace(".json", "")));
  },
});
afterAll(() => server.stop(true));
async function fixture() {
  const p = new Packages(join(work, crypto.randomUUID())),
    name = "bootstrap-" + crypto.randomUUID().slice(0, 8);
  const m = {
    schemaVersion: 1,
    name,
    version: "1.0.0",
    platforms: {
      "windows-x64": {
        url: `http://127.0.0.1:${server.port}/file`,
        sha256: sha256(payload),
        format: "file",
        file: "bootstrap.ps1",
        bin: {
          generated: { path: "data/bin/tool.exe", kind: "native", data: true },
        },
        persist: ["data"],
        bootstrap: {
          kind: "powershell",
          path: "bootstrap.ps1",
          args: ["{persist}/data/bin/tool.exe"],
          outputs: ["data/bin/tool.exe"],
        },
      },
    },
  };
  manifests.set(name, m);
  await p.addSource("main", `http://127.0.0.1:${server.port}/`);
  const install = await p.install("main/" + name + "@1.0.0");
  return { p, install, spec: "main/" + name, m };
}
test("install never executes a bootstrap, dedicated bound approval generates persistent commands without selecting defaults", async () => {
  const { p, install, spec } = await fixture();
  expect((await p.store.read()).bootstraps).toBeUndefined();
  await expect(p.use(spec)).rejects.toThrow("bootstrap");
  const plan = await inspectExecution(p.store, spec);
  await expect(
    runExecution(p.store, spec, { confirmed: true }),
  ).rejects.toThrow("dedicated approval");
  await runExecution(p.store, spec, { confirmed: true, binding: plan.binding });
  const s = await p.store.read();
  expect(s.bootstraps?.[install.id]?.status).toBe("completed");
  expect(s.defaults).toEqual({});
  await p.use(spec);
  const target = await persistentExecutable(
    p.root,
    await p.store.read(),
    install,
    "data/bin/tool.exe",
  );
  expect(await readFile(target, "utf8")).toBe("generated command fixture");
  await p.unuse(spec);
  await p.uninstall(spec + "@1.0.0");
  expect(await readFile(target, "utf8")).toBe("generated command fixture");
}, 30000);
test("execution rejects changed code/state after preview and preserves partial data on failure", async () => {
  const { p, install, spec } = await fixture(),
    plan = await inspectExecution(p.store, spec);
  await writeFile(
    join(p.root, install.dir, "bootstrap.ps1"),
    Buffer.concat([payload, Buffer.from("# changed\n")]),
  );
  await expect(
    runExecution(p.store, spec, { confirmed: true, binding: plan.binding }),
  ).rejects.toThrow("preview");
  const old = process.env.PIKO_EXEC_FAIL;
  process.env.PIKO_EXEC_FAIL = "1";
  try {
    const fresh = await inspectExecution(p.store, spec);
    await expect(
      runExecution(p.store, spec, { confirmed: true, binding: fresh.binding }),
    ).rejects.toThrow("exit 23");
    expect((await p.store.read()).bootstraps?.[install.id]?.status).toBe(
      "failed",
    );
    expect(
      await readFile(
        join(
          p.root,
          "persist",
          persistentFolder(install, install.key),
          "data/bin/tool.exe",
        ),
        "utf8",
      ),
    ).toBe("generated command fixture");
    await expect(p.use(spec)).rejects.toThrow("bootstrap");
  } finally {
    if (old === undefined) delete process.env.PIKO_EXEC_FAIL;
    else process.env.PIKO_EXEC_FAIL = old;
  }
}, 30000);
test("system upgrade binds old removal and new installation in a single inert preview", async () => {
  const { p, m, spec } = await fixture();
  // No generated commands are needed for this system-only fixture.
  m.version = "2.0.0";
  const action = { kind: "powershell", path: "bootstrap.ps1", args: [] };
  Object.assign(m.platforms["windows-x64"], {
    bin: {},
    admin: { install: action, remove: action },
  });
  const previous = await p.install(spec + "@2.0.0");
  await p.use(spec + "@2.0.0");
  await p.store.mutate(async (s) => {
    s.admin = {
      [previous.id]: {
        id: previous.id,
        action: "install",
        binding: "a".repeat(64),
        at: new Date().toISOString(),
        status: "completed",
      },
    };
  });
  m.version = "3.0.0";
  const target = await p.install(spec + "@3.0.0");
  const before = await p.store.read();
  const preview = await inspectSystemUpgrade(p, spec + "@3.0.0");
  expect(preview.remove?.action).toBe("remove-system");
  expect(preview.install.action).toBe("install-system");
  expect(preview.target).toBe(target.id);
  expect(await p.store.read()).toEqual(before);
  await expect(applySystemUpgrade(p, spec + "@3.0.0", "bad")).rejects.toThrow(
    "changed",
  );
  await writeFile(
    join(p.root, target.dir, "bootstrap.ps1"),
    Buffer.concat([payload, Buffer.from("# change")]),
  );
  await expect(
    applySystemUpgrade(p, spec + "@3.0.0", preview.binding),
  ).rejects.toThrow("changed");
  expect(await p.store.read()).toEqual(before);
});

class ServiceEffects extends WindowsEffects {
  allowAdmin = true;
  override async elevated() {
    return this.allowAdmin;
  }
}
async function serviceFixture() {
  const root = join(work, crypto.randomUUID());
  const effects = new ServiceEffects(join(root, "external"));
  const p = new Packages(root, effects);
  const name = "service-" + crypto.randomUUID().slice(0, 8);
  const script = `param([string]$Action,[string]$Data,[string]$Version)
$ErrorActionPreference='Stop'
$null=[IO.Directory]::CreateDirectory($Data)
$s=Get-Content -LiteralPath (Join-Path $env:PIKO_HOME 'apps/piko/state.json') -Raw -Encoding UTF8|ConvertFrom-Json
$choice=@($s.defaults.psobject.Properties|Select-Object -First 1)
$selected=if($choice.Count){$s.installs.($choice[0].Value.id).version}else{'none'}
[IO.File]::AppendAllText((Join-Path $Data 'events'),($Action+':'+$Version+':'+$selected+[Environment]::NewLine))
if(Test-Path -LiteralPath (Join-Path $Data ('fail-'+$Action+'-'+$Version))){throw 'injected service failure'}
`;
  const action = (verb: string) => ({
    kind: "powershell" as const,
    path: "service.ps1",
    args: [verb, "{persist}/data", "{version}"],
  });
  const manifest: Manifest = {
    schemaVersion: 1,
    name,
    version: "1.0.0",
    platforms: {
      "windows-x64": {
        url: `http://127.0.0.1:${server.port}/file`,
        sha256: sha256(payload),
        format: "file",
        file: "bootstrap.ps1",
        bin: {},
        persist: ["data"],
        configFiles: { "service.ps1": script },
        admin: {
          required: true,
          install: action("install"),
          remove: action("remove"),
        },
      },
    },
  };
  manifests.set(name, manifest);
  await p.addSource("main", `http://127.0.0.1:${server.port}/`);
  const spec = "main/" + name;
  const install = await p.install(spec + "@1.0.0");
  const data = join(
    root,
    "persist",
    persistentFolder(install, install.key),
    "data",
  );
  const approve = async (version: string, remove = false) => {
    const target = spec + "@" + version;
    const plan = await inspectExecution(p.store, target, true, remove);
    return runExecution(p.store, target, {
      admin: true,
      remove,
      confirmed: true,
      binding: plan.binding,
    });
  };
  return { p, effects, manifest, install, spec, data, approve };
}
test("required services need successful dedicated approval and removal before uninstall, while data survives reinstall", async () => {
  const { p, effects, install, spec, data, approve } = await serviceFixture();
  await expect(p.use(spec + "@latest")).rejects.toThrow(
    "Required system integration",
  );
  await expect(p.uninstall(spec)).rejects.toThrow("system");
  effects.allowAdmin = false;
  await expect(approve("1.0.0")).rejects.toThrow(
    "Administrator permission required",
  );
  expect((await p.store.read()).admin).toBeUndefined();
  effects.allowAdmin = true;
  await writeFile(join(data, "fail-install-1.0.0"), "fail");
  await expect(approve("1.0.0")).rejects.toThrow("Approved execution failed");
  await expect(p.use(spec + "@latest")).rejects.toThrow(
    "Required system integration",
  );
  await rm(join(data, "fail-install-1.0.0"));
  await approve("1.0.0");
  await p.use(spec + "@latest");
  await writeFile(join(data, "settings"), "user data");
  await expect(p.uninstall(spec)).rejects.toThrow("system");
  await approve("1.0.0", true);
  await p.uninstall(spec);
  expect(await readFile(join(data, "settings"), "utf8")).toBe("user data");
  const reinstalled = await p.install(spec + "@1.0.0");
  expect(reinstalled.id).toBe(install.id);
  await expect(p.use(spec + "@latest")).rejects.toThrow(
    "Required system integration",
  );
  await approve("1.0.0");
  await p.use(spec + "@latest");
  expect((await p.store.read()).defaults[install.key]?.id).toBe(install.id);
  expect(await readFile(join(data, "settings"), "utf8")).toBe("user data");
}, 30000);
test("failed service upgrade keeps the old selection and explicit retry selects only after success without pinning latest", async () => {
  const { p, manifest, install, spec, data, approve } = await serviceFixture();
  await approve("1.0.0");
  await p.use(spec + "@latest");
  manifest.version = "2.0.0";
  const target = await p.install(spec + "@2.0.0");
  await expect(p.use(spec + "@2.0.0")).rejects.toThrow("--upgrade");
  await writeFile(join(data, "fail-install-2.0.0"), "fail");
  const preview = await inspectSystemUpgrade(p, spec + "@2.0.0");
  await expect(
    applySystemUpgrade(p, spec + "@2.0.0", preview.binding),
  ).rejects.toThrow("Approved execution failed");
  let state = await p.store.read();
  expect(state.defaults[install.key]?.id).toBe(install.id);
  expect(state.admin?.[target.id]?.status).toBe("failed");
  expect(await readFile(join(data, "events"), "utf8")).toContain(
    "install:2.0.0:1.0.0",
  );
  await rm(join(data, "fail-install-2.0.0"));
  await approve("2.0.0");
  const before = await readFile(join(data, "events"), "utf8");
  const retry = await inspectSystemUpgrade(p, spec + "@2.0.0");
  await applySystemUpgrade(p, spec + "@2.0.0", retry.binding);
  state = await p.store.read();
  expect(state.defaults[install.key]).toMatchObject({
    id: target.id,
    request: "latest",
  });
  expect(await readFile(join(data, "events"), "utf8")).toBe(before);
  await p.uninstall(spec + "@1.0.0");
  expect((await p.store.read()).installs[install.id]).toBeUndefined();
}, 30000);
test("update --approve-admin migrates the required service and selects in one command", async () => {
  const { p, manifest, install, spec, approve } = await serviceFixture();
  await approve("1.0.0");
  await p.use(spec + "@latest");
  manifest.version = "2.0.0";
  await expect(p.update(spec)).rejects.toThrow("--approve-admin");
  await p.update(spec, { approveAdmin: true });
  const state = await p.store.read(),
    target = Object.values(state.installs).find((i) => i.version === "2.0.0")!;
  expect(state.defaults[install.key]).toMatchObject({
    id: target.id,
    request: "latest",
  });
  expect(state.admin?.[target.id]?.status).toBe("completed");
  expect(state.admin?.[install.id]?.action).toBe("remove");
  await p.use(spec + "@latest");
}, 30000);

test("execution declarations reject mutable scripts, missing persistent outputs and shell-string execution", async () => {
  const { m } = await fixture();
  for (const bootstrap of [
    { path: "bad.cmd", args: [], outputs: ["data/x"] },
    {
      path: "bootstrap.ps1",
      kind: "powershell",
      args: "execute",
      outputs: ["data/x"],
    },
    {
      path: "bootstrap.ps1",
      kind: "powershell",
      args: [],
      outputs: ["../escape"],
    },
    {
      path: "bootstrap.ps1",
      kind: "powershell",
      args: [],
      outputs: ["outside.exe"],
    },
  ])
    expect(() =>
      normalizeManifest(
        {
          ...m,
          platforms: {
            "windows-x64": { ...m.platforms["windows-x64"], bootstrap },
          },
        },
        m.name,
        m.version,
      ),
    ).toThrow();
});

test("javascript integrations run in-process with declared args and fail closed", async () => {
  const p = new Packages(join(work, crypto.randomUUID())),
    name = "jsexec-" + crypto.randomUUID().slice(0, 8);
  const script = `import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
export default async function (ctx) {
  const [action, output] = ctx.args;
  if (action === "install") {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, "generated-by-js;" + ctx.env.PIKO_HOME);
  } else if (action === "remove") {
    rmSync(output);
  } else if (action === "fail") {
    throw new Error("js integration refused");
  }
}
`;
  const m = {
    schemaVersion: 1,
    name,
    version: "1.0.0",
    platforms: {
      "windows-x64": {
        url: `http://127.0.0.1:${server.port}/file`,
        sha256: sha256(payload),
        format: "file",
        file: "payload.ps1",
        bin: {},
        persist: ["data", ".piko-system"],
        configFiles: { "integration.js": script },
        bootstrap: {
          kind: "javascript",
          path: "integration.js",
          args: ["install", "{persist}/data/generated.txt"],
          outputs: ["data/generated.txt"],
        },
      },
    },
  };
  manifests.set(name, m);
  await p.addSource("main", `http://127.0.0.1:${server.port}/`);
  const install = await p.install("main/" + name + "@1.0.0");
  const spec = "main/" + name,
    output = join(
      p.root,
      "persist",
      persistentFolder(install, install.key),
      "data/generated.txt",
    );
  const preview = await inspectExecution(p.store, spec);
  expect(preview.kind).toBe("javascript");
  expect(preview.script).toContain("export default async function");
  expect(preview.args[1].endsWith("data/generated.txt")).toBe(true);
  await expect(
    runExecution(p.store, spec, { confirmed: true }),
  ).rejects.toThrow("binding");
  // The rejected attempt advanced the state revision; preview again.
  const approved = await inspectExecution(p.store, spec);
  await runExecution(p.store, spec, {
    confirmed: true,
    binding: approved.binding,
  });
  expect(await readFile(output, "utf8")).toContain("generated-by-js;");
  expect((await p.store.read()).bootstraps?.[install.id]?.status).toBe(
    "completed",
  );
  // A throwing module marks the receipt failed and surfaces its reason.
  await writeFile(
    join(p.root, install.dir, "integration.js"),
    "export default async function () { throw new Error('js integration refused'); }\n",
  );
  const failed = await inspectExecution(p.store, spec);
  await expect(
    runExecution(p.store, spec, {
      confirmed: true,
      binding: failed.binding,
    }),
  ).rejects.toThrow("js integration refused");
  expect((await p.store.read()).bootstraps?.[install.id]?.status).toBe(
    "failed",
  );
}, 30000);

test("javascript admin declarations preview like PowerShell and still require elevation", async () => {
  const p = new Packages(join(work, crypto.randomUUID())),
    name = "jsadmin-" + crypto.randomUUID().slice(0, 8);
  const m = {
    schemaVersion: 1,
    name,
    version: "1.0.0",
    platforms: {
      "windows-x64": {
        url: `http://127.0.0.1:${server.port}/file`,
        sha256: sha256(payload),
        format: "file",
        file: "payload.ps1",
        bin: {},
        persist: [".piko-system"],
        configFiles: {
          "service.js": "export default async function () {}\n",
        },
        admin: {
          install: {
            kind: "javascript",
            path: "service.js",
            args: ["install", "{root}"],
          },
          remove: { kind: "javascript", path: "service.js", args: ["remove"] },
        },
      },
    },
  };
  manifests.set(name, m);
  await p.addSource("main", `http://127.0.0.1:${server.port}/`);
  await p.install("main/" + name + "@1.0.0");
  const spec = "main/" + name,
    preview = await inspectExecution(p.store, spec, true);
  expect(preview.action).toBe("install-system");
  expect(preview.kind).toBe("javascript");
  expect(preview.script).toContain("export default async function");
  expect(preview.warning).toContain("ADMINISTRATOR");
  const remove = await inspectExecution(p.store, spec, true, true);
  expect(remove.action).toBe("remove-system");
  if (!(await nativeRequest({ op: "elevated" })))
    await expect(
      runExecution(p.store, spec, {
        admin: true,
        confirmed: true,
        binding: preview.binding,
      }),
    ).rejects.toThrow("Administrator permission required");
}, 30000);
