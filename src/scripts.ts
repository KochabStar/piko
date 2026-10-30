import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import {
  capture,
  exists,
  fail,
  json,
  networkUrl,
  noLinks,
  record,
  relativeFile,
  sha256,
} from "./util.ts";
import type { Install, ScriptApproval } from "./types.ts";
import type { npmContext } from "./npm.ts";

// A directory digest includes names, file bytes and empty directories, not mtimes.
// The root receipt is Piko metadata, never package input. No links or special files.
export async function npmTreeHash(root: string): Promise<string> {
  await noLinks(root);
  const hash = createHash("sha256");
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const names = (await readdir(dir))
      .sort()
      .filter((name) => prefix || name !== ".piko-install.json");
    // Read at most sixteen files at once, but fold records in the original
    // lexical traversal order. Existing snapshot hashes/approvals stay valid.
    for (let offset = 0; offset < names.length; offset += 16) {
      const entries = await Promise.all(
        names.slice(offset, offset + 16).map(async (name) => {
          const path = prefix ? `${prefix}/${name}` : name;
          relativeFile(path);
          const full = join(dir, name),
            info = await lstat(full),
            directory = info.isDirectory();
          if (
            info.isSymbolicLink() ||
            (!info.isFile() && !directory) ||
            (info.isFile() && info.nlink > 1)
          )
            fail("Linked or special npm content is not supported");
          let digest = "";
          if (!directory) {
            const fileHash = createHash("sha256");
            for await (const chunk of createReadStream(full))
              fileHash.update(chunk);
            digest = fileHash.digest("hex");
          }
          return { path, full, directory, digest };
        }),
      );
      for (const entry of entries) {
        hash.update(
          JSON.stringify([entry.path, entry.directory ? "directory" : "file"]),
        );
        if (entry.directory) await walk(entry.full, entry.path);
        else hash.update(entry.digest);
      }
    }
  };
  await walk(root, "");
  return hash.digest("hex");
}
export function npmSnapshotPath(root: string, hash: string): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) fail("Invalid npm snapshot hash");
  return join(root, "cache", "npm-input", hash);
}
export async function saveNpmSnapshot(
  root: string,
  stage: string,
): Promise<string> {
  const hash = await npmTreeHash(stage),
    target = npmSnapshotPath(root, hash);
  await noLinks(target);
  if (!(await exists(target))) {
    await mkdir(dirname(target), { recursive: true });
    await cp(stage, target, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
  if ((await npmTreeHash(target)) !== hash)
    fail("npm snapshot content changed; inspect cache before retrying");
  return hash;
}
export async function scriptPlan(root: string, install: Install) {
  if (install.kind !== "npm" || !install.npmBuild)
    fail(
      "This installation has no verified npm snapshot; uninstall and reinstall it before approving scripts",
    );
  const snapshot = npmSnapshotPath(root, install.npmBuild.inputHash);
  if ((await npmTreeHash(snapshot)) !== install.npmBuild.inputHash)
    fail("npm snapshot content changed; approval refused");
  if (
    (await npmTreeHash(join(root, install.dir))) !==
    install.npmBuild.currentHash
  )
    fail(
      "Installed npm content changed; reinstall before approving or rebuilding",
    );
  const lock = await json(join(snapshot, "package-lock.json"));
  if (
    sha256(JSON.stringify(lock)) !== install.checksum ||
    !record(lock.packages)
  )
    fail("npm lock contents differ from verified installation");
  const graph: { path: string; resolved: string; integrity: string }[] = [];
  const scripts: {
    path: string;
    name: string;
    version: string;
    resolved: string;
    integrity: string;
    events: Record<string, string>;
    binding: string;
    approved: boolean;
  }[] = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    relativeFile(path);
    if (
      !record(entry) ||
      entry.link ||
      typeof entry.resolved !== "string" ||
      typeof entry.integrity !== "string" ||
      !/^sha(256|384|512)-/.test(entry.integrity)
    )
      fail("Unverifiable npm graph");
    networkUrl(entry.resolved);
    const file = join(snapshot, path, "package.json");
    if (!(await exists(file))) {
      if (entry.optional === true) continue;
      fail("Missing required npm package");
    }
    const pkg = await json(file);
    graph.push({ path, resolved: entry.resolved, integrity: entry.integrity });
    const events: Record<string, string> = {};
    for (const event of ["preinstall", "install", "postinstall", "prepare"])
      if (typeof pkg.scripts?.[event] === "string")
        events[event] = pkg.scripts[event];
    if (
      pkg.gypfile !== false &&
      !events.preinstall &&
      !events.install &&
      (await exists(join(snapshot, path, "binding.gyp")))
    )
      events.install = "node-gyp rebuild";
    if (!Object.keys(events).length) continue;
    // npm rebuild does not run prepare for registry packages. Do not pretend it does.
    const binding = sha256(
      JSON.stringify([
        install.id,
        install.source.identity,
        install.npmBuild.inputHash,
        path,
        entry.resolved,
        entry.integrity,
        events,
      ]),
    );
    scripts.push({
      path,
      name: String(pkg.name),
      version: String(pkg.version),
      resolved: entry.resolved,
      integrity: entry.integrity,
      events,
      binding,
      approved: install.npmBuild.approvals[path]?.binding === binding,
    });
  }
  return {
    install: install.id,
    inputHash: install.npmBuild.inputHash,
    warning:
      "Approved scripts run with your user permissions, not in a sandbox. Approval does not automatically allow dependency lifecycle scripts.",
    scripts,
    graph,
  };
}
export async function rebuildNpm(
  context: Awaited<ReturnType<typeof npmContext>>,
  stage: string,
  control: string,
  plan: Awaited<ReturnType<typeof scriptPlan>>,
  approvals: Record<string, ScriptApproval>,
): Promise<void> {
  await (await import("./npm-policy.ts")).verifyNpmPolicy(context, control);
  const approved = plan.scripts.filter(
    (s) => approvals[s.path]?.binding === s.binding,
  );
  if (!approved.length)
    fail(
      "No content-bound script approvals; inspect and approve a specific package first",
    );
  const policy: Record<string, boolean> = {};
  for (const item of plan.graph) {
    const allowed = approved.some((s) => s.path === item.path);
    if (
      allowed &&
      plan.graph.filter((g) => g.resolved === item.resolved).length !== 1
    )
      fail(
        "npm cannot approve only one occurrence of this resolved package; duplicate source granularity is unsupported",
      );
    if (!Object.hasOwn(policy, item.resolved) || !allowed)
      policy[item.resolved] = allowed;
  }

  if (await exists(join(stage, ".npmrc")))
    fail("Unexpected project npm configuration");
  const packageFile = join(stage, "package.json"),
    original = await readFile(packageFile),
    pkg = JSON.parse(original.toString("utf8"));
  pkg.allowScripts = policy;
  await writeFile(packageFile, JSON.stringify(pkg));
  const config = join(control, "empty.npmrc");
  await writeFile(config, "");
  const globalConfig = join(control, "global.npmrc");
  await writeFile(globalConfig, "");
  const shell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "cmd.exe",
  );
  await noLinks(shell);
  const baseArgs = [
    "--global=false",
    "--workspaces=false",
    "--dangerously-allow-all-scripts=false",
    "--offline=true",
    "--no-audit",
    "--no-fund",
    "--update-notifier=false",
    "--userconfig=" + config,
    "--globalconfig=" + globalConfig,
    "--script-shell=" + shell,
    "--registry=" + context.registry,
  ];
  // Generate only private dependency command launchers with lifecycle disabled.
  // This never exposes transitive binaries in Piko's global shims directory.
  await capture(
    context.node,
    [
      context.npm,
      "rebuild",
      "--prefix=" + stage,
      "--ignore-scripts=true",
      "--bin-links=true",
      ...baseArgs,
    ],
    { cwd: stage, env: context.env },
  );
  await capture(
    context.node,
    [
      context.npm,
      "rebuild",
      "--prefix=" + stage,
      "--global=false",
      "--workspaces=false",
      "--strict-allow-scripts=true",
      "--ignore-scripts=false",
      "--dangerously-allow-all-scripts=false",
      "--bin-links=false",
      "--rebuild-bundle=false",
      "--offline=true",
      "--no-audit",
      "--no-fund",
      "--update-notifier=false",
      "--userconfig=" + config,
      "--globalconfig=" + globalConfig,
      "--script-shell=" + shell,
      "--registry=" + context.registry,
    ],
    { cwd: stage, env: context.env },
  );
  for (const item of approved.filter((s) => s.events.prepare)) {
    const directory = join(stage, item.path);
    await capture(
      context.node,
      [
        context.npm,
        "run",
        "prepare",
        "--prefix=" + directory,
        "--ignore-scripts=true",
        ...baseArgs,
      ],
      { cwd: directory, env: context.env },
    );
  }
  await noLinks(packageFile);
  await writeFile(packageFile, original);
  if (await exists(join(stage, ".npmrc")))
    fail("Rebuild introduced project npm configuration; refusing commit");
  // Registry prepare is run explicitly above with --ignore-scripts, so npm
  // executes that one event but not preprepare/postprepare or dependency scripts.
  const outputLock = await json(join(stage, "package-lock.json"));
  const input = npmSnapshotPath(dirname(dirname(control)), plan.inputHash);
  if (
    JSON.stringify(outputLock) !==
    JSON.stringify(await json(join(input, "package-lock.json")))
  )
    fail("Rebuild changed the resolved npm graph; refusing commit");
  for (const item of plan.graph) {
    const path = join(item.path, "package.json");
    await noLinks(join(stage, path));
    if (
      JSON.stringify(await json(join(stage, path))) !==
      JSON.stringify(await json(join(input, path)))
    )
      fail("Rebuild changed a package manifest; refusing commit");
  }
}
