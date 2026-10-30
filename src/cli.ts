import {
  prepareSelfUpdate,
  prepareRollback,
  applySelfUpdate,
  selfUpdateStatus,
  launchSelfUpdater,
} from "./self-update.ts";
import { VERSION } from "./version.ts";
import { createInterface } from "node:readline/promises";
import { resolveCommand, commandNames } from "./commands.ts";
import { basename, dirname, join, resolve } from "node:path";
import {
  copyFile,
  mkdir,
  stat,
  rm,
  readFile,
  writeFile,
} from "node:fs/promises";
import { parseArgs } from "node:util";
import { parseSpec } from "./catalog.ts";
import { Store } from "./store.ts";
import { orphanPlan, quarantineOrphans } from "./maintenance.ts";
import { cleanCache, cachePlan } from "./cache.ts";
import {
  home,
  dispatch,
  ensureShim,
  addUserPath,
  pathDiagnostics,
  powershellExecutable,
} from "./windows.ts";
import { noLinks, fail, exists, json, capture } from "./util.ts";

const help = `Piko ${VERSION} — Windows package manager (preview)

  piko self update <file|https-url> --sha256 <hash> --yes
  piko self status | rollback --yes | recover [--force]
  piko setup [--path]                 Install this executable; --path updates user PATH
  piko source add <alias> <url> [--type http|git] [--ref <ref>]
  piko source list | refresh [alias] | remove <alias> [--force]
  piko info <package>                 Versions, provenance and candidate dependency checks
  piko search <query>
  piko install <source/package>[@version] [--skip-checksum]   (alias: i)
  piko install <spec> --with-deps --dry-run | --yes --binding <hash>
  piko use <package>[@version] [--no-commands] | unuse <package>
  piko command list | claim <command> <package> | release <command>
  piko command alias <name> <package> <provided-command> | unalias <name>
  piko cleanup <package> --data [--dry-run | --yes]
  piko persist <package> --fresh --dry-run | --yes --binding <hash>
  piko persist <package> --remove --dry-run | --yes --binding <hash>
  piko persist --recover
  piko integrate <package> --shell powershell|pwsh [--profile <path>] --dry-run
  piko integrate <package> --shell powershell|pwsh --approve-shell --binding <hash>
  piko unintegrate <package> --shell powershell|pwsh [--dry-run | --yes] [--binding <hash>]
  piko shell init --shell powershell|bash --profile <path>
  piko shell env --shell powershell|pwsh|cmd|bash|json
  piko integrate <package> --desktop [--dry-run | --yes --binding <hash>]
  piko unintegrate <package> --desktop [--dry-run | --yes --binding <hash>]
  piko bootstrap <package> [--dry-run | --approve-exec --binding <hash>]
  piko system <package> [--remove] [--dry-run | --approve-admin --binding <hash>]
  piko system <package>@<installed-version> --upgrade --dry-run | --approve-admin --binding <hash>
  piko rust list
  piko rust install|use|update|remove <toolchain> --dry-run | --approve-exec --binding <hash>
  piko list
  piko outdated [package] | status [package]
  piko update <package> | update --all [--dry-run]
  piko cleanup [package] --versions [--keep N] [--dry-run | --yes]
  piko export [file.json] [--lock]
  piko import <file.json> [--dry-run | --yes] [--binding <hash>]
  Runtime selection: install/use/info <source>/<family>@<request> --distribution <vendor>
  piko maintenance orphans | quarantine [--dry-run | --yes]
  piko maintenance layout --dry-run | --yes --binding <hash> | --recover
  piko cache list | clean [--dry-run | --yes]
  piko uninstall <package>@<exact-version> [--force]
  piko which <command>
  piko scripts list <npm:package>@<exact-version>
  piko scripts approve <spec> [--package-path node_modules/name] [--binding hash] [--yes]
  piko scripts revoke <spec> [--package-path node_modules/name]
  piko scripts rebuild <spec>         Rebuild a copy with only content-bound approvals
  piko recover [--force]              Recover journals; --force removes only a dead owner's lock
  piko doctor

PIKO_HOME overrides the user installation root.
Install does not select a default. current is a junction, not a copy.
Portable dependencies are checked before install; install/select them explicitly.
Install and update never execute lifecycle scripts. Explicit approvals and rebuild are required.
Approved scripts run with user permissions; this is NOT a security sandbox.
`;
async function main(): Promise<number> {
  if (process.platform !== "win32") fail("This release only supports Windows");
  const root = home(),
    store = new Store(root);
  const rawArgs = process.argv.slice(2);
  const nativeDispatch = rawArgs[0] === "__shim";
  const launched = nativeDispatch
    ? rawArgs[1]
    : basename(process.execPath)
        .replace(/\.exe$/i, "")
        .toLowerCase();
  if (
    nativeDispatch ||
    (basename(dirname(process.execPath)).toLowerCase() === "shims" &&
      launched !== "piko")
  ) {
    if (
      typeof launched !== "string" ||
      !/^[a-z0-9][a-z0-9._+-]{0,79}$/.test(launched) ||
      launched === "piko"
    )
      fail("Invalid native shim command");
    if (
      (await exists(join(root, "operations", "persist.json"))) ||
      (await exists(join(root, "operations", "layout.json"))) ||
      (await exists(join(root, "operations", "self-update.json"))) ||
      (await exists(store.installPath)) ||
      (await exists(store.journalPath)) ||
      (await exists(store.removalPath)) ||
      (await exists(store.dataRemovalPath)) ||
      (await exists(store.rebuildPath)) ||
      (await exists(join(root, "operations", "profile.json"))) ||
      (await exists(join(root, "operations", "desktop.json")))
    )
      fail("Interrupted state change; run piko doctor before launching tools");
    return await dispatch(
      root,
      await store.read(),
      launched,
      nativeDispatch ? rawArgs.slice(2) : rawArgs,
    );
  }
  const { positionals: args, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      force: { type: "boolean" },
      recover: { type: "boolean" },
      path: { type: "boolean" },
      type: { type: "string" },
      ref: { type: "string" },
      "skip-checksum": { type: "boolean" },
      "no-commands": { type: "boolean" },
      "with-deps": { type: "boolean" },
      lock: { type: "boolean" },
      data: { type: "boolean" },
      fresh: { type: "boolean" },
      versions: { type: "boolean" },
      keep: { type: "string" },
      desktop: { type: "boolean" },
      "approve-exec": { type: "boolean" },
      "approve-admin": { type: "boolean" },
      remove: { type: "boolean" },
      upgrade: { type: "boolean" },
      shell: { type: "string" },
      profile: { type: "string" },
      "approve-shell": { type: "boolean" },
      distribution: { type: "string" },
      "dry-run": { type: "boolean" },
      "package-path": { type: "string" },
      binding: { type: "string" },
      sha256: { type: "string" },
      all: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
    },
  });
  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  if (values.help || !args.length) {
    console.log(help);
    return 0;
  }
  // Package install/archive code is unnecessary for hot shim dispatch and --version.
  const { Packages } = await import("./packages.ts");
  const packages = new Packages(root);
  const required = (index: number) =>
    args[index] ?? fail(`Missing argument; run piko --help`);
  switch (args[0]) {
    case "self": {
      switch (required(1)) {
        case "check":
          await packages.store.read();
          console.log(
            JSON.stringify({
              protocol: 1,
              version: VERSION,
              shimProtocol: 1,
              dataProfiles: 1,
              startMenu: 1,
            }),
          );
          break;
        case "status":
          console.log(JSON.stringify(await selfUpdateStatus(root), null, 2));
          break;
        case "apply":
          await applySelfUpdate(root);
          console.log("Piko upgraded; state preserved");
          break;
        case "recover":
          await applySelfUpdate(root, false, !!values.force, !!values.force);
          console.log("Piko self-update recovery completed");
          break;
        case "rollback": {
          if (!values.yes)
            fail(
              "Rollback requires --yes and must remain compatible with current state",
            );
          const plan = await prepareRollback(root, process.pid),
            log = await launchSelfUpdater(root, plan.candidate);
          console.log(
            JSON.stringify({ ...plan, log, status: "pending" }, null, 2),
          );
          break;
        }
        case "update": {
          if (!values.yes)
            fail(
              "Self-update executes a trusted candidate; explicit --yes and --sha256 are required",
            );
          const planned = await prepareSelfUpdate(
            root,
            required(2),
            values.sha256 ?? fail("Self-update requires --sha256"),
            process.pid,
          );
          const log = await launchSelfUpdater(root, planned.candidate);
          console.log(
            JSON.stringify(
              {
                ...planned,
                log,
                status: "pending",
                message:
                  "Updater will replace Piko after this process exits. Check piko self status; use staged candidate self recover if interrupted.",
              },
              null,
              2,
            ),
          );
          break;
        }
        default:
          fail(
            "Use self update <file|https-url> --sha256 <hash> --yes, status or recover [--force]",
          );
      }
      break;
    }
    case "setup": {
      if (basename(process.execPath).toLowerCase() !== "piko.exe")
        fail(
          "Build and run dist/piko.exe setup; source mode cannot install an executable",
        );
      const target = join(root, "apps", "piko", "piko.exe");
      await noLinks(dirname(target));
      await mkdir(dirname(target), { recursive: true });
      if (
        resolve(process.execPath).toLowerCase() !==
        resolve(target).toLowerCase()
      ) {
        if (await exists(target)) {
          const [a, b] = await Promise.all([
            stat(process.execPath),
            stat(target),
          ]);
          if (a.ino !== b.ino || a.dev !== b.dev)
            fail(
              "Piko is already installed; use self update with a trusted checksum instead",
            );
        } else await copyFile(process.execPath, target);
      }
      await packages.store.mutate(async () => {});
      await ensureShim(root, "piko");
      if (values.path) await addUserPath(root);
      console.log(
        `Installed: ${target}\n${values.path ? "User PATH updated. Restart existing terminals and IDEs." : "Add this directory to user PATH: " + join(root, "shims")}`,
      );
      break;
    }
    case "source": {
      switch (required(1)) {
        case "add": {
          const type =
            values.type ?? (required(3).endsWith(".git") ? "git" : "http");
          if (type !== "git" && type !== "http")
            fail("Source type must be http or git");
          await packages.addSource(required(2), required(3), type, values.ref);
          console.log("Source added");
          break;
        }
        case "list":
          console.log(
            JSON.stringify(
              Object.values((await packages.store.read()).sources),
              null,
              2,
            ),
          );
          break;
        case "refresh":
          await packages.refreshSources(args[2]);
          console.log("Sources refreshed");
          break;
        case "remove":
          await packages.removeSource(required(2), values.force);
          console.log(
            "Source configuration removed; installed packages retained",
          );
          break;
        default:
          fail("Unknown source command");
      }
      break;
    }
    case "shell": {
      if (args[1] === "env") {
        console.log(
          (await import("./shell-environment.ts")).shellEnvironment(
            root,
            await store.read(),
            values.shell ?? "json",
          ),
        );
        break;
      }
      if (
        required(1) !== "init" ||
        !["powershell", "pwsh", "bash"].includes(values.shell ?? "") ||
        !values.profile
      )
        fail("Use shell init --shell powershell --profile <absolute-path>");
      const { shellInit } = await import("./shell.ts");
      console.log(
        await shellInit(
          store,
          resolve(values.profile),
          values.shell === "bash" ? "bash" : "powershell",
        ),
      );
      break;
    }
    case "rust": {
      const { inspectRust, runRust } = await import("./rust.ts");
      const action = required(1);
      if (values["dry-run"])
        console.log(
          JSON.stringify(await inspectRust(store, action, args[2]), null, 2),
        );
      else {
        if (action !== "list" && !values["approve-exec"])
          fail("Rust changes need --approve-exec and preview --binding");
        console.log(
          JSON.stringify(
            await runRust(store, action, args[2], values.binding),
            null,
            2,
          ),
        );
      }
      break;
    }
    case "bootstrap":
    case "system": {
      if (values.upgrade) {
        if (args[0] !== "system" || values.remove || values.desktop)
          fail("Use system <installed-exact-version> --upgrade");
        const { inspectSystemUpgrade, applySystemUpgrade } =
          await import("./integration-upgrade.ts");
        const plan = await inspectSystemUpgrade(packages, required(1));
        console.log(JSON.stringify(plan, null, 2));
        if (!values["dry-run"]) {
          if (!values["approve-admin"])
            fail(
              "System upgrade needs --approve-admin and the combined --binding",
            );
          console.log(
            JSON.stringify(
              await applySystemUpgrade(
                packages,
                required(1),
                values.binding ?? "",
              ),
              null,
              2,
            ),
          );
        }
        break;
      }
      if (args[0] === "system" && values.desktop)
        fail(
          "System integration and user desktop integration are separate approvals",
        );
      const { inspectExecution, runExecution } = await import("./execution.ts");
      const admin = args[0] === "system",
        spec = required(1),
        remove = !!values.remove;
      if (remove && !admin) fail("--remove is only for system integration");
      const plan = await inspectExecution(store, spec, admin, remove);
      console.log(JSON.stringify(plan, null, 2));
      if (values["dry-run"]) break;
      if (admin ? !values["approve-admin"] : !values["approve-exec"])
        fail(
          admin
            ? "System integration requires --approve-admin and preview --binding"
            : "Bootstrap requires --approve-exec and preview --binding; --yes is insufficient",
        );
      console.log(
        JSON.stringify(
          await runExecution(store, spec, {
            confirmed: true,
            binding: values.binding,
            admin,
            remove,
          }),
          null,
          2,
        ),
      );
      break;
    }
    case "integrate":
    case "unintegrate": {
      if (values.desktop) {
        if (values.shell || values.profile)
          fail("Choose --desktop or --shell, not both");
        const { inspectDesktop, applyDesktop } = await import("./desktop.ts");
        const remove = args[0] === "unintegrate",
          spec = required(1);
        if (values.upgrade) {
          if (remove) fail("Use integrate --desktop --upgrade");
          const { inspectDesktopUpgrade } = await import("./desktop.ts");
          console.log(
            JSON.stringify(await inspectDesktopUpgrade(store, spec), null, 2),
          );
          if (!values["dry-run"]) {
            if (!values.yes)
              fail("Desktop upgrade needs --yes and preview --binding");
            await packages.upgradeDesktop(spec, values.binding ?? "");
          }
          break;
        }
        const plan = await inspectDesktop(store, spec, remove);
        console.log(JSON.stringify(plan, null, 2));
        if (values["dry-run"]) break;
        console.log(
          JSON.stringify(
            await applyDesktop(store, spec, {
              confirmed: !!values.yes,
              binding: values.binding,
              remove,
            }),
            null,
            2,
          ),
        );
        break;
      }
      const shell = values.shell;
      if (shell !== "powershell" && shell !== "pwsh" && shell !== "bash")
        fail(
          "Specify --shell powershell (5.1), pwsh (7), or bash with --profile",
        );
      if (shell === "bash" && !values.profile)
        fail("Bash integration requires an explicit --profile path");
      const { inspectIntegration, integrate } = await import("./shell.ts");
      const profile = values.profile
        ? resolve(values.profile)
        : await capture(
            powershellExecutable(shell === "pwsh" ? "pwsh" : "powershell"),
            [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "$PROFILE.CurrentUserAllHosts",
            ],
          );
      const remove = args[0] === "unintegrate",
        spec = required(1);
      const plan = await inspectIntegration(
        store,
        spec,
        profile,
        remove,
        shell === "bash" ? "bash" : "powershell",
      );
      console.log(JSON.stringify(plan, null, 2));
      if (values["dry-run"]) break;
      if (remove ? !values.yes : !values["approve-shell"])
        fail(
          remove
            ? "Removal requires --yes and preview --binding"
            : "Shell code execution requires --approve-shell and preview --binding; --yes alone is insufficient",
        );
      console.log(
        JSON.stringify(
          await integrate(store, spec, profile, {
            confirmed: true,
            binding: values.binding,
            remove,
            shell: shell === "bash" ? "bash" : "powershell",
          }),
          null,
          2,
        ),
      );
      break;
    }
    case "info":
      console.log(
        JSON.stringify(
          await packages.info(
            await packages.runtimeSpec(required(1), values.distribution),
          ),
          null,
          2,
        ),
      );
      break;
    case "persist": {
      const { planPersist, applyPersist, recoverPersist } =
        await import("./data-profiles.ts");
      if (values.recover) {
        console.log(JSON.stringify(await recoverPersist(store), null, 2));
        break;
      }
      if (!!values.fresh === !!values.remove)
        fail("Choose --fresh (new data, old data archived) or --remove");
      const spec = required(1),
        plan = await planPersist(store, spec, !!values.remove);
      if (values["dry-run"]) {
        console.log(JSON.stringify(plan, null, 2));
        break;
      }
      if (!values.yes || !values.binding)
        fail("Profile redirection needs --dry-run then --yes --binding");
      console.log(
        JSON.stringify(
          await applyPersist(store, spec, values.binding, !!values.remove),
          null,
          2,
        ),
      );
      break;
    }
    case "maintenance": {
      if (args[1] === "layout") {
        const { planLayout, migrateLayout, recoverLayout } =
          await import("./layout-migration.ts");
        if (values.recover) {
          console.log(JSON.stringify(await recoverLayout(root), null, 2));
          break;
        }
        const plan = await planLayout(root);
        if (values["dry-run"]) {
          console.log(JSON.stringify(plan, null, 2));
          break;
        }
        if (!values.yes || !values.binding)
          fail(
            "Directory migration requires --dry-run then --yes --binding <hash>",
          );
        console.log(
          JSON.stringify(await migrateLayout(root, values.binding), null, 2),
        );
        break;
      }
      if (!["orphans", "quarantine"].includes(required(1)))
        fail(
          "Use maintenance orphans or maintenance quarantine --dry-run/--yes",
        );
      if (args[1] === "quarantine" && !values["dry-run"] && !values.yes)
        fail("Orphan quarantine requires --yes after inspecting --dry-run");
      const result =
        args[1] === "orphans"
          ? await orphanPlan(root, await packages.store.read())
          : await packages.store.mutate((state) =>
              quarantineOrphans(
                root,
                state,
                !values["dry-run"] && !!values.yes,
              ),
            );
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "cache": {
      const action = required(1);
      if (!["list", "clean"].includes(action))
        fail("Use cache list or cache clean [--dry-run | --yes]");
      if (action === "clean" && !values["dry-run"] && !values.yes)
        fail(
          "Cache deletion requires --yes after inspecting cache clean --dry-run",
        );
      const result =
        action === "list"
          ? await cachePlan(root, await packages.store.read())
          : await packages.store.mutate((s) =>
              cleanCache(root, s, !values["dry-run"] && !!values.yes),
            );
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "search":
      console.log(JSON.stringify(await packages.search(required(1)), null, 2));
      break;
    case "i":
    case "install": {
      if (values["with-deps"]) {
        if (values["skip-checksum"])
          fail("Dependency plans require verified manifests and downloads");
        const { planDependencies, installWithDependencies } =
          await import("./dependency-install.ts");
        const spec = await packages.runtimeSpec(
          required(1),
          values.distribution,
        );
        console.log(
          JSON.stringify(
            values["dry-run"] || !values.yes
              ? await planDependencies(packages, spec)
              : await installWithDependencies(
                  packages,
                  spec,
                  values.binding ?? "",
                ),
            null,
            2,
          ),
        );
        break;
      }
      if (values["dry-run"]) fail("Install preview requires --with-deps");
      const i = await packages.install(
        await packages.runtimeSpec(required(1), values.distribution),
        values["skip-checksum"],
      );
      console.log(
        `Installed ${i.source.alias}/${i.name}@${i.version}\nDefault unchanged. Select explicitly with piko use.`,
      );
      break;
    }
    case "use":
      await packages.use(
        await packages.runtimeSpec(required(1), values.distribution),
        { noCommands: values["no-commands"] },
      );
      for (const issue of await pathDiagnostics(
        root,
        await packages.store.read(),
      ))
        if (issue.shadowed)
          console.error(
            `WARNING: ${issue.name} resolves to ${issue.resolved}, not ${issue.expected}. ${issue.advice}`,
          );
      console.log("Default and current updated");
      break;
    case "unuse":
      await packages.unuse(required(1));
      console.log(
        "Default cleared; installed versions and persistent data retained",
      );
      break;
    case "list": {
      const s = await packages.store.read();
      console.log(
        JSON.stringify(
          Object.values(s.installs).map((i) => ({
            package: `${i.source.alias}/${i.name}`,
            version: i.version,
            default: s.defaults[i.key]?.id === i.id,
            request:
              s.defaults[i.key]?.id === i.id
                ? s.defaults[i.key]?.request
                : undefined,
            verified: i.verified,
            path: join(root, i.dir),
          })),
          null,
          2,
        ),
      );
      break;
    }
    case "outdated":
    case "status": {
      const result = await packages.outdated(
        args[1]
          ? await packages.runtimeSpec(args[1], values.distribution)
          : undefined,
      );
      console.log(JSON.stringify(result, null, 2));
      if (result.some((r) => r.status === "blocked")) return 1;
      break;
    }
    case "export": {
      const { exportInventory, exportLockedInventory } =
        await import("./inventory.ts");
      const inventory = values.lock
        ? await exportLockedInventory(packages)
        : exportInventory(await packages.store.read());
      const content = JSON.stringify(inventory, null, 2) + "\n";
      if (args[1]) {
        const path = resolve(args[1]);
        await noLinks(path);
        await writeFile(path, content, { flag: "wx" });
        console.log(`Inventory exported: ${path}`);
      } else console.log(content.trimEnd());
      break;
    }
    case "import": {
      const { planInventory, importInventory } = await import("./inventory.ts");
      const path = resolve(required(1));
      await noLinks(path);
      const info = await stat(path);
      if (!info.isFile() || info.size > 8 * 1024 * 1024)
        fail("Inventory must be a JSON file of at most 8 MiB");
      const value = JSON.parse(await readFile(path, "utf8")),
        plan = await planInventory(packages, value);
      if (values["dry-run"] || !values.yes) {
        console.log(JSON.stringify(plan, null, 2));
        if (!values["dry-run"])
          fail("Inventory restore requires --yes after reviewing --dry-run");
        if (plan.conflicts.length) return 1;
        break;
      }
      console.log(
        JSON.stringify(
          await importInventory(packages, value, {
            confirmed: true,
            binding: values.binding ?? plan.binding,
          }),
          null,
          2,
        ),
      );
      break;
    }
    case "update": {
      if (values.all) {
        if (args[1]) fail("Use update --all without a package");
        const result = await packages.updateAll(!!values["dry-run"]);
        console.log(JSON.stringify(result, null, 2));
        if (result.some((r) => ["failed", "blocked"].includes(r.status)))
          return 1;
        break;
      }
      const spec = await packages.runtimeSpec(required(1), values.distribution);
      if (values["dry-run"]) {
        const result = await packages.outdated(spec);
        console.log(JSON.stringify(result, null, 2));
        if (result.some((r) => r.status === "blocked")) return 1;
        break;
      }
      const i = await packages.update(spec);
      console.log(`Default: ${i.name}@${i.version}`);
      break;
    }
    case "uninstall":
      await packages.uninstall(required(1), values.force);
      console.log("Uninstalled; persistent data retained");
      break;
    case "command": {
      switch (required(1)) {
        case "list": {
          const state = await packages.store.read();
          console.log(
            JSON.stringify(
              commandNames(state)
                .sort()
                .map((name) => {
                  const { install, provided, bin } = resolveCommand(
                    state,
                    name,
                  );
                  return {
                    name,
                    package: `${install.source.alias}/${install.name}`,
                    provided,
                    alias: !!state.aliases?.[name],
                    path: join(root, install.dir, bin.path),
                  };
                }),
              null,
              2,
            ),
          );
          break;
        }
        case "claim":
          await packages.claimCommand(required(2), required(3));
          console.log("Command ownership explicitly transferred");
          break;
        case "release":
          await packages.releaseCommand(required(2));
          console.log("Command released; package default and current retained");
          break;
        case "alias":
          await packages.aliasCommand(required(2), required(3), required(4));
          console.log("Command alias added");
          break;
        case "unalias":
          await packages.removeAlias(required(2));
          console.log("Command alias removed");
          break;
        default:
          fail("Unknown command-management operation");
      }
      break;
    }
    case "cleanup": {
      if (values.versions) {
        if (values.data) fail("Choose --versions or --data, not both");
        if (values.keep !== undefined && !/^\d+$/.test(values.keep))
          fail("--keep must be a nonnegative integer");
        const keep = values.keep === undefined ? 1 : Number(values.keep);
        const plan = await packages.versionCleanupPlan(args[1], keep);
        console.log(
          JSON.stringify(
            {
              keep: plan.keep,
              binding: plan.binding,
              entries: plan.entries.map(
                ({ installation: _installation, ...entry }) => entry,
              ),
            },
            null,
            2,
          ),
        );
        if (values["dry-run"]) break;
        if (!values.yes)
          fail("Version cleanup requires --yes after reviewing --dry-run");
        const result = await packages.cleanupVersions(args[1], keep, {
          confirmed: true,
          binding: values.binding ?? plan.binding,
        });
        console.log(JSON.stringify(result, null, 2));
        if (result.some((r) => r.status === "failed")) return 1;
        break;
      }
      if (values.keep !== undefined) fail("--keep requires --versions");
      if (!values.data)
        fail(
          "Explicit --data is required; this operation permanently deletes recorded persistent directories",
        );
      const spec = required(1),
        preview = await packages.cleanupData(spec, { dryRun: true });
      console.log(
        JSON.stringify(
          { package: spec, paths: preview.paths, dryRun: true },
          null,
          2,
        ),
      );
      if (values["dry-run"]) break;
      if (!values.yes) {
        if (!process.stdin.isTTY || !process.stdout.isTTY)
          fail(
            "Non-interactive data cleanup requires explicit --yes after reviewing --dry-run",
          );
        const prompt = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        try {
          if (
            (await prompt.question(
              "Permanently delete ONLY the directories above? Type DELETE: ",
            )) !== "DELETE"
          )
            fail("Data cleanup cancelled");
        } finally {
          prompt.close();
        }
      }
      await packages.cleanupData(spec, {
        confirmed: true,
        expectedPaths: preview.paths,
      });
      console.log(
        "Recorded persistent directories deleted; untracked files were not touched",
      );
      break;
    }
    case "which": {
      const { install, bin } = resolveCommand(
        await packages.store.read(),
        required(1).toLowerCase(),
      );
      console.log(
        bin.data
          ? await (
              await import("./execution.ts")
            ).persistentExecutable(
              root,
              await packages.store.read(),
              install,
              bin.path,
            )
          : join(root, install.dir, bin.path),
      );
      break;
    }
    case "recover": {
      const lock = join(root, "mutation.lock");
      if (await exists(lock)) {
        const owner = await json(join(lock, "owner.json"));
        if (!values.force)
          fail(
            "Inspect mutation.lock/owner.json, then explicitly use recover --force if its process is no longer running",
          );
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0)
          fail("Invalid lock owner; inspect manually");
        try {
          process.kill(owner.pid, 0);
          fail("Lock owner is still running; refusing to remove the lock");
        } catch (error: any) {
          if (error.code !== "ESRCH") throw error;
        }
        await noLinks(lock);
        await rm(lock, { recursive: true });
      }
      await packages.store.mutate(async () => {});
      console.log("Recovery completed");
      break;
    }
    case "scripts": {
      const action = required(1),
        spec = required(2);
      if (action === "list") {
        const inventory = await packages.scriptInventory(spec);
        const state = await packages.store.read(),
          parsed = parseSpec(spec);
        const install = Object.values(state.installs).find(
          (i) =>
            i.kind === "npm" &&
            i.name === parsed.name &&
            i.version === parsed.request,
        );
        if (install?.npmBuild)
          console.log(
            JSON.stringify(await packages.inspectScripts(spec), null, 2),
          );
        else
          console.log(
            JSON.stringify(
              {
                scripts: inventory,
                warning:
                  "Legacy installation has no verified content snapshot; reinstall before approval.",
              },
              null,
              2,
            ),
          );
      } else if (action === "approve") {
        const plan = await packages.inspectScripts(spec),
          path =
            values["package-path"] ?? "node_modules/" + parseSpec(spec).name;
        const script =
          plan.scripts.find((s) => s.path === path) ??
          fail("No lifecycle script at this exact package path");
        if (values.binding && values.binding !== script.binding)
          fail("Approval binding changed; inspect scripts again");
        console.log(
          JSON.stringify({ warning: plan.warning, ...script }, null, 2),
        );
        if (!values.yes) {
          if (!process.stdin.isTTY || !process.stdout.isTTY)
            fail(
              "Script approval requires explicit --yes in non-interactive mode",
            );
          const prompt = createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          try {
            if (
              (await prompt.question(
                "Allow this exact package content to execute with your user permissions? Type APPROVE: ",
              )) !== "APPROVE"
            )
              fail("Script approval cancelled");
          } finally {
            prompt.close();
          }
        }
        await packages.approveScripts(spec, path, script.binding);
        console.log(
          "Content-bound approval recorded; no scripts executed. Run scripts rebuild explicitly.",
        );
      } else if (action === "revoke") {
        await packages.revokeScripts(
          spec,
          values["package-path"] ?? "node_modules/" + parseSpec(spec).name,
        );
        console.log(
          "Approval revoked. Existing generated files and external effects are not undone.",
        );
      } else if (action === "rebuild") {
        console.error(
          "WARNING: Approved scripts run with user permissions, not in a sandbox. External effects cannot be rolled back.",
        );
        await packages.rebuildScripts(spec);
        console.log(
          "Approved scripts completed and rebuilt installation committed; defaults unchanged.",
        );
      } else
        fail("Unknown scripts operation; use list, approve, revoke or rebuild");
      break;
    }
    case "doctor": {
      await packages.store.mutate(async () => {}, { skipUnchanged: true });
      const s = await packages.store.read();
      const { shellDiagnostics } = await import("./shell.ts");
      console.log(
        JSON.stringify(
          {
            root,
            state: packages.store.statePath,
            revision: s.revision,
            bun: Bun.version,
            platform: process.platform,
            arch: process.arch,
            orphans: await orphanPlan(root, s),
            pathDiagnostics: await pathDiagnostics(root, s),
            installs: Object.keys(s.installs).length,
            shellIntegrations: await shellDiagnostics(store),
            dataProfiles: await (
              await import("./data-profiles.ts")
            ).dataProfileStatus(store),
            desktopIntegrations: s.desktop ?? {},
            executions: {
              bootstraps: s.bootstraps ?? {},
              system: s.admin ?? {},
            },
            limits: [
              "npm install/update scripts disabled; rebuild requires content-bound approval and npm 11.20.0",
              "Approved scripts are not sandboxed; external effects cannot be rolled back",
              "No automatic stale-lock removal",
              "Self-update requires an explicitly trusted checksum; executables are unsigned",
              "Windows 10 and full interactive agent workflows are not independently certified",
            ],
          },
          null,
          2,
        ),
      );
      break;
    }
    default:
      fail(`Unknown command ${args[0]}; run piko --help`);
  }
  return 0;
}
try {
  process.exitCode = await main();
} catch (error) {
  console.error(
    `piko: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
