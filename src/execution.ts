import { persistentFolder } from "./layout.ts";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
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
import { WindowsEffects } from "./windows-effects.ts";
import { powershellExecutable } from "./windows.ts";
import { pathToFileURL } from "node:url";
import { ensureInstallReceipt, synchronizeReceipts } from "./receipt.ts";
import type { Store } from "./store.ts";
import type {
  AdminDeclaration,
  BootstrapDeclaration,
  ExecDeclaration,
  Install,
  State,
} from "./types.ts";

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
  const history = state.receipts?.[install.id]?.admin;
  let declaration: AdminDeclaration | BootstrapDeclaration;
  let exec: ExecDeclaration;
  if (admin) {
    const system = (remove ? history?.declaration : undefined) ?? install.admin;
    if (!system) fail("No system integration declared");
    if (
      remove &&
      !history?.install &&
      state.admin?.[install.id]?.action !== "install"
    )
      fail(
        "No recorded system installation to remove; a manifest is not execution approval",
      );
    validateAdmin(system);
    declaration = system;
    exec = remove ? system.remove : system.install;
  } else {
    const bootstrap = install.bootstrap ?? fail("No bootstrap declared");
    validateBootstrap(bootstrap);
    declaration = bootstrap;
    exec = bootstrap;
  }
  const target = join(store.root, install.dir, exec.path);
  await noLinks(target);
  const info = await lstat(target);
  if (!info.isFile() || info.nlink !== 1)
    fail("Execution target is not an unlinked package file");
  if (
    (exec.kind === "powershell" || exec.kind === "javascript") &&
    info.size > 65536
  )
    fail("Approved integration script exceeds 64 KiB preview limit");
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
      plan.exec.kind === "powershell" || plan.exec.kind === "javascript"
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
type ExecutionOptions = {
  confirmed?: boolean;
  binding?: string;
  admin?: boolean;
  remove?: boolean;
};

/** Preflight automatic removal without launching package code or changing state. */
export async function preflightAdminRemoval(
  store: Store,
  state: State,
  install: Install,
) {
  const history = ensureInstallReceipt(state, install).admin;
  if (!history?.install || history.remove?.status === "completed") return;
  if (history.install.status !== "completed")
    fail(
      "System installation failed or was interrupted; inspect and explicitly reconcile piko system before uninstalling",
    );
  if (!(await (store.effectsBackend ?? new WindowsEffects()).elevated()))
    fail(
      "Administrator permission required: open an Administrator terminal and rerun uninstall. Piko never opens a UAC prompt by itself.",
    );
  const spec = `${install.source.alias}/${install.name}@${install.version}`;
  const plan = await planExecution(store, state, spec, true, true);
  if (history.contentHash && history.contentHash !== plan.digest)
    fail(
      "Approved system integration content changed; inspect and explicitly reconcile before uninstalling",
    );
}

async function persistExecutionReceipt(
  store: Store,
  state: State,
  install: Install,
  admin: boolean,
): Promise<void> {
  const before = await store.read();
  const checkpoint = structuredClone(before);
  if (admin) {
    checkpoint.admin ??= {};
    checkpoint.admin[install.id] = structuredClone(state.admin![install.id]!);
    ensureInstallReceipt(checkpoint, install).admin = structuredClone(
      ensureInstallReceipt(state, install).admin,
    );
  } else {
    checkpoint.bootstraps ??= {};
    checkpoint.bootstraps[install.id] = structuredClone(
      state.bootstraps![install.id]!,
    );
  }
  await store.commit(before, checkpoint);
  state.revision = checkpoint.revision;
}

/** Run under the caller's mutation lock; persist running and completion separately. */
async function runExecutionLocked(
  store: Store,
  state: State,
  spec: string,
  options: ExecutionOptions,
  automaticRemoval = false,
) {
  synchronizeReceipts(state);
  const plan = await planExecution(
    store,
    state,
    spec,
    !!options.admin,
    !!options.remove,
  );
  if (
    !automaticRemoval &&
    (!options.confirmed || !options.binding || options.binding !== plan.binding)
  )
    fail(
      "Execution requires dedicated approval and unchanged preview --binding",
    );
  const install = plan.install;
  const unified = ensureInstallReceipt(state, install);
  if (options.admin) {
    if (!(await (store.effectsBackend ?? new WindowsEffects()).elevated()))
      fail(
        "Administrator permission required: open an Administrator terminal (right-click your terminal and choose Run as administrator) and rerun the same command. Piko never opens a UAC prompt by itself.",
      );
    if (options.remove) {
      if (!unified.admin?.install)
        fail(
          "No recorded system installation to remove; a manifest is not execution approval",
        );
      if (automaticRemoval) await preflightAdminRemoval(store, state, install);
    } else if (
      Object.values(state.installs).some((other) => {
        if (other.id === install.id || other.key !== install.key) return false;
        const history = ensureInstallReceipt(state, other).admin;
        return !!history?.install && history.remove?.status !== "completed";
      })
    )
      fail(
        "Another version owns system integration; Administrator terminal: piko system <target-exact-version> --upgrade --approve-admin",
      );
  }
  const receipt = {
    binding: plan.binding,
    at: new Date().toISOString(),
    status: "running" as "running" | "completed" | "failed",
    error: undefined as string | undefined,
  };
  if (options.admin) {
    const action = options.remove ? "remove" : "install";
    state.admin ??= {};
    state.admin[install.id] = { ...receipt, id: install.id, action };
    unified.admin ??= {};
    unified.admin[action] = state.admin[install.id];
    if (!options.remove) {
      unified.admin.declaration = structuredClone(install.admin!);
      unified.admin.contentHash = plan.digest;
      delete unified.admin.remove;
    }
  } else {
    state.bootstraps ??= {};
    state.bootstraps[install.id] = receipt;
  }
  // The existing lock stays held across both checkpoints and arbitrary code.
  // Store.mutate rebases its final commit after helpers publish checkpoints.
  await persistExecutionReceipt(store, state, install, !!options.admin);
  let failure: string | undefined;
  try {
    const current = await planExecution(
      store,
      { ...state, revision: state.revision - 1 },
      spec,
      !!options.admin,
      !!options.remove,
    );
    if (current.binding !== plan.binding)
      fail("Execution inputs changed before launch");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...plan.env,
      PIKO_HOME: store.root,
    };
    // Prevent inherited package-manager injection; no global policy changes.
    for (const key of Object.keys(env))
      if (/^(NODE_OPTIONS|BUN_OPTIONS|RUSTUP_INIT_SKIP_PATH_CHECK)$/i.test(key))
        delete env[key];
    if (plan.exec.kind === "powershell" || plan.exec.kind === "javascript") {
      const script = await readFile(plan.target, "utf8");
      if (Buffer.byteLength(script) > 65536)
        fail("Approved integration script exceeds 64 KiB preview limit");
    }
    if (plan.exec.kind === "javascript") {
      // Approved package code runs inside this (already elevated for admin)
      // Piko process on its embedded JavaScript runtime: no shell, no
      // PowerShell quoting or profile pitfalls. The module receives its
      // declared arguments instead of parsing a command line.
      // Bun's module cache ignores URL query strings, so each approved
      // content revision is imported from its own immutable staging copy.
      const stage = join(
          store.root,
          "staging",
          "exec-" + plan.digest + "-" + crypto.randomUUID(),
        ),
        copy = join(stage, "module.mjs");
      await noLinks(stage);
      await mkdir(stage, { recursive: true });
      await writeFile(copy, await readFile(plan.target), { flag: "wx" });
      try {
        const module: unknown = await import(pathToFileURL(copy).href);
        if (
          module === null ||
          typeof module !== "object" ||
          !("default" in module) ||
          typeof module.default !== "function"
        )
          fail(
            "Approved JavaScript integration must default-export a function",
          );
        await module.default({
          args: plan.args,
          env: { ...plan.env, PIKO_HOME: store.root },
          root: store.root,
          packageDir: join(store.root, install.dir),
        });
      } catch (error) {
        fail(
          `Approved execution failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
    } else {
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
    }
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
    if (options.admin) state.admin![install.id]!.status = "completed";
    else receipt.status = "completed";
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    const result = options.admin ? state.admin![install.id]! : receipt;
    result.status = "failed";
    result.error = failure;
  }
  await persistExecutionReceipt(store, state, install, !!options.admin);
  if (failure) fail(failure);
  return {
    status: "completed",
    defaultUnchanged: true,
    restartApplications: true,
  };
}

export async function removeAdminIntegrationLocked(
  store: Store,
  state: State,
  install: Install,
) {
  const history = ensureInstallReceipt(state, install).admin;
  if (!history?.install || history.remove?.status === "completed") return;
  return await runExecutionLocked(
    store,
    state,
    `${install.source.alias}/${install.name}@${install.version}`,
    { admin: true, remove: true },
    true,
  );
}

export async function runExecution(
  store: Store,
  spec: string,
  options: ExecutionOptions,
) {
  return await store.mutate(
    (state) => runExecutionLocked(store, state, spec, options),
    { skipUnchanged: true },
  );
}
