import { relativeFile, fail } from "./util.ts";
import { helperOutput } from "./helpers-process.ts";

// lessmsi is used only for read-only table queries, never its extraction command
// or msiexec. CAB payloads are decoded by the guarded stdout extractor.
export function msiTable(
  text: string,
  expected: string[],
): Record<string, string>[] {
  const lines = text
    .replace(/^\uFEFF/, "")
    .replace(/[\r\n]+$/, "")
    .split(/\r?\n/);
  const parse = (line: string) => {
    const values: string[] = [];
    let cell = "",
      quoted = false,
      closed = false;
    for (let n = 0; n < line.length; n++) {
      const c = line[n]!;
      if (quoted) {
        if (c === '"') {
          if (line[n + 1] === '"') {
            cell += '"';
            n++;
          } else {
            quoted = false;
            closed = true;
          }
        } else cell += c;
      } else if (c === ",") {
        values.push(cell);
        cell = "";
        closed = false;
      } else if (c === '"' && !cell && !closed) quoted = true;
      else {
        if (closed) fail("Ambiguous MSI table CSV");
        cell += c;
      }
    }
    if (quoted) fail("Multiline or unclosed MSI table cell");
    values.push(cell);
    return values;
  };
  const header = parse(lines.shift() ?? "");
  if (
    new Set(header).size !== header.length ||
    expected.some((key) => !header.includes(key))
  )
    fail("Unexpected MSI table columns");
  if (lines.length > 100000) fail("MSI table row limit exceeded");
  return lines.map((line) => {
    const values = parse(line);
    if (values.length !== header.length) fail("Ambiguous MSI table row");
    return Object.fromEntries(header.map((key, n) => [key, values[n]!]));
  });
}
function unique(rows: Record<string, string>[], key: string) {
  const map = new Map<string, Record<string, string>>(),
    seen = new Set<string>();
  for (const row of rows) {
    const id = row[key]!;
    if (!id || /[\x00-\x1f]/.test(id) || seen.has(id.toLowerCase()))
      fail("Duplicate or invalid MSI table identity");
    seen.add(id.toLowerCase());
    map.set(id, row);
  }
  return map;
}
function longName(text: string): string {
  const parts = text.split("|");
  if (parts.length > 2) fail("Ambiguous MSI long filename");
  for (const part of parts) {
    if (part === ".") continue;
    relativeFile(part);
    if (part.includes("/")) fail("MSI names must be single path components");
  }
  return parts.at(-1)!;
}
export function msiPlan(
  tables: {
    Directory: string;
    Component: string;
    File: string;
    Media: string;
  },
  allowVariants = false,
  externalCabinets: string[] = [],
) {
  const dirs = unique(
      msiTable(tables.Directory, [
        "Directory",
        "Directory_Parent",
        "DefaultDir",
      ]),
      "Directory",
    ),
    components = unique(
      msiTable(tables.Component, ["Component", "Directory_"]),
      "Component",
    ),
    fileRows = unique(
      msiTable(tables.File, [
        "File",
        "Component_",
        "FileName",
        "FileSize",
        "Sequence",
      ]),
      "File",
    ),
    mediaRows = msiTable(tables.Media, [
      "DiskId",
      "LastSequence",
      "Cabinet",
      "Source",
    ]);
  const cache = new Map<string, string>();
  const directory = (id: string, parents = new Set<string>()): string => {
    if (cache.has(id)) return cache.get(id)!;
    if (parents.size > 128 || parents.has(id))
      fail("MSI directory cycle or depth limit");
    const row = dirs.get(id);
    if (!row) fail("MSI component references a missing directory");
    parents.add(id);
    const names = row.DefaultDir!.split(":");
    if (names.length > 2) fail("Ambiguous MSI directory name");
    const name = longName(names[0]!);
    if (names[1] !== undefined) longName(names[1]);
    const parent = row.Directory_Parent!,
      root = !parent || parent === id;
    const prefix = root ? "" : directory(parent, parents);
    const part = name === "." || (root && name === "SourceDir") ? "" : name;
    const path = [prefix, part].filter(Boolean).join("/");
    if (path) relativeFile(path);
    cache.set(id, path);
    return path;
  };
  for (const id of dirs.keys()) directory(id);
  for (const component of components.values()) directory(component.Directory_!);
  let last = 0;
  const cabinetNames = new Set<string>();
  const cabinets = mediaRows.map((row) => {
    const cabinet = row.Cabinet!;
    const embedded = cabinet.startsWith("#");
    const name = embedded ? cabinet.slice(1) : cabinet;
    if ((!embedded && !externalCabinets.includes(name)) || row.Source)
      fail(
        "External MSI cabinets require explicit verified cabinet downloads; source redirects/uncompressed media are refused",
      );
    relativeFile(name);
    if (name.includes("/") || cabinetNames.has(name.toLowerCase()))
      fail("Invalid or duplicate MSI cabinet");
    cabinetNames.add(name.toLowerCase());
    if (
      !/^\d+$/.test(row.LastSequence!) ||
      !Number.isSafeInteger(Number(row.LastSequence)) ||
      Number(row.LastSequence) <= last
    )
      fail("Invalid MSI cabinet sequence");
    const first = last + 1;
    last = Number(row.LastSequence);
    return { name, first, last, embedded };
  });
  if (!cabinets.length || cabinets.length > 32)
    fail("MSI requires 1–32 embedded cabinets");
  const targets = new Set<string>(),
    sequences = new Set<number>();
  const files = [...fileRows.values()].map((row) => {
    relativeFile(row.File!);
    if (row.File!.includes("/")) fail("Unsafe MSI file identifier");
    const component = components.get(row.Component_!);
    if (!component) fail("MSI file references a missing component");
    const name = longName(row.FileName!);
    if (name === ".") fail("Invalid MSI file name");
    const path = [directory(component.Directory_!), name]
      .filter(Boolean)
      .join("/");
    relativeFile(path);
    if (targets.has(path.toLowerCase()) && !allowVariants)
      fail("Duplicate or case-colliding MSI target");
    targets.add(path.toLowerCase());
    const size = Number(row.FileSize),
      sequence = Number(row.Sequence);
    if (
      !/^\d+$/.test(row.FileSize!) ||
      !Number.isSafeInteger(size) ||
      !/^\d+$/.test(row.Sequence!) ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      sequences.has(sequence)
    )
      fail("Invalid MSI file size/sequence");
    sequences.add(sequence);
    const cabinet = cabinets.find(
      (c) => sequence >= c.first && sequence <= c.last,
    );
    if (!cabinet) fail("MSI file is outside embedded cabinet sequences");
    return { id: row.File!, path, size, cabinet: cabinet.name };
  });
  if (!files.length) fail("MSI contains no supported files");
  if (
    externalCabinets.some(
      (name) => !cabinets.some((c) => !c.embedded && c.name === name),
    )
  )
    fail("Declared external MSI cabinet is not referenced by Media");
  return { cabinets, files };
}
export async function readMsiPlan(
  executable: string,
  archive: string,
  allowVariants = false,
  externalCabinets: string[] = [],
) {
  const tables = {} as Parameters<typeof msiPlan>[0];
  for (const table of ["Media", "Directory", "Component", "File"] as const)
    tables[table] = new TextDecoder("utf-8", { fatal: true }).decode(
      await helperOutput(
        executable,
        ["l", "-t", table, archive],
        32 * 1024 * 1024,
      ),
    );
  return msiPlan(tables, allowVariants, externalCabinets);
}
