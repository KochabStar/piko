import type { UpdateRow } from "./update-display-types.ts";
import { cleanText } from "./progress.ts";
import {
  tint,
  accentGradient,
  symbol,
  textWidth,
  type TerminalStyle,
} from "./terminal-style.ts";
import { join } from "node:path";
import type { Source, State } from "./types.ts";
import type { Packages } from "./packages.ts";
import { publicEndpoint } from "./util.ts";

// Metadata may originate in a source. Never let it inject terminal control codes
// or new rows into human-readable tables; JSON retains the original values.
const cell = cleanText;
export function humanOutput(
  text: string,
  color: boolean,
  options: Omit<TerminalStyle, "color"> = {},
): string {
  if (!color) return text;
  const style: TerminalStyle = { ...options, color };
  let headers: string[] | undefined;
  return text
    .split("\n")
    .map((line, index) => {
      const safe = cleanText(line);
      if (index === 0 && /^(PACKAGE|SOURCE|COMMAND|KIND)\s/.test(safe)) {
        headers = safe.split(/ {2,}/);
        return accentGradient(safe, style);
      }
      if (headers && safe && !/^\d+ installed version/.test(safe)) {
        let column = 0;
        return safe
          .split(/( {2,})/)
          .map((part) => {
            if (/^ +$/.test(part)) return part;
            const header = headers![column++];
            if (["PACKAGE", "SOURCE", "COMMAND", "KIND"].includes(header ?? ""))
              return tint(part, "strong", style);
            if (["VERSION", "LATEST"].includes(header ?? ""))
              return tint(part, "purple", style);
            if (header === "STATUS")
              return tint(
                part,
                ["failed", "blocked"].includes(part)
                  ? "error"
                  : ["updated", "current"].includes(part)
                    ? "success"
                    : part === "downgrade"
                      ? "warning"
                      : "muted",
                style,
              );
            if (header === "SELECTED" || header === "VERIFIED")
              return tint(
                part,
                ["*", "yes"].includes(part)
                  ? "success"
                  : part === "no"
                    ? "warning"
                    : "muted",
                style,
              );
            return tint(part, "muted", style);
          })
          .join("");
      }
      if (
        /^All packages are up to date\.$/.test(safe) ||
        /^Installed |^Default: /.test(safe)
      )
        return (
          tint(symbol("success", style.unicode), "success", style) +
          "  " +
          tint(safe, /^All packages/.test(safe) ? "muted" : "blue", style)
        );
      const result =
        /^(\S+) (\([^)]+\)): (updated|outdated|failed|blocked|downgrade)(.*)$/.exec(
          safe,
        );
      if (result) {
        const tone = ["failed", "blocked"].includes(result[3]!)
          ? "error"
          : result[3] === "downgrade"
            ? "warning"
            : "success";
        return (
          tint(
            symbol(tone === "error" ? "error" : "success", style.unicode),
            tone,
            style,
          ) +
          "  " +
          tint(result[1]!, "strong", style) +
          " " +
          tint(result[2]!, "muted", style) +
          "  " +
          tint(result[3]!, tone, style) +
          result[4]
        );
      }
      if (
        /^\d+ (?:updated|outdated|failed|blocked)|^\d+ installed version/.test(
          safe,
        )
      )
        return tint(safe, "muted", style);
      return safe;
    })
    .join("\n");
}

export function table(headers: string[], rows: string[][]): string {
  const values = [headers, ...rows].map((row) => row.map(cell));
  const widths = headers.map((_, i) =>
    values.reduce((width, row) => Math.max(width, textWidth(row[i] ?? "")), 0),
  );
  return values
    .map((row) =>
      row
        .map((value, i) =>
          i === row.length - 1
            ? value
            : value + " ".repeat(widths[i]! - textWidth(value)),
        )
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
export function installedRows(
  root: string,
  state: State,
  query = "",
  selectedOnly = false,
) {
  const filter = query.toLowerCase();
  return Object.values(state.installs)
    .map((i) => ({
      package: `${i.source.alias}/${i.name}`,
      version: i.version,
      default: state.defaults[i.key]?.id === i.id,
      request:
        state.defaults[i.key]?.id === i.id
          ? state.defaults[i.key]?.request
          : undefined,
      verified: i.verified,
      path: join(root, i.dir),
    }))
    .filter(
      (i) =>
        `${i.package}@${i.version}`.toLowerCase().includes(filter) &&
        (!selectedOnly || i.default),
    )
    .sort(
      (a, b) =>
        a.package.localeCompare(b.package) ||
        Number(b.default) - Number(a.default) ||
        a.version.localeCompare(b.version, undefined, { numeric: true }),
    );
}
export function updateTable(
  rows: UpdateRow[],
  options: { verbose?: boolean } = {},
): string {
  if (!options.verbose) {
    if (!rows.length) return "No selected packages to update.";
    const visible = rows.filter(
      (row) => !["current", "pinned", "unchanged"].includes(row.status),
    );
    if (!visible.length) return "All packages are up to date.";
    const counts = new Map<string, number>();
    for (const row of visible)
      counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
    const lines = visible.map((row) => {
      const version =
        row.current && row.candidate && row.current !== row.candidate
          ? `${row.current} -> ${row.candidate}`
          : (row.version ?? row.current ?? "-");
      const reason = row.error ?? row.reason;
      return cleanText(
        `${row.package} (${version}): ${row.status}${reason && !["current", "pinned", "unchanged"].includes(row.status) ? " - " + reason : ""}`,
      );
    });
    const summary =
      [...counts].map(([status, count]) => `${count} ${status}`).join(", ") +
      ".";
    return [...lines, ...(lines.length ? [""] : []), summary].join("\n");
  }
  if (!rows.length) return "No selected packages to update.";
  const counts = new Map<string, number>();
  for (const row of rows)
    counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  return (
    table(
      ["PACKAGE", "VERSION", "STATUS", "DETAIL"],
      rows.map((r) => [
        r.package,
        r.current && r.candidate && r.current !== r.candidate
          ? `${r.current} -> ${r.candidate}`
          : (r.version ?? r.current ?? "-"),
        r.status,
        r.error ?? r.reason ?? `request: ${r.request}`,
      ]),
    ) +
    "\n\n" +
    [...counts].map(([status, count]) => `${count} ${status}`).join("; ") +
    "."
  );
}

export function sourceTable(sources: Source[], verbose = false): string {
  if (!sources.length) return "No configured sources.";
  return table(
    ["SOURCE", "TYPE", "URL", ...(verbose ? ["REF", "COMMIT"] : [])],
    sources
      .sort((a, b) => a.alias.localeCompare(b.alias))
      .map((s) => [
        s.alias,
        s.type,
        publicEndpoint(s.url),
        ...(verbose ? [s.ref ?? "-", s.commit ?? "-"] : []),
      ]),
  );
}

export function infoSummary(
  info: Awaited<ReturnType<Packages["info"]>>,
  verbose = false,
): string {
  const lines = [info.package];
  if (info.ambiguous) lines.push("Ambiguous package; specify a source.");
  for (const entry of info.available) {
    lines.push(
      `Source: ${entry.source.alias} (${publicEndpoint(entry.source.url)})`,
      `Latest: ${entry.latest}`,
    );
    if (entry.version && entry.version !== entry.latest)
      lines.push(`Requested: ${entry.version}`);
    if (entry.runtime)
      lines.push(
        `Runtime: ${entry.runtime.family} / ${entry.runtime.distribution}`,
      );
    if (entry.aliases && Object.keys(entry.aliases).length)
      lines.push(
        `Aliases: ${Object.entries(entry.aliases)
          .map(([a, v]) => `${a}=${v}`)
          .join(", ")}`,
      );
    if (verbose) lines.push(`Versions: ${entry.versions.join(", ")}`);
    else lines.push(`Versions: ${entry.versions.length} available`);
    for (const dependency of entry.dependencies ?? []) {
      lines.push(
        `Dependency: ${dependency.package} (${dependency.satisfied ? "ready" : "unmet"})`,
      );
      if (!dependency.satisfied)
        lines.push(...dependency.issues, ...dependency.advice);
    }
  }
  lines.push(
    "Installed: " +
      (info.installed
        .map(
          (i) =>
            `${i.version}${i.default ? " *" : ""}${!i.verified ? " [unverified]" : ""}`,
        )
        .join(", ") || "none"),
  );
  if (verbose)
    for (const i of info.installed)
      lines.push(`Path (${i.version}): ${i.path}`);
  return lines.map(cleanText).join("\n");
}

export function installedTable(
  rows: ReturnType<typeof installedRows>,
  verbose = false,
): string {
  if (!rows.length) return "No installed packages match.";
  return (
    table(
      [
        "PACKAGE",
        "VERSION",
        "SELECTED",
        "VERIFIED",
        ...(verbose ? ["REQUEST", "PATH"] : []),
      ],
      rows.map((i) => [
        i.package,
        i.version,
        i.default ? "*" : "-",
        i.verified ? "yes" : "no",
        ...(verbose ? [i.request ?? "-", i.path] : []),
      ]),
    ) + `\n\n${rows.length} installed version(s); * = selected.`
  );
}

// Approval plans, repair reports and status documents used to print as raw
// JSON. Render them as indented key/value text instead: scalars stay inline,
// arrays of objects become "- one entry per line" blocks and multi-line
// script bodies keep their own lines. Scripts must pass --json for the
// original structured output.
const scalarText = (value: unknown): string =>
  value === null || value === undefined
    ? "-"
    : typeof value === "string"
      ? value
      : String(value);
function describeValue(value: unknown, indent: string, lines: string[]): void {
  if (Array.isArray(value)) {
    if (!value.length) {
      lines.push(indent + "-");
      return;
    }
    for (const item of value) {
      if (item !== null && typeof item === "object") {
        const nested: string[] = [];
        describeValue(item, "", nested);
        nested.forEach((line, index) =>
          lines.push(indent + (index === 0 ? "- " : "  ") + line),
        );
      } else lines.push(indent + "- " + scalarText(item));
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      if (typeof entry === "string" && entry.includes("\n")) {
        // Multi-line script bodies keep their own lines verbatim so users
        // approve exactly what will run.
        lines.push(`${indent}${key}:`);
        lines.push(...entry.split("\n").map((line) => indent + line));
        continue;
      }
      if (entry === null || typeof entry !== "object") {
        lines.push(`${indent}${key}: ${scalarText(entry)}`);
        continue;
      }
      const nested: string[] = [];
      describeValue(entry, "  ", nested);
      lines.push(`${indent}${key}:`, ...nested.map((line) => indent + line));
    }
    return;
  }
  lines.push(indent + scalarText(value));
}
export function planSummary(value: unknown): string {
  const lines: string[] = [];
  describeValue(value, "", lines);
  return lines.join("\n");
}

const countList = (items: [string, number][]): string =>
  items.map(([label, count]) => `${count} ${label}`).join(", ") + ".";

export function cleanupPlanSummary(
  plan: {
    keep: number;
    binding: string;
    entries: {
      package: string;
      version: string;
      action: string;
      reason?: string;
    }[];
  },
  verbose = false,
): string {
  if (!plan.entries.length) return "No installed versions to clean up.";
  const counts = new Map<string, number>();
  for (const entry of plan.entries)
    counts.set(entry.action, (counts.get(entry.action) ?? 0) + 1);
  // Like update --all, the default view shows only entries piko will act on;
  // retained versions stay out of the way until --verbose.
  const visible = verbose
    ? plan.entries
    : plan.entries.filter(
        (entry) =>
          entry.action !== "keep" && entry.action !== "protect-default",
      );
  if (!visible.length)
    return (
      `Nothing to clean up; every version is retained ` +
      `(each default plus ${plan.keep} other).\nBinding: ${plan.binding}`
    );
  return (
    table(
      ["PACKAGE", "VERSION", "ACTION", "REASON"],
      visible.map((entry) => [
        entry.package,
        entry.version,
        entry.action,
        entry.reason ?? "-",
      ]),
    ) +
    `\n\n${countList([...counts])}` +
    `\nKeeps each default plus ${plan.keep} other version(s).` +
    `\nBinding: ${plan.binding}`
  );
}

export function cleanupResultSummary(
  results: {
    package: string;
    version: string;
    status: string;
    error?: string;
  }[],
): string {
  if (!results.length) return "Nothing to clean up.";
  const counts = new Map<string, number>();
  for (const result of results)
    counts.set(result.status, (counts.get(result.status) ?? 0) + 1);
  return (
    table(
      ["PACKAGE", "VERSION", "STATUS", "DETAIL"],
      results.map((result) => [
        result.package,
        result.version,
        result.status,
        result.error ?? "-",
      ]),
    ) + `\n\n${countList([...counts])}`
  );
}

export function cleanupDataSummary(spec: string, paths: string[]): string {
  return (
    `Persistent data recorded for ${spec} (preview only, nothing deleted):\n` +
    paths.map((path) => "  " + path).join("\n")
  );
}

export function orphansSummary(
  items: {
    path: string;
    installation?: { source: { alias: string }; name: string; version: string };
    issue?: string;
    quarantined?: boolean;
    destination?: string;
  }[],
): string {
  if (!items.length) return "No orphaned installations found.";
  return (
    table(
      ["PATH", "STATUS"],
      items.map((item) => [
        item.path,
        item.quarantined
          ? `quarantined -> ${item.destination}`
          : item.installation
            ? `orphan of ${item.installation.source.alias}/${item.installation.name}@${item.installation.version}; quarantine available`
            : (item.issue ?? "not recognized; never touched automatically"),
      ]),
    ) +
    `\n\n${items.length} unreferenced director${items.length === 1 ? "y" : "ies"}.`
  );
}

export function cacheCleanSummary(
  entries: { kind: string; removable: boolean; path: string }[],
  verbose = false,
): string {
  const removed = entries.filter((entry) => entry.removable);
  if (!entries.length) return "Cache is empty.";
  return (
    `Removed ${removed.length} cache entr${removed.length === 1 ? "y" : "ies"}; ` +
    `${entries.length - removed.length} retained (still referenced or not managed).` +
    (verbose && removed.length
      ? "\n" +
        removed.map((entry) => `  ${entry.kind}: ${entry.path}`).join("\n")
      : "")
  );
}

export function resetSummary(result: {
  status: string;
  packages: string[];
  shims: string[];
  current: { source: string }[];
  data: { source: string }[];
  shortcuts: unknown[];
  seedDataPreserved: string[];
  settings: unknown;
}): string {
  const settingsCount = Array.isArray(result.settings)
    ? result.settings.length
    : Object.keys(result.settings ?? {}).length;
  const lines = [
    `Reset ${result.status === "preview" ? "preview" : "completed"} for:`,
    ...result.packages.map((name) => "  " + name),
  ];
  if (result.shims.length)
    lines.push(`Shims rebuilt: ${result.shims.join(", ")}`);
  if (result.current.length)
    lines.push(
      "Current entries repaired:",
      ...result.current.map((m) => "  " + m.source),
    );
  if (result.data.length)
    lines.push(
      "Data mappings repaired:",
      ...result.data.map((m) => "  " + m.source),
    );
  if (result.shortcuts.length)
    lines.push(`Shortcuts repaired: ${result.shortcuts.length}`);
  if (settingsCount) lines.push(`Profile settings restored: ${settingsCount}`);
  if (result.seedDataPreserved.length)
    lines.push(`Seed data preserved: ${result.seedDataPreserved.length}`);
  if (
    !result.shims.length &&
    !result.current.length &&
    !result.data.length &&
    !result.shortcuts.length &&
    !settingsCount
  )
    lines.push("Nothing to repair.");
  return lines.join("\n");
}

export function doctorSummary(report: {
  root: string;
  state: string;
  revision: number;
  bun: string;
  platform: string;
  arch: string;
  installs: number;
  orphans: { path: string; issue?: string; installation?: unknown }[];
  pathDiagnostics: {
    name: string;
    resolved: string | null;
    expected: string;
    shadowed: boolean;
    missing: boolean;
    advice?: string;
  }[];
  shellIntegrations: { package: string; status: string; issue?: string }[];
  dataProfiles: { package: string; status: string; issue?: string }[];
  desktopIntegrations: Record<string, unknown>;
  executions: {
    bootstraps: Record<string, { status?: string }>;
    system: Record<string, { action?: string }>;
  };
  limits: string[];
}): string {
  const lines = [
    `Root: ${report.root}`,
    `State: ${report.state} (revision ${report.revision})`,
    `Runtime: bun ${report.bun} on ${report.platform}-${report.arch}`,
    `Installs: ${report.installs}`,
  ];
  lines.push("Path resolution:");
  for (const item of report.pathDiagnostics)
    lines.push(
      `  ${item.name}: ${
        item.shadowed
          ? `shadowed by ${item.resolved} (expected ${item.expected})`
          : item.missing
            ? "not found on PATH"
            : "ok"
      }${item.advice && item.shadowed ? " — " + item.advice : ""}`,
    );
  lines.push(
    `Orphans: ${report.orphans.length}` +
      (report.orphans.length
        ? "\n" +
          report.orphans
            .map((o) => `  ${o.path}: ${o.issue ?? "recognized installation"}`)
            .join("\n")
        : ""),
  );
  lines.push(
    `Shell integrations: ${report.shellIntegrations.length}` +
      (report.shellIntegrations.length
        ? "\n" +
          report.shellIntegrations
            .map(
              (s) =>
                `  ${s.package}: ${s.status}${s.issue ? " — " + s.issue : ""}`,
            )
            .join("\n")
        : ""),
  );
  lines.push(
    `Data profiles: ${report.dataProfiles.length}` +
      (report.dataProfiles.length
        ? "\n" +
          report.dataProfiles
            .map(
              (d) =>
                `  ${d.package}: ${d.status}${d.issue ? " — " + d.issue : ""}`,
            )
            .join("\n")
        : ""),
  );
  lines.push(
    `Desktop integrations: ${Object.keys(report.desktopIntegrations).length}`,
  );
  const bootstraps = Object.entries(report.executions.bootstraps),
    systems = Object.entries(report.executions.system);
  lines.push(
    `Executions: ${bootstraps.length} bootstrap(s), ${systems.length} system integration(s)` +
      (bootstraps.length
        ? "\n" +
          bootstraps
            .map(([id, b]) => `  bootstrap ${id}: ${b.status ?? "-"}`)
            .join("\n")
        : "") +
      (systems.length
        ? "\n" +
          systems
            .map(([id, s]) => `  system ${id}: ${s.action ?? "-"}`)
            .join("\n")
        : ""),
  );
  lines.push("Limits:", ...report.limits.map((limit) => "  - " + limit));
  return lines.join("\n");
}

export function selfStatusSummary(status: {
  pending: Record<string, unknown> | null;
  last: Record<string, unknown> | null;
}): string {
  const lines: string[] = [];
  if (status.pending)
    lines.push(
      `Pending self-update (phase ${status.pending.phase ?? "unknown"}); run piko recover to finish or discard it.`,
    );
  else lines.push("No pending self-update.");
  lines.push(
    status.last
      ? `Last self-update finished at ${status.last.finishedAt ?? "unknown time"}.`
      : "No completed self-update recorded yet.",
  );
  return lines.join("\n");
}

export function importPlanSummary(plan: {
  conflicts: string[];
  order: string[];
  steps: { action: string; package?: string }[];
  binding: string;
  warning: string;
}): string {
  const lines: string[] = [];
  if (plan.conflicts.length) {
    lines.push(
      "Conflicts (must be resolved before restore):",
      ...plan.conflicts.map((conflict) => "  - " + conflict),
    );
  } else lines.push("No conflicts.");
  if (plan.order.length) {
    lines.push(
      "Install order:",
      ...plan.order.map((spec, index) => `  ${index + 1}. ${spec}`),
    );
  }
  const counts = new Map<string, number>();
  for (const step of plan.steps)
    counts.set(step.action, (counts.get(step.action) ?? 0) + 1);
  lines.push(
    `Steps: ${countList([...counts])}`,
    `Binding: ${plan.binding}`,
    plan.warning,
  );
  return lines.join("\n");
}
