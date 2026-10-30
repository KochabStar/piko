import { persistentFolder } from "./layout.ts";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { persistentExecutable } from "./execution.ts";
import { integrationText } from "./desktop.ts";
import {
  atomicJson,
  capture,
  exists,
  fail,
  inside,
  noLinks,
  sha256,
} from "./util.ts";
import type { Store } from "./store.ts";

export function rustToolchain(value: string) {
  if (
    !/^(?:stable|beta|nightly|\d+\.\d+(?:\.\d+)?)(?:-\d{4}-\d{2}-\d{2})?(?:-(?:x86_64|aarch64|i686)-pc-windows-(?:msvc|gnu))?$/.test(
      value,
    )
  )
    fail(
      "Use a Rust release/channel, optional date and explicit Windows target; paths and arbitrary custom toolchains are refused",
    );
  return value;
}
export async function inspectRust(
  store: Store,
  action: string,
  toolchain?: string,
) {
  if (!["list", "install", "use", "remove", "update"].includes(action))
    fail("Use rust list/install/use/remove/update");
  if (action !== "list") rustToolchain(toolchain ?? "");
  const state = await store.read();
  const providers = Object.values(state.defaults)
    .map((s) => state.installs[s.id]!)
    .filter((i) => i.name === "rustup" && i.verified);
  if (providers.length !== 1)
    fail("Select exactly one managed, bootstrapped rustup provider first");
  const install = providers[0]!;
  const bin = install.bins.rustup;
  if (!bin?.data)
    fail("Rust management requires an explicitly bootstrapped rustup command");
  const executable = await persistentExecutable(
    store.root,
    state,
    install,
    bin.path,
  );
  const env = Object.fromEntries(
    Object.entries(install.env ?? {}).map(([name, value]) => [
      name,
      integrationText(store.root, install, value),
    ]),
  );
  if (!env.CARGO_HOME || !env.RUSTUP_HOME)
    fail("rustup must declare isolated CARGO_HOME and RUSTUP_HOME");
  for (const home of [env.CARGO_HOME, env.RUSTUP_HOME]) {
    inside(
      join(store.root, "persist", persistentFolder(install, install.key)),
      resolve(home),
    );
    await noLinks(home);
  }
  const settings = join(env.RUSTUP_HOME, "settings.toml");
  const toolchains = join(env.RUSTUP_HOME, "toolchains");
  await noLinks(settings);
  await noLinks(toolchains);
  const toolchainStateHash = sha256(
    JSON.stringify([
      (await exists(settings))
        ? (await readFile(settings)).toString("base64")
        : null,
      (await exists(toolchains)) ? (await readdir(toolchains)).sort() : [],
    ]),
  );
  // Explicitly bind user-selected distribution mirrors, but ignore project overrides.
  for (const key of ["RUSTUP_DIST_SERVER", "RUSTUP_UPDATE_ROOT"])
    if (process.env[key]) env[key] = process.env[key]!;
  const args =
    action === "list"
      ? ["toolchain", "list", "--verbose"]
      : action === "use"
        ? ["default", toolchain!]
        : action === "install"
          ? [
              "toolchain",
              "install",
              toolchain!,
              "--profile",
              "minimal",
              "--no-self-update",
            ]
          : action === "remove"
            ? ["toolchain", "uninstall", toolchain!]
            : ["update", toolchain!, "--no-self-update"];
  const executableHash = sha256(await readFile(executable));
  const data = {
    revision: state.revision,
    provider: install.id,
    action,
    toolchain,
    executable,
    executableHash,
    toolchainStateHash,
    args,
    env,
  };
  return {
    ...data,
    binding: sha256(JSON.stringify(data)),
    warning:
      "Uses only managed rustup with isolated homes. rustup verifies its downloads; Piko does not reimplement the Rust distribution protocol. Toolchains are not installed globally and MSVC/SDK are not installed automatically.",
  };
}
export async function runRust(
  store: Store,
  action: string,
  toolchain?: string,
  binding?: string,
) {
  const plan = await inspectRust(store, action, toolchain);
  if (action !== "list" && (!binding || binding !== plan.binding))
    fail("Rust changes require --approve-exec and unchanged preview --binding");
  let output = "";
  await store.mutate(
    async (state) => {
      if (state.revision !== plan.revision)
        fail("State changed during Rust approval; preview again");
      const current = await inspectRust(store, action, toolchain);
      if (current.binding !== plan.binding)
        fail("rustup content or environment changed");
      const env = { ...process.env, ...plan.env };
      for (const key of Object.keys(env))
        if (key.toUpperCase() === "RUSTUP_TOOLCHAIN") delete env[key];
      if (action === "use" || action === "remove") {
        const listing = await capture(plan.executable, ["toolchain", "list"], {
          env,
          cwd: join(store.root, "apps/piko"),
        });
        const matches = listing
          .split(/\r?\n/)
          .filter(
            (line) =>
              line.split(/\s/)[0] === toolchain ||
              line.startsWith(toolchain + "-"),
          );
        if (action === "use" && !matches.length)
          fail("Install the Rust toolchain explicitly before selecting it");
        if (
          action === "remove" &&
          matches.some((line) => /\([^)]*default[^)]*\)/.test(line))
        )
          fail("Select a different Rust default before removing its toolchain");
      }
      const journal = join(
        store.root,
        "apps/piko/rust-operations",
        plan.binding + ".json",
      );
      if (action !== "list")
        await atomicJson(journal, { ...plan, status: "running" });
      try {
        output = await capture(plan.executable, plan.args, {
          env,
          cwd: join(store.root, "apps/piko"),
        });
        if (action !== "list")
          await atomicJson(journal, { ...plan, status: "completed", output });
      } catch (error) {
        if (action !== "list")
          await atomicJson(journal, {
            ...plan,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        throw error;
      }
    },
    { skipUnchanged: action === "list" },
  );
  return { status: "completed", output };
}
