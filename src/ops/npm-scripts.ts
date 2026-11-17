import { cp, lstat, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { npmContext } from "../npm.ts";
import { npmCompatibility } from "../npm-runtime.ts";
import {
  npmSnapshotPath,
  npmTreeHash,
  rebuildNpm,
  scriptPlan,
} from "../scripts.ts";
import { atomicJson, capture, fail, noLinks, removeTree } from "../util.ts";
import { exactNpm, installed } from "./shared.ts";
import type { Install } from "../types.ts";
import type { PackagesContext } from "./context.ts";

export type ScriptPlan = {
  install: string;
  inputHash: string;
  warning: string;
  scripts: {
    path: string;
    name: string;
    version: string;
    resolved: string;
    integrity: string;
    events: Record<string, string>;
    binding: string;
    approved: boolean;
  }[];
  graph: { path: string; resolved: string; integrity: string }[];
};

export async function scriptInventory(
  ops: PackagesContext,
  spec: string,
): Promise<NonNullable<Install["scripts"]>> {
  const state = await ops.store.read(),
    match = installed(state, spec);
  const installation = match.request
    ? match.installs.find((i) => i.version === match.request)
    : match.installs.length === 1
      ? match.installs[0]
      : undefined;
  if (!installation || installation.kind !== "npm")
    fail("Select an exact installed npm package version");
  return installation.scripts ?? [];
}

export async function inspectScripts(
  ops: PackagesContext,
  spec: string,
): Promise<ScriptPlan> {
  return await scriptPlan(ops.root, exactNpm(await ops.store.read(), spec));
}

export async function approveScripts(
  ops: PackagesContext,
  spec: string,
  path: string,
  binding: string,
): Promise<void> {
  await ops.store.mutate(async (state) => {
    const install = exactNpm(state, spec),
      plan = await scriptPlan(ops.root, install);
    const script = plan.scripts.find((s) => s.path === path);
    if (!script || script.binding !== binding)
      fail(
        "Script approval contents changed; inspect again and confirm the exact binding",
      );

    if (plan.graph.filter((g) => g.resolved === script.resolved).length !== 1)
      fail("Duplicate resolved package cannot be approved at path granularity");
    install.npmBuild!.approvals[path] = {
      binding,
      approvedAt: new Date().toISOString(),
    };
  });
}

export async function revokeScripts(
  ops: PackagesContext,
  spec: string,
  path: string,
): Promise<void> {
  await ops.store.mutate(async (state) => {
    const install = exactNpm(state, spec);
    if (!install.npmBuild?.approvals[path])
      fail("No script approval exists at this exact path");
    delete install.npmBuild.approvals[path];
  });
}

export async function rebuildScripts(
  ops: PackagesContext,
  spec: string,
): Promise<void> {
  await ops.store.mutate(async (state) => {
    const before = exactNpm(state, spec),
      plan = await scriptPlan(ops.root, before),
      context = await npmContext(ops.root, state, before.name);
    if (context.registry !== before.source.url)
      fail(
        "npm registry changed; refusing to rebuild against a different source",
      );
    const operation = "npm-rebuild-" + crypto.randomUUID(),
      control = join(ops.root, "staging", operation),
      stage = join(control, "app"),
      live = join(ops.root, before.dir),
      backup = join(control, "old");
    await noLinks(control);
    await mkdir(control, { recursive: true });
    let journaled = false;
    try {
      await cp(npmSnapshotPath(ops.root, plan.inputHash), stage, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      if ((await npmTreeHash(stage)) !== plan.inputHash)
        fail("npm snapshot changed while preparing rebuild");
      await rebuildNpm(
        context,
        stage,
        control,
        plan,
        before.npmBuild!.approvals,
      );
      const after = structuredClone(before);
      after.npmBuild!.currentHash = await npmTreeHash(stage);
      after.npmBuild!.lastRun = {
        at: new Date().toISOString(),
        node: await capture(context.node, ["--version"], {
          env: context.env,
        }),
        npm: context.version,
        paths: plan.scripts.filter((s) => s.approved).map((s) => s.path),
      };
      if (
        (await npmTreeHash(npmSnapshotPath(ops.root, plan.inputHash))) !==
        plan.inputHash
      )
        fail("npm snapshot changed during rebuild; refusing replacement");
      after.runtimeVersion = after.npmBuild!.lastRun.node;
      after.npmCompatibility = await npmCompatibility(stage, context.node);
      for (const bin of Object.values(after.bins)) {
        const path = join(stage, bin.path);
        await noLinks(path);
        if (!(await lstat(path)).isFile())
          fail("Rebuild removed a CLI executable");
      }
      await atomicJson(join(stage, ".piko-install.json"), after);
      if ((await npmTreeHash(live)) !== before.npmBuild!.currentHash)
        fail(
          "Original npm installation changed during rebuild; refusing replacement",
        );
      await atomicJson(ops.store.rebuildPath, { operation, before, after });
      journaled = true;
      await rename(live, backup);
      await rename(stage, live);
      state.installs[after.id] = after;
    } finally {
      if (!journaled) await removeTree(control);
    }
  });
}
