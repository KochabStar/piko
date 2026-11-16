import { join } from "node:path";
import { inspectExecution, runExecution } from "./execution.ts";
import { installedForIntegration } from "./desktop.ts";
import { WindowsEffects } from "./windows-effects.ts";
import { atomicJson, fail, sha256 } from "./util.ts";
import type { Packages } from "./packages.ts";

export async function inspectSystemUpgrade(packages: Packages, spec: string) {
  const state = await packages.store.read();
  const target = installedForIntegration(state, spec);
  const selection = state.defaults[target.key];
  const previous = selection && state.installs[selection.id];
  if (!previous || previous.id === target.id)
    fail(
      "Install the candidate first and specify its exact version; an older default must be selected",
    );
  const active = state.admin?.[previous.id];
  if (active?.action === "install" && active.status !== "completed")
    fail(
      "Previous system action is running/failed; inspect and reconcile it explicitly before upgrade",
    );
  if (
    state.admin?.[target.id]?.action === "install" &&
    state.admin[target.id]?.status !== "completed"
  )
    fail(
      "Target system installation failed or was interrupted; preview and retry piko system <target-exact-version> before upgrading",
    );
  const oldSpec =
    previous.source.alias + "/" + previous.name + "@" + previous.version;
  const targetReady = state.admin?.[target.id]?.action === "install" &&
    state.admin[target.id]?.status === "completed";
  const remove =
    !targetReady && (active?.action === "install" ||
      (previous.admin?.required && active?.action !== "remove"))
      ? await inspectExecution(packages.store, oldSpec, true, true)
      : null;
  const install = await inspectExecution(packages.store, spec, true);
  const data = {
    revision: state.revision,
    oldSpec,
    spec,
    previous: previous.id,
    target: target.id,
    targetReady,
    request: selection.request,
    remove,
    install,
  };
  return {
    ...data,
    binding: sha256(JSON.stringify(data)),
    warning:
      "One approval covers the displayed old removal and new installation. Run from an elevated terminal. Steps are journaled, not transactional; interrupted/failed scripts are never replayed by recover. The candidate is selected only after its system installation succeeds, preserving the saved version request. Old program files/data are retained.",
  };
}

export async function applySystemUpgrade(
  packages: Packages,
  spec: string,
  binding: string,
) {
  const plan = await inspectSystemUpgrade(packages, spec);
  if (!binding || binding !== plan.binding)
    fail(
      "System upgrade changed; preview again and approve the combined --binding",
    );
  if (!(await (packages.effectsBackend ?? new WindowsEffects()).elevated()))
    fail("System upgrade requires an explicitly elevated terminal");
  const journal = join(
    packages.root,
    "apps/piko/system-upgrades",
    plan.binding + ".json",
  );
  let phase = "approved";
  await atomicJson(journal, { ...plan, phase });
  try {
    if (plan.remove) {
      phase = "removing-old";
      await atomicJson(journal, { ...plan, phase });
      await runExecution(packages.store, plan.oldSpec, {
        confirmed: true,
        binding: plan.remove.binding,
        admin: true,
        remove: true,
      });
    }
    const current = await packages.store.read();
    if (
      current.defaults[current.installs[plan.target]!.key]?.id !== plan.previous
    )
      fail(
        "Default changed during system upgrade; inspect the journal before continuing",
      );
    // Content must still match both the composite preview and the new execution plan.
    const candidate = await inspectExecution(packages.store, spec, true);
    if (
      candidate.contentHash !== plan.install.contentHash ||
      JSON.stringify([candidate.args, candidate.env]) !==
        JSON.stringify([plan.install.args, plan.install.env])
    )
      fail("Candidate system code changed after approval");
    if (!plan.targetReady) {
      phase = "installing-new";
      await atomicJson(journal, { ...plan, phase });
      await runExecution(packages.store, spec, {
        confirmed: true,
        binding: candidate.binding,
        admin: true,
      });
    }
    const ready = await packages.store.read();
    const selection = ready.defaults[ready.installs[plan.target]!.key];
    if (selection?.id !== plan.previous || selection.request !== plan.request)
      fail("Default changed during system installation; inspect the journal before selecting the candidate");
    if (ready.admin?.[plan.target]?.action !== "install" ||
        ready.admin[plan.target]?.status !== "completed")
      fail("Candidate system integration is not ready for selection");
    phase = "selecting-new";
    await atomicJson(journal, { ...plan, phase });
    await packages.use(spec, {
      expectedRevision: ready.revision,
      retainRequest: true,
    });
    phase = "completed";
    await atomicJson(journal, { ...plan, phase });
    return { status: phase, journal };
  } catch (error) {
    await atomicJson(journal, {
      ...plan,
      phase,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
