import { afterAll, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  copyFile,
  symlink,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Packages } from "../src/packages.ts";
import { makeSource } from "../src/catalog.ts";
import { packageKey, installId } from "../src/store.ts";
import { inspectRust, runRust, rustToolchain } from "../src/rust.ts";
import type { Install } from "../src/types.ts";

const root = await mkdtemp(join(tmpdir(), "piko-rust-management-"));
afterAll(() =>
  rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 }),
);
test("Rust toolchain requests reject paths, shell code and custom overrides", () => {
  for (const value of [
    "stable",
    "nightly-2026-10-01",
    "1.90.0-x86_64-pc-windows-msvc",
  ])
    expect(rustToolchain(value)).toBe(value);
  for (const value of [
    "../outside",
    "stable;exit",
    "C:/rust",
    "stable --force",
    "custom",
    "nightly\n",
  ])
    expect(() => rustToolchain(value)).toThrow();
});
test("Rust operations use isolated managed rustup, require bound approval and protect the active default", async () => {
  const sourceFile = join(root, "fake.ts"),
    exe = join(root, "fake.exe");
  await writeFile(
    sourceFile,
    `import{readFileSync,writeFileSync,mkdirSync,existsSync}from'node:fs';import{join}from'node:path';
const home=process.env.RUSTUP_HOME; if(!home)process.exit(5);mkdirSync(home,{recursive:true});const f=join(home,'state.json');let s=existsSync(f)?JSON.parse(readFileSync(f,'utf8')):{tools:[],active:''};const a=process.argv.slice(2);
if(a[0]==='toolchain'&&a[1]==='list')console.log(s.tools.map(x=>x+(s.active===x?' (default)':'')).join('\\n'));
else if(a[0]==='toolchain'&&a[1]==='install'){if(!s.tools.includes(a[2]))s.tools.push(a[2]);}
else if(a[0]==='default'){if(!s.tools.includes(a[1]))process.exit(6);s.active=a[1];}
else if(a[0]==='show')console.log(s.active+' (default)');
else if(a[0]==='toolchain'&&a[1]==='uninstall')s.tools=s.tools.filter(x=>x!==a[2]);
else if(a[0]!=='update')process.exit(7);writeFileSync(f,JSON.stringify(s));`,
  );
  expect(
    (
      await Bun.build({
        entrypoints: [sourceFile],
        compile: { target: "bun-windows-x64", outfile: exe },
      })
    ).success,
  ).toBe(true);
  const p = new Packages(join(root, "home"));
  const source = makeSource("main", "https://rust-fixture.invalid/", "http");
  const key = packageKey(source, "rustup"),
    id = installId(key, "1.0.0"),
    dir = join("apps", key, "1.0.0");
  const install: Install = {
    id,
    key,
    name: "rustup",
    version: "1.0.0",
    request: "1.0.0",
    source,
    dir,
    bins: {
      rustup: { path: ".cargo/bin/rustup.exe", kind: "native", data: true },
    },
    persist: [".cargo", ".rustup"],
    verified: true,
    checksum: "fixture",
    manifestHash: "fixture",
    kind: "portable",
    env: { CARGO_HOME: "{persist}/.cargo", RUSTUP_HOME: "{persist}/.rustup" },
    bootstrap: {
      path: "init.exe",
      args: [],
      outputs: [".cargo/bin/rustup.exe"],
    },
  };
  await mkdir(join(p.root, dir), { recursive: true });
  await copyFile(exe, join(p.root, dir, "init.exe"));
  for (const name of install.persist) {
    const shared = join(p.root, "persist", key, name);
    await mkdir(shared, { recursive: true });
    await symlink(shared, join(p.root, dir, name), "junction");
  }
  await mkdir(join(p.root, "persist", key, ".cargo/bin"));
  await copyFile(exe, join(p.root, "persist", key, ".cargo/bin/rustup.exe"));
  await writeFile(
    join(p.root, dir, ".piko-install.json"),
    JSON.stringify(install),
  );
  await p.store.mutate(async (s) => {
    s.sources.main = source;
    s.installs[id] = install;
    s.bootstraps = {
      [id]: {
        binding: "a".repeat(64),
        at: new Date().toISOString(),
        status: "completed",
      },
    };
  });
  await p.use("main/rustup@1.0.0");
  const before = await p.store.read(),
    plan = await inspectRust(p.store, "install", "stable");
  expect(plan.env.RUSTUP_HOME).toContain(p.root);
  expect(await p.store.read()).toEqual(before);
  await expect(runRust(p.store, "install", "stable", "bad")).rejects.toThrow(
    "--binding",
  );
  await runRust(p.store, "install", "stable", plan.binding);
  expect((await runRust(p.store, "list")).output).toBe("stable");
  const use = await inspectRust(p.store, "use", "stable");
  await runRust(p.store, "use", "stable", use.binding);
  const remove = await inspectRust(p.store, "remove", "stable");
  await expect(
    runRust(p.store, "remove", "stable", remove.binding),
  ).rejects.toThrow("different Rust default");
  const update = await inspectRust(p.store, "update", "stable");
  const bytes = Buffer.from("changed");
  await writeFile(join(p.root, "persist", key, ".cargo/bin/rustup.exe"), bytes);
  await expect(
    runRust(p.store, "update", "stable", update.binding),
  ).rejects.toThrow("--binding");
}, 30000);
