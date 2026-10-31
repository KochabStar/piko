import type { UpdateRow } from "./update-display-types.ts";
import { cleanText } from "./progress.ts";
import {
  tint,
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
  return text
    .split("\n")
    .map((line, index) => {
      const safe = cleanText(line);
      if (index === 0 && /^(PACKAGE|SOURCE|COMMAND|KIND)\s/.test(safe))
        return tint(safe, "accent", style);
      if (
        /^All packages are up to date\.$/.test(safe) ||
        /^Installed |^Default: /.test(safe)
      )
        return (
          tint(symbol("success", style.unicode), "success", style) + "  " + safe
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
