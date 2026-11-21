import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { extractArchive } from "./artifacts.ts";
import { containerFile, listContainer } from "./containers.ts";
import { readMsiPlan } from "./msi.ts";
import { fail, inside, noLinks } from "./util.ts";
import {
  applicationFiles,
  epicApplicationFiles,
  nsisApplicationFiles,
  tabbitMiniInstallerPath,
} from "./upstream-validation.ts";
import type { Download } from "./types.ts";
import type { UpstreamRule } from "./upstream.ts";
import type { extractionState } from "./artifacts.ts";

type Budget = ReturnType<typeof extractionState>;
export type UpstreamTools = {
  sevenZip?: string;
  inno?: string;
  lessMsi?: string;
};

/** Materialize only data selections; installer entrypoints are never executed. */
export async function extractUpstreamArchive(
  archive: string,
  download: Download,
  rule: UpstreamRule,
  destination: string,
  budget: Budget,
  tools: UpstreamTools,
  scratch: string,
  cabinets: Record<string, string>,
): Promise<void> {
  if (download.format === "file") fail("Expected an archive distribution");
  if (rule.layout === "tabbit" && download.nested?.length) {
    await extractTabbit(archive, download, destination, budget, tools, scratch);
    return;
  }
  if (rule.layout === "apptree" || rule.layout === "epic") {
    if (download.format !== "msi" || !tools.lessMsi)
      fail("Application-tree layout requires an MSI metadata reader");
    const plan = await readMsiPlan(
      tools.lessMsi,
      archive,
      true,
      Object.keys(cabinets),
    );
    download.files =
      rule.layout === "apptree"
        ? applicationFiles(plan, download.stripPrefix)
        : epicApplicationFiles(plan);
  }
  if (rule.layout === "wecom" || rule.layout === "baidu") {
    if (download.format !== "nsis" || download.nested || !tools.sevenZip)
      fail("Dynamic NSIS application tree requires a direct NSIS payload");
    download.files = nsisApplicationFiles(
      await listContainer(tools.sevenZip, archive, "nsis"),
      rule.layout,
    );
  }
  await extractArchive(
    archive,
    download.format,
    destination,
    download.stripPrefix,
    budget,
    download.into,
    tools.sevenZip,
    tools.inno,
    {
      files: download.files,
      nested: download.nested,
      lessMsi: tools.lessMsi,
      cabinets,
      payload: download.payload,
    },
  );
}

// Match the runtime's intermediate-layer accounting and use its bounded
// extractors. Only the vendor's GUID-selected mini-installer path is dynamic;
// all other selections and codecs remain the source-reviewed recipe.
async function extractTabbit(
  archive: string,
  download: Download,
  destination: string,
  budget: Budget,
  tools: UpstreamTools,
  scratch: string,
): Promise<void> {
  const steps = download.nested!;
  if (!tools.sevenZip || steps.length > 3 || !steps.length)
    fail("Tabbit requires a verified unpacker and bounded nested recipe");
  let current = archive,
    format: Exclude<Download["format"], "file"> | "7z#" =
      download.format === "file"
        ? fail("Nested extraction requires an archive distribution")
        : download.format,
    prefix: string | undefined;
  let resolved = false;
  for (const [n, step] of steps.entries()) {
    const intermediate = {
      ...budget,
      fileLimit: Math.min(2 * 1024 * 1024 * 1024, budget.limit),
      paths: new Map<string, { path: string; directory: boolean }>(),
    };
    if (format === "pe" || format === "nsis") {
      const type = format === "pe" ? "PE" : "nsis";
      const entries = await listContainer(tools.sevenZip, current, type);
      if (step.path.includes("/mini_installer.exe")) {
        step.path = tabbitMiniInstallerPath(
          entries
            .filter((entry) => !entry.directory)
            .map((entry) => entry.path),
        );
        resolved = true;
      }
      const entry = entries.find((entry) => entry.path === step.path);
      if (!entry) fail("Declared nested Tabbit payload disappeared");
      const target = join(scratch, "tabbit-layer-" + n);
      await containerFile(
        tools.sevenZip,
        current,
        type,
        entry,
        target,
        Math.min(intermediate.fileLimit, budget.limit - budget.total),
      );
      intermediate.total += (await lstat(target)).size;
      if (++intermediate.count > 100000 || intermediate.total > budget.limit)
        fail("Tabbit intermediate payload exceeds shared expanded quota");
      current = target;
    } else {
      if (format !== "zip" && format !== "7z")
        fail("Unsupported Tabbit nested codec");
      const output = join(scratch, "tabbit-tree-" + n);
      await mkdir(output);
      await extractArchive(
        current,
        format,
        output,
        prefix,
        intermediate,
        undefined,
        tools.sevenZip,
      );
      if (step.path.includes("/mini_installer.exe")) {
        step.path = tabbitMiniInstallerPath(
          [...intermediate.paths.values()]
            .filter((entry) => !entry.directory)
            .map((entry) => entry.path),
        );
        resolved = true;
      }
      const selected = inside(output, join(output, step.path));
      await noLinks(selected);
      const info = await lstat(selected);
      if (!info.isFile() || info.size > intermediate.fileLimit)
        fail("Nested Tabbit payload is not a bounded regular file");
      current = selected;
    }
    budget.count = intermediate.count;
    budget.total = intermediate.total;
    format = step.format;
    prefix = step.stripPrefix;
  }
  if (!resolved) fail("Tabbit recipe has no mini-installer selection");
  if (format !== "zip" && format !== "7z")
    fail("Unsupported Tabbit final codec");
  await extractArchive(
    current,
    format,
    destination,
    prefix,
    budget,
    download.into,
    tools.sevenZip,
  );
}
