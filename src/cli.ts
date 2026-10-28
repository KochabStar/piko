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
import { copyFile, mkdir, stat, rm } from "node:fs/promises";
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
} from "./windows.ts";
import { noLinks, fail, exists, json } from "./util.ts";

const help = `Piko ${VERSION} — Windows package manager (preview)

  piko self update <file|https-url> --sha256 <hash> --yes
  piko self status | rollback --yes | recover [--force]
  piko setup [--path]                 Install this executable; --path updates user PATH
  piko source add <alias> <url> [--type http|git] [--ref <ref>]
  piko source list | refresh [alias] | remove <alias> [--force]
  piko info <package>                 Available and installed versions, provenance and commands
  piko search <query>
  piko install <source/package>[@version] [--skip-checksum]   (alias: i)
  piko use <package>[@version] [--no-commands] | unuse <package>
  piko command list | claim <command> <package> | release <command>
  piko command alias <name> <package> <provided-command> | unalias <name>
  piko cleanup <package> --data [--dry-run | --yes]
  piko list
  piko update <package> | update --all [--dry-run]
  piko maintenance orphans | quarantine [--dry-run | --yes]
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
Install and update never execute lifecycle scripts. Explicit approvals and rebuild are required.
Approved scripts run with user permissions; this is NOT a security sandbox.
`;
async function main(): Promise<number> {
  if (process.platform !== "win32") fail("This release only supports Windows");
  const root = home(),
    store = new Store(root);
  const launched = basename(process.execPath)
    .replace(/\.exe$/i, "")
    .toLowerCase();
  if (
    basename(dirname(process.execPath)).toLowerCase() === "shims" &&
    launched !== "piko"
  ) {
    if (
      (await exists(join(root, "operations", "self-update.json"))) ||
      (await exists(store.installPath)) ||
      (await exists(store.journalPath)) ||
      (await exists(store.removalPath)) ||
      (await exists(store.dataRemovalPath)) ||
      (await exists(store.rebuildPath))
    )
      fail("Interrupted state change; run piko doctor before launching tools");
    return await dispatch(
      root,
      await store.read(),
      launched,
      process.argv.slice(2),
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
      path: { type: "boolean" },
      type: { type: "string" },
      ref: { type: "string" },
      "skip-checksum": { type: "boolean" },
      "no-commands": { type: "boolean" },
      data: { type: "boolean" },
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
          console.log(JSON.stringify({ protocol: 1, version: VERSION }));
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
    case "info":
      console.log(JSON.stringify(await packages.info(required(1)), null, 2));
      break;
    case "maintenance": {
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
      const i = await packages.install(required(1), values["skip-checksum"]);
      console.log(
        `Installed ${i.source.alias}/${i.name}@${i.version}\nDefault unchanged. Select explicitly with piko use.`,
      );
      break;
    }
    case "use":
      await packages.use(required(1), { noCommands: values["no-commands"] });
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
    case "update": {
      if (values.all) {
        if (args[1]) fail("Use update --all without a package");
        const result = await packages.updateAll(!!values["dry-run"]);
        console.log(JSON.stringify(result, null, 2));
        if (result.some((r) => r.status === "failed")) return 1;
        break;
      }
      const i = await packages.update(required(1));
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
      console.log(join(root, install.dir, bin.path));
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
      await packages.store.mutate(async () => {});
      const s = await packages.store.read();
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
