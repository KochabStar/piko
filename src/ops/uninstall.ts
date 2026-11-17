import semver from "semver";
import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { installationUsers } from "../installation-users.ts";
import { protectDependencies } from "../dependencies.ts";
import { assertNoDataProfile } from "../data-profiles.ts";
import {
  checkPersistentFileMappings,
  checkPersistentLinkMappings,
} from "../persistence.ts";
import {
  preflightInstallReceiptRemoval,
  revokeInstallReceipt,
} from "../receipt.ts";
import {
  bindOperation,
  checkpoint,
  runOperation,
  trackOperationMove,
} from "../journal.ts";
import { upgradeState } from "../store.ts";
import { atomicJson, fail, json, noLinks } from "../util.ts";
import { clearCommands, installed } from "./shared.ts";
import type { Install } from "../types.ts";
import type { PackagesContext } from "./context.ts";

export async function uninstallPackage(
  ops: PackagesContext,
  spec: string,
  force = false,
  expected?: Install,
): Promise<void> {
  await runOperation(ops.store, "uninstall", spec, { force }, async () => {
    await checkpoint(ops.store, "uninstall-state", async () => {
      await ops.store.mutate(
        async (state) => {
          upgradeState(state);
          const match = installed(state, spec);
          const installation =
            match.request === undefined
              ? match.installs.length === 1
                ? match.installs[0]
                : (match.installs.find(
                    (entry) => entry.id === state.defaults[match.key]?.id,
                  ) ??
                  fail(
                    "Multiple versions are installed with no selected default; specify <package>@<exact-version>",
                  ))
              : match.installs.find((entry) => entry.version === match.request);
          if (!installation) fail("Exact installed version not found");
          if (
            expected &&
            JSON.stringify(expected) !== JSON.stringify(installation)
          )
            fail("Installation changed since cleanup preview");
          if (
            !Object.values(state.installs).some(
              (entry) =>
                entry.key === installation.key && entry.id !== installation.id,
            )
          )
            await assertNoDataProfile(ops.root, installation.key);
          if (state.bootstraps?.[installation.id]?.status === "running")
            fail(
              "Bootstrap may be interrupted or running; explicitly retry/inspect it before uninstall",
            );

          // Plan selection and dependency changes without publishing them through an admin checkpoint.
          const planned = structuredClone(state);
          if (state.defaults[match.key]?.id === installation.id) {
            if (!force && match.request !== undefined)
              fail(
                "Cannot uninstall the default version; switch or unuse it first, or explicitly use --force",
              );
            const next = Object.values(state.installs)
              .filter(
                (entry) =>
                  entry.key === installation.key &&
                  entry.id !== installation.id &&
                  (!entry.admin?.required ||
                    (state.admin?.[entry.id]?.action === "install" &&
                      state.admin[entry.id]?.status === "completed")),
              )
              .sort((a, b) =>
                semver.valid(a.version) && semver.valid(b.version)
                  ? semver.rcompare(a.version, b.version)
                  : b.version.localeCompare(a.version, undefined, {
                      numeric: true,
                    }),
              )[0];
            if (next)
              planned.defaults[match.key] = {
                id: next.id,
                request: next.version,
              };
            else delete planned.defaults[match.key];
            clearCommands(planned, match.key);
          }
          delete planned.installs[installation.id];
          delete planned.receipts?.[installation.id];
          delete planned.bootstraps?.[installation.id];
          delete planned.admin?.[installation.id];
          await protectDependencies(ops.root, state, planned);

          const from = join(ops.root, installation.dir);
          const trash = `uninstall-${crypto.randomUUID()}`;
          const to = join(ops.root, "staging", trash);
          await noLinks(from);
          const receiptPath = join(from, ".piko-install.json");
          await noLinks(receiptPath);
          if (
            JSON.stringify(await json(receiptPath)) !==
            JSON.stringify(installation)
          )
            fail("Installation receipt changed since cleanup preview");
          await noLinks(dirname(to));
          await checkPersistentFileMappings(ops.root, installation);
          await checkPersistentLinkMappings(ops.root, installation, {
            reconcile: false,
          });
          await preflightInstallReceiptRemoval(ops.store, state, installation);
          await bindOperation(ops.store, {
            kind: "uninstall",
            spec:
              installation.kind === "npm"
                ? `npm:${installation.name}@${installation.version}`
                : `${installation.source.alias}/${installation.name}@${installation.version}`,
            packageId: installation.id,
            installation,
            force,
          });
          const admin = state.receipts?.[installation.id]?.admin;
          const approved =
            admin?.install ??
            (state.admin?.[installation.id]?.action === "install"
              ? state.admin[installation.id]
              : undefined);
          const removed =
            admin?.remove?.status === "completed" ||
            (state.admin?.[installation.id]?.action === "remove" &&
              state.admin[installation.id]?.status === "completed");
          await checkpoint(
            ops.store,
            approved && !removed ? "uninstall-admin" : "uninstall-receipt",
            () => revokeInstallReceipt(ops.store, state, installation),
          );
          // A managed service may hold the payload open: stop/revoke it before checking users.
          const users = await installationUsers(
            ops.root,
            installation,
            ops.effectsBackend,
          );
          if (users.length)
            fail(
              "Installation is in use by loaded DLLs/processes; keep this version and retry cleanup after sign-out/restart: " +
                users.map((entry) => `${entry.name} (${entry.pid})`).join(", "),
            );
          await checkPersistentFileMappings(ops.root, installation);
          await checkPersistentLinkMappings(ops.root, installation);
          await checkpoint(ops.store, "uninstall-move", async () => {
            await mkdir(dirname(to), { recursive: true });
            await trackOperationMove(ops.store, from, to);
            await atomicJson(ops.store.removalPath, { installation, trash });
            await rename(from, to);
          });
          if (planned.defaults[match.key])
            state.defaults[match.key] = planned.defaults[match.key]!;
          else delete state.defaults[match.key];
          state.commands = planned.commands;
          state.aliases = planned.aliases;
          delete state.installs[installation.id];
          delete state.receipts?.[installation.id];
        },
        { effectsBackend: ops.effectsBackend },
      );
    });
    await ops.store.recoverRemoval();
  });
}
