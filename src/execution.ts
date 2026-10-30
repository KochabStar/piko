import { persistentFolder } from "./layout.ts";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  installedForIntegration,
  integrationText,
  verifyInstall,
} from "./desktop.ts";
import { contentHash } from "./shell.ts";
import {
  validateAdmin,
  validateBootstrap,
} from "./integration-declarations.ts";
import { checkPersistentFileMappings } from "./persistence.ts";
import { fail, noLinks, sha256 } from "./util.ts";
import { nativeRequest } from "./windows-effects.ts";
import { powershellExecutable } from "./windows.ts";
import type { Store } from "./store.ts";
import type { ExecDeclaration, Install, State } from "./types.ts";

export async function persistentExecutable(
  root: string,
  state: State,
  install: Install,
  path: string,
) {
  if (
    !install.bootstrap?.outputs.includes(path) ||
    state.bootstraps?.[install.id]?.status !== "completed"
  )
    fail(
      "Run and approve this package's bootstrap before using generated commands",
    );
  const mapping = install.persist.find(
    (p) => path.startsWith(p + "/") && !install.persistFiles?.[p],
  );
  if (!mapping) fail("Generated command is not in a persistent directory");
  const { readlink } = await import("node:fs/promises");
  const link = join(root, install.dir, mapping),
    shared = join(
      root,
      "persist",
      persistentFolder(install, install.key),
      mapping,
    );
  if (
    !(await lstat(link)).isSymbolicLink() ||
    resolve(await readlink(link)).toLowerCase() !==
      resolve(shared).toLowerCase()
  )
    fail("Generated command persistent mapping changed");
  const target = join(
    root,
    "persist",
    persistentFolder(install, install.key),
    path,
  );
  await noLinks(target);
  if (!(await lstat(target)).isFile())
    fail("Generated command missing; rerun the approved bootstrap");
  return target;
}
async function planExecution(
  store: Store,
  state: State,
  spec: string,
  admin: boolean,
  remove = false,
) {
  const install = installedForIntegration(state, spec);
  await verifyInstall(store.root, install);
  await checkPersistentFileMappings(store.root, install);
  const declaration = admin ? install.admin : install.bootstrap;
  if (!declaration)
    fail(admin ? "No system integration declared" : "No bootstrap declared");
  if (admin) validateAdmin(declaration);
  else validateBootstrap(declaration);
  const exec: ExecDeclaration = admin
    ? remove
      ? install.admin!.remove
      : install.admin!.install
    : install.bootstrap!;
  const target = join(store.root, install.dir, exec.path);
  await noLinks(target);
  const info = await lstat(target);
  if (!info.isFile() || info.nlink !== 1)
    fail("Execution target is not an unlinked package file");
  if (
    install.persist.some(
      (p) => exec.path === p || exec.path.startsWith(p + "/"),
    )
  )
    fail("Executable bootstrap/system scripts cannot reside in mutable data");
  const env = Object.fromEntries(
    Object.entries(exec.env ?? {}).map(([k, v]) => [
      k,
      integrationText(store.root, install, v),
    ]),
  );
  const args = exec.args.map((a) => integrationText(store.root, install, a));
  const digest = await contentHash(store.root, install);
  const binding = sha256(
    JSON.stringify([
      state.revision,
      install.id,
      install.source.identity,
      declaration,
      digest,
      env,
      args,
      admin,
      remove,
    ]),
  );
  return { install, exec, target, env, args, binding, digest };
}
export async function inspectExecution(
  store: Store,
  spec: string,
  admin = false,
  remove = false,
) {
  const plan = await planExecution(
    store,
    await store.read(),
    spec,
    admin,
    remove,
  );
  return {
    package: spec,
    action: admin ? (remove ? "remove-system" : "install-system") : "bootstrap",
    binding: plan.binding,
    executable: plan.target,
    kind: plan.exec.kind ?? "native",
    script:
      plan.exec.kind === "powershell"
        ? (await readFile(plan.target, "utf8")).slice(0, 65536)
        : undefined,
    contentHash: plan.digest,
    args: plan.args,
    env: plan.env,
    outputs: admin ? undefined : plan.install.bootstrap!.outputs,
    warning: admin
      ? "ADMINISTRATOR code execution. Declared uninstall is also arbitrary privileged code; services/drivers/registry effects are not sandboxed or automatically rolled back. Run from an explicitly elevated terminal; Piko will never auto-elevate."
      : "Executes package code with your full user permissions and may download more software. External effects and partial persistent data are not rolled back. Piko does not verify downloads performed internally by this program. Installation/use remain separate.",
  };
}
export async function runExecution(
  store: Store,
  spec: string,
  options: {
    confirmed?: boolean;
    binding?: string;
    admin?: boolean;
    remove?: boolean;
  },
) {
  let receiptId = "",
    failure: string | undefined;
  await store.mutate(async (state) => {
    const plan = await planExecution(
      store,
      state,
      spec,
      !!options.admin,
      !!options.remove,
    );
    if (
      !options.confirmed ||
      !options.binding ||
      options.binding !== plan.binding
    )
      fail(
        "Execution requires dedicated approval and unchanged preview --binding",
      );
    if (options.admin && !(await nativeRequest({ op: "elevated" })))
      fail(
        "Administrator integration requires an explicitly elevated terminal; no automatic UAC launch",
      );
    receiptId = plan.install.id;
    state.schemaVersion = 6;
    state.aliases ??= {};
    state.data ??= {};
    const receipt = {
      binding: plan.binding,
      at: new Date().toISOString(),
      status: "running" as const,
    };
    if (options.admin) {
      if (options.remove && state.admin?.[receiptId]?.action !== "install")
        fail("No recorded active system integration to remove");
      state.admin ??= {};
      state.admin[receiptId] = { ...receipt, id: receiptId, action: "install" };
    } else {
      state.bootstraps ??= {};
      state.bootstraps[receiptId] = receipt;
    }
  });
  // Persist the started record before execution. An interrupted run remains
  // visible, never auto-runs on recover, and can be retried after a new preview.
  await store.mutate(async (state) => {
    const install =
      state.installs[receiptId] ?? fail("Execution installation disappeared");
    if (options.admin && !(await nativeRequest({ op: "elevated" })))
      fail("Administrator status changed before execution");
    const receipt = options.admin
      ? state.admin?.[receiptId]
      : state.bootstraps?.[receiptId];
    if (
      !receipt ||
      receipt.status !== "running" ||
      receipt.binding !== options.binding
    )
      fail("Execution reservation changed; inspect status");
    try {
      const plan = await planExecution(
        store,
        { ...state, revision: state.revision - 1 },
        spec,
        !!options.admin,
        !!options.remove,
      );
      if (plan.binding !== options.binding)
        fail("Execution inputs changed before launch");
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...plan.env,
        PIKO_HOME: store.root,
      };
      // Prevent inherited package-manager injection; no global policy changes.
      for (const key of Object.keys(env))
        if (
          /^(NODE_OPTIONS|BUN_OPTIONS|RUSTUP_INIT_SKIP_PATH_CHECK)$/i.test(key)
        )
          delete env[key];
      const command =
        plan.exec.kind === "powershell"
          ? [
              powershellExecutable(),
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-File",
              plan.target,
              ...plan.args,
            ]
          : [plan.target, ...plan.args];
      if (plan.exec.kind === "powershell") {
        const script = await readFile(plan.target, "utf8");
        if (Buffer.byteLength(script) > 65536)
          fail("Approved PowerShell script exceeds 64 KiB preview limit");
      }
      const child = Bun.spawn(command, {
        env,
        cwd: join(store.root, install.dir),
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        timeout: options.admin ? 300000 : 900000,
      });
      const code = await child.exited;
      if (code !== 0)
        fail(
          `Approved execution failed (exit ${code}); partial external effects/data may remain`,
        );
      if (!options.admin)
        for (const path of install.bootstrap!.outputs) {
          const target = join(
            store.root,
            "persist",
            persistentFolder(install, install.key),
            path,
          );
          await noLinks(target);
          if (!(await lstat(target)).isFile())
            fail("Bootstrap did not create a declared output");
        }
      receipt.status = "completed";
      if (options.admin && options.remove)
        state.admin![receiptId]!.action = "remove";
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      receipt.status = "failed";
      receipt.error = failure;
      if (options.admin && options.remove)
        state.admin![receiptId]!.action = "install";
    }
  });
  if (failure) fail(failure);
  return {
    status: "completed",
    defaultUnchanged: true,
    restartApplications: true,
  };
}
