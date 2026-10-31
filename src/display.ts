import type { UpdateRow } from "./update-display-types.ts";
import { cleanText } from "./progress.ts";
import { join } from "node:path";
import type { State } from "./types.ts";

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
export function updateTable(rows: UpdateRow[]): string {
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
    ) +
    `\n\n${rows.length} installed version(s); * = selected. Use --verbose for paths, --json for scripts.`
  );
}
