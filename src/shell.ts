import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chooseVersion, parseSpec } from "./catalog.ts";
import { resolveCommand } from "./commands.ts";
import { dependencyAliases } from "./dependencies.ts";
import { packageKey } from "./store.ts";
import { exists, fail, json, noLinks, sha256 } from "./util.ts";
import { checkPersistentFileMappings } from "./persistence.ts";
import {
  editProfile,
  profileBytes,
  profileEol,
  profileJournal,
  profileKey,
  profileMarkers,
  psQuote,
  stageProfileChange,
} from "./profiles.ts";
import type { Store } from "./store.ts";
import type { Install, ProfileIntegration, State } from "./types.ts";

export async function contentHash(
  root: string,
  install: Install,
): Promise<string> {
  if (!install.verified || install.kind !== "portable")
    fail(
      "Shell integration requires a checksum-verified portable installation",
    );
  const base = join(root, install.dir);
  await checkPersistentFileMappings(root, install);
  await noLinks(join(base, ".piko-install.json"));
  if (
    JSON.stringify(await json(join(base, ".piko-install.json"))) !==
    JSON.stringify(install)
  )
    fail("Shell installation receipt drift");
  const hash = createHash("sha256");
  let count = 0;
  const walk = async (dir: string, prefix = ""): Promise<void> => {
    await noLinks(dir);
    for (const name of (await readdir(dir)).sort()) {
      const path = prefix ? prefix + "/" + name : name;
      if (
        path === ".piko-install.json" ||
        install.persist.some((p) => path.toLowerCase() === p.toLowerCase())
      )
        continue;
      if (++count > 100000) fail("Shell content entry limit exceeded");
      const full = join(dir, name),
        info = await lstat(full);
      if (
        info.isSymbolicLink() ||
        (!info.isDirectory() && !info.isFile()) ||
        (info.isFile() && info.nlink !== 1)
      )
        fail("Linked or special Shell initialization content");
      hash.update(
        JSON.stringify([path, info.isDirectory() ? "directory" : "file"]),
      );
      if (info.isDirectory()) await walk(full, path);
      else {
        const fileHash = createHash("sha256");
        for await (const chunk of createReadStream(full))
          fileHash.update(chunk);
        hash.update(fileHash.digest("hex"));
      }
    }
  };
  await walk(base);
  return hash.digest("hex");
}

const bashQuote = (value: string) =>
  "'" + value.replaceAll("'", "'\"'\"'") + "'";
const bashPath = (value: string) => value.replaceAll("\\", "/");

async function shellContent(
  root: string,
  state: State,
  install: Install,
  shell: "powershell" | "bash" = "powershell",
) {
  const script = install.shell?.[shell];
  if (!script) fail("Package does not declare " + shell + " initialization");
  const dependencies: Record<string, string> = {},
    identities: unknown[] = [];
  for (const dependency of install.depends ?? []) {
    const parsed = parseSpec(dependency.package),
      source = parsed.source ? state.sources[parsed.source] : install.source;
    if (!source) fail("Shell dependency source is not configured");
    const key = packageKey(source, parsed.name),
      selection = state.defaults[key],
      provider = selection && state.installs[selection.id];
    if (!provider)
      fail(`Select managed Shell dependency ${dependency.package}`);
    if (parsed.request && parsed.request !== "latest") {
      const aliases =
        parsed.request !== provider.version &&
        !/^\d+(?:\.\d+)?$/.test(parsed.request)
          ? await dependencyAliases(root, source, parsed.name, false)
          : undefined;
      chooseVersion([provider.version], parsed.request, undefined, aliases);
    }
    const digest = await contentHash(root, provider);
    for (const command of dependency.commands ?? []) {
      const resolved = resolveCommand(state, command);
      if (resolved.install.id !== provider.id || resolved.bin.kind !== "native")
        fail(
          `Shell dependency command ${command} must belong to its selected native provider`,
        );
      const target = join(root, provider.dir, resolved.bin.path);
      await noLinks(target);
      if (!(await lstat(target)).isFile())
        fail("Shell dependency command missing");
      if (Object.hasOwn(dependencies, command))
        fail("Ambiguous Shell dependency command");
      dependencies[command] = target;
    }
    identities.push([source.identity, provider.id, digest]);
  }
  const digest = await contentHash(root, install);
  const binding = sha256(
    JSON.stringify([
      install.source.identity,
      install.shell,
      digest,
      identities,
      ...(shell === "bash" ? ["bash"] : []),
    ]),
  );
  return {
    binding,
    dependencies,
    contentHash: digest,
    script,
  };
}

function findInstallation(state: State, spec: string) {
  const parsed = parseSpec(spec),
    matches = Object.values(state.installs).filter(
      (i) =>
        i.name === parsed.name &&
        (!parsed.source || i.source.alias === parsed.source),
    );
  if (new Set(matches.map((i) => i.key)).size > 1)
    fail("Ambiguous package; specify source/package");
  const selected = matches.find((i) => state.defaults[i.key]?.id === i.id);
  const install = parsed.request
    ? matches.find((i) => i.version === parsed.request)
    : (selected ?? (matches.length === 1 ? matches[0] : undefined));
  return (
    install ??
    fail("Specify an installed exact version or select a default first")
  );
}

async function integrationPlan(
  root: string,
  state: State,
  spec: string,
  path: string,
  remove: boolean,
  shell: "powershell" | "bash" = "powershell",
) {
  path = resolve(path);
  const id = profileKey(path),
    previous = state.profiles?.[id],
    bytes = await profileBytes(path);
  if (previous && previous.path !== path) fail("Profile path identity changed");
  if (previous && (previous.shell ?? "powershell") !== shell)
    fail("Profile is managed for a different Shell");
  const install = findInstallation(state, spec),
    approvals = structuredClone(previous?.approvals ?? {});
  let content: Awaited<ReturnType<typeof shellContent>> | undefined;
  if (remove) {
    if (!approvals[install.key])
      fail("Package is not integrated into this Profile");
    delete approvals[install.key];
  } else {
    content = await shellContent(root, state, install, shell);
    approvals[install.key] = { binding: content.binding };
  }
  const exe = join(root, "apps", "piko", "piko.exe");
  await noLinks(exe);
  if (!remove && !(await exists(exe)))
    fail("Run the compiled piko.exe setup before Profile integration");
  if (shell === "bash" && bytes?.[0] === 255 && bytes?.[1] === 254)
    fail("Bash Profile must be UTF-8, not UTF-16LE");
  const eol = shell === "bash" ? "\n" : profileEol(bytes),
    markers = profileMarkers(root),
    block =
      previous?.block ??
      (shell === "bash"
        ? [
            markers.start,
            "if _piko_init=$(PIKO_HOME=" +
              bashQuote(bashPath(resolve(root))) +
              " " +
              bashQuote(bashPath(exe)) +
              " shell init --shell bash --profile " +
              bashQuote(bashPath(path)) +
              "); then",
            '  eval "$_piko_init"',
            "else printf '%s\\n' 'Piko initialization unavailable; run piko doctor.' >&2; fi",
            "unset _piko_init",
            markers.end,
          ].join(eol)
        : [
            markers.start,
            `if (Test-Path -LiteralPath ${psQuote(exe)}) {`,
            `  try {`,
            `    $pikoOldHome = $env:PIKO_HOME`,
            `    $pikoOldEncoding = [Console]::OutputEncoding`,
            `    try {`,
            `      [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)`,
            `      $env:PIKO_HOME = ${psQuote(resolve(root))}`,
            `      $pikoInit = & ${psQuote(exe)} shell init --shell powershell --profile ${psQuote(path)}`,
            "      if ($LASTEXITCODE -eq 0) { Invoke-Expression ($pikoInit -join \"`n\") } else { Write-Warning 'Piko Shell initialization unavailable; run piko doctor.' }",
            `    } finally { $env:PIKO_HOME = $pikoOldHome; [Console]::OutputEncoding = $pikoOldEncoding }`,
            `  } catch { Write-Warning ('Piko Shell initialization: ' + $_.Exception.Message) }`,
            `}`,
            markers.end,
          ].join(eol)),
    profile: ProfileIntegration | null = Object.keys(approvals).length
      ? { path, block, approvals, ...(shell === "bash" ? { shell } : {}) }
      : null,
    after = editProfile(root, bytes, previous?.block, profile?.block);
  const binding = sha256(
    JSON.stringify([
      state.revision,
      spec,
      path,
      remove,
      bytes?.toString("base64") ?? null,
      profile,
    ]),
  );
  return { id, install, profile, bytes, after, binding, content };
}

export async function inspectIntegration(
  store: Store,
  spec: string,
  path: string,
  remove = false,
  shell: "powershell" | "bash" = "powershell",
) {
  const plan = await integrationPlan(
    store.root,
    await store.read(),
    spec,
    path,
    remove,
    shell,
  );
  return {
    package: `${plan.install.source.alias}/${plan.install.name}@${plan.install.version}`,
    profile: resolve(path),
    action: remove ? "remove" : "enable",
    binding: plan.binding,
    selected:
      (await store.read()).defaults[plan.install.key]?.id === plan.install.id,
    initializer: plan.content?.script,
    dependencies: plan.content?.dependencies,
    contentHash: plan.content?.contentHash,
    profileBlock: plan.profile?.block ?? null,
    warning:
      "Initializers and imported modules execute with your user permissions in future Shell sessions. This is NOT a sandbox. Existing session functions are not unloaded. Persistent data is not content-bound.",
  };
}

export async function integrate(
  store: Store,
  spec: string,
  path: string,
  options: {
    confirmed?: boolean;
    binding?: string;
    remove?: boolean;
    shell?: "powershell" | "bash";
  } = {},
) {
  return await store.mutate(async (state) => {
    const plan = await integrationPlan(
      store.root,
      state,
      spec,
      path,
      !!options.remove,
      options.shell,
    );
    if (!options.confirmed || !options.binding)
      fail(
        "Profile integration requires explicit approval and a preview --binding",
      );
    if (options.binding !== plan.binding)
      fail("Integration or Profile changed after preview; inspect again");
    await stageProfileChange(
      store.root,
      state,
      resolve(path),
      plan.bytes,
      plan.after,
      plan.profile,
    );
    state.schemaVersion = Math.max(
      state.schemaVersion,
      options.shell === "bash" ? 7 : 5,
    ) as State["schemaVersion"];
    state.aliases ??= {};
    state.data ??= {};
    state.profiles ??= {};
    if (plan.profile) state.profiles[plan.id] = plan.profile;
    else delete state.profiles[plan.id];
    return { status: "completed", profile: resolve(path), restartShell: true };
  });
}

async function assertShellSnapshotReady(store: Store): Promise<void> {
  for (const journal of [
    join(store.root, "operations", "persist.json"),
    join(store.root, "operations", "layout.json"),
    join(store.root, "operations", "desktop.json"),
    profileJournal(store.root),
    store.installPath,
    store.journalPath,
    store.removalPath,
    store.dataRemovalPath,
    store.rebuildPath,
    join(store.root, "operations", "self-update.json"),
  ]) {
    await noLinks(journal);
    if (await exists(journal))
      fail(
        "Interrupted operation; run piko recover before Shell initialization",
      );
  }
}

// Source fetches and downloads may hold the writer lock for minutes. They do
// not invalidate already committed, explicitly approved initializer content.
// Compare only inputs used by shellContent; a source commit/revision alone is
// not a change to selected executable content or approval.
function shellSnapshot(state: State, path: string): string {
  const profile = state.profiles?.[profileKey(path)];
  const keys = new Set(Object.keys(profile?.approvals ?? {}));
  const sourceAliases = new Set<string>();
  for (const key of [...keys]) {
    const selected = state.defaults[key];
    const install = selected && state.installs[selected.id];
    for (const dependency of install?.depends ?? []) {
      const parsed = parseSpec(dependency.package);
      if (parsed.source) sourceAliases.add(parsed.source);
      const source = parsed.source
        ? state.sources[parsed.source]
        : install!.source;
      if (source) keys.add(packageKey(source, parsed.name));
    }
  }
  return JSON.stringify([
    profile,
    [...keys]
      .sort()
      .map((key) => [
        key,
        state.defaults[key],
        state.defaults[key] && state.installs[state.defaults[key]!.id],
      ]),
    state.commands,
    state.aliases,
    [...sourceAliases]
      .sort()
      .map((alias) => [alias, state.sources[alias]?.identity]),
  ]);
}

export async function shellInit(
  store: Store,
  path: string,
  shell: "powershell" | "bash" = "powershell",
): Promise<string> {
  await assertShellSnapshotReady(store);
  const state = await store.read(),
    profile = state.profiles?.[profileKey(path)];
  if (!profile) {
    const latest = await store.read();
    await assertShellSnapshotReady(store);
    if (shellSnapshot(latest, path) !== shellSnapshot(state, path))
      fail(
        "Piko Shell approvals changed during initialization; retry in a new Shell",
      );
    return "# No approved Piko Shell initializers";
  }
  if ((profile.shell ?? "powershell") !== shell) fail("Profile Shell mismatch");
  const output: string[] = [];
  for (const [key, approval] of Object.entries(profile.approvals).sort()) {
    const selection = state.defaults[key],
      install = selection && state.installs[selection.id];
    if (!install) continue;
    try {
      const content = await shellContent(store.root, state, install, shell);
      if (content.binding !== approval.binding)
        fail(
          "content or dependency changed; preview and approve integration again",
        );
      if (shell === "bash") {
        output.push(
          "PikoPackageRoot=" +
            bashQuote(bashPath(join(store.root, install.dir))),
          "declare -A PikoDependencies=(" +
            Object.entries(content.dependencies)
              .map(
                ([name, target]) =>
                  "[" + bashQuote(name) + "]=" + bashQuote(bashPath(target)),
              )
              .join(" ") +
            ")",
          content.script,
        );
        continue;
      }
      output.push(
        "try {",
        ". {",
        `$PikoPackageRoot = ${psQuote(join(store.root, install.dir))}`,
        "$PikoDependencies = @{" +
          Object.entries(content.dependencies)
            .map(([name, target]) => `${psQuote(name)} = ${psQuote(target)}`)
            .join("; ") +
          "}",
        content.script,
        "}",
        "} catch { Write-Warning ('Piko initializer failed: ' + $_.Exception.Message) }",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.push(
        shell === "bash"
          ? "printf '%s\\n' " +
              bashQuote("Piko " + install.name + ": " + message) +
              " >&2"
          : `Write-Warning ${psQuote(`Piko ${install.name}: ${message}`)}`,
      );
    }
  }
  const latest = await store.read();
  await assertShellSnapshotReady(store);
  if (shellSnapshot(latest, path) !== shellSnapshot(state, path))
    fail(
      "Piko state changed while preparing Shell initialization; retry in a new Shell",
    );
  return output.join(shell === "bash" ? "\n" : "\r\n");
}

export async function shellDiagnostics(store: Store) {
  const state = await store.read();
  const results = [];
  for (const profile of Object.values(state.profiles ?? {})) {
    let profileIssue: string | undefined;
    try {
      editProfile(
        store.root,
        await profileBytes(profile.path),
        profile.block,
        profile.block,
      );
    } catch (error) {
      profileIssue = error instanceof Error ? error.message : String(error);
    }
    for (const [key, approval] of Object.entries(profile.approvals)) {
      const selected = state.defaults[key],
        install = selected && state.installs[selected.id];
      let status = install ? "ready" : "inactive",
        issue = profileIssue;
      if (install) {
        try {
          if (
            (await shellContent(store.root, state, install, profile.shell))
              .binding !== approval.binding
          )
            throw new Error(
              "Content or dependency changed; preview and approve integration again",
            );
        } catch (error) {
          status = "blocked";
          issue = error instanceof Error ? error.message : String(error);
        }
      }
      if (profileIssue) status = "blocked";
      results.push({
        profile: profile.path,
        package: install ? install.source.alias + "/" + install.name : key,
        status,
        issue,
      });
    }
  }
  return results;
}
