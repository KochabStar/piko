import type { UpdateRow } from "./update-display-types.ts";
import { cleanText } from "./progress.ts";
import { join } from "node:path";
import type { Source, State } from "./types.ts";
import type { Packages } from "./packages.ts";
import { publicEndpoint } from "./util.ts";

// Metadata may originate in a source. Never let it inject terminal control codes
// or new rows into human-readable tables; JSON retains the original values.
const cell = cleanText;
export function humanOutput(text: string, color: boolean): string {
  if (!color) return text;
  const lines = text.split("\n");
  if (/^PACKAGE\s/.test(lines[0] ?? ""))
    lines[0] = `\x1b[1;36m${lines[0]}\x1b[0m`;
  return lines.join("\n");
}

export function table(headers: string[], rows: string[][]): string {
  const values = [headers, ...rows].map((row) => row.map(cell));
  const widths = headers.map((_, i) =>
    values.reduce(
      (width, row) => Math.max(width, Array.from(row[i] ?? "").length),
      0,
    ),
  );
  return values
    .map((row) =>
      row
        .map((value, i) =>
          i === row.length - 1
            ? value
            : value + " ".repeat(widths[i]! - Array.from(value).length),
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
