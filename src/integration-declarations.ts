import { validateEnv } from "./environment.ts";
import { component, fail, record, relativeFile } from "./util.ts";
import type {
  AdminDeclaration,
  BootstrapDeclaration,
  DesktopDeclaration,
  ExecDeclaration,
} from "./types.ts";
function fields(value: unknown, allowed: string[]) {
  if (!record(value) || Object.keys(value).some((k) => !allowed.includes(k)))
    fail("Invalid integration declaration fields");
}
function text(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 8192 ||
    /[\x00-\x1f]/.test(value)
  )
    fail("Invalid integration text");
}
function paths(value: unknown, max = 128): asserts value is string[] {
  if (!Array.isArray(value) || value.length > max)
    fail("Invalid integration path list");
  const seen = new Set<string>();
  for (const path of value) {
    relativeFile(path);
    if (seen.has(path.toLowerCase())) fail("Duplicate integration path");
    seen.add(path.toLowerCase());
  }
}
export function validateExec(
  value: unknown,
  bootstrap = false,
): asserts value is ExecDeclaration {
  fields(
    value,
    bootstrap
      ? ["path", "args", "env", "kind", "outputs"]
      : ["path", "args", "env", "kind"],
  );
  const v = value as ExecDeclaration;
  relativeFile(v.path);
  if (v.kind !== undefined && !["native", "powershell"].includes(v.kind))
    fail("Invalid execution kind");
  if (!(v.kind === "powershell" ? /\.ps1$/i : /\.exe$/i).test(v.path))
    fail("Execution target has unsupported extension");
  if (
    !Array.isArray(v.args) ||
    v.args.length > 128 ||
    v.args.some(
      (a) => typeof a !== "string" || a.length > 8192 || /[\x00-\x1f]/.test(a),
    )
  )
    fail("Execution requires bounded argument array");
  if (v.env) validateEnv(v.env);
}
export function validateBootstrap(
  value: unknown,
): asserts value is BootstrapDeclaration {
  validateExec(value, true);
  paths((value as BootstrapDeclaration).outputs);
  if (!(value as BootstrapDeclaration).outputs.length)
    fail("Bootstrap must declare outputs");
}
export function validateAdmin(
  value: unknown,
): asserts value is AdminDeclaration {
  fields(value, ["install", "remove"]);
  validateExec((value as AdminDeclaration).install);
  validateExec((value as AdminDeclaration).remove);
}
export function validateDesktop(
  value: unknown,
): asserts value is DesktopDeclaration {
  fields(value, [
    "environment",
    "path",
    "shortcuts",
    "fonts",
    "menus",
    "associations",
  ]);
  const v = value as DesktopDeclaration;
  if (!Object.keys(v).length) fail("Desktop declaration must not be empty");
  if (v.environment) validateEnv(v.environment);
  if (v.path !== undefined) {
    if (!Array.isArray(v.path)) fail("Invalid user PATH list");
    paths(v.path.map((p) => (p === "." ? "__piko_root__" : p)));
  }
  if (v.fonts !== undefined) {
    paths(v.fonts, 256);
    if (v.fonts.some((p) => !/\.(ttf|otf)$/i.test(p)))
      fail("Only TTF/OTF fonts supported");
  }
  if (v.associations !== undefined) {
    if (!Array.isArray(v.associations) || v.associations.length > 64)
      fail("Too many file associations");
    const seen = new Set<string>();
    for (const entry of v.associations) {
      fields(entry, ["extension", "label", "path", "args"]);
      if (
        !/^\.[a-z0-9][a-z0-9._-]{0,39}$/i.test(entry.extension) ||
        seen.has(entry.extension.toLowerCase())
      )
        fail("Invalid association extension");
      seen.add(entry.extension.toLowerCase());
      text(entry.label);
      relativeFile(entry.path);
      if (
        !/\.(exe|com)$/i.test(entry.path) ||
        (entry.args &&
          (!Array.isArray(entry.args) ||
            entry.args.some(
              (a) => typeof a !== "string" || /[\x00-\x1f]/.test(a),
            )))
      )
        fail("Invalid association command");
    }
  }
  for (const [kind, items] of [
    ["shortcut", v.shortcuts],
    ["menu", v.menus],
  ] as const) {
    if (items === undefined) continue;
    if (!Array.isArray(items) || items.length > 64)
      fail("Too many desktop entries");
    const seen = new Set<string>();
    for (const item of items) {
      fields(
        item,
        kind === "shortcut"
          ? ["name", "path", "args"]
          : ["id", "label", "target", "path", "args"],
      );
      relativeFile(item.path);
      if (!/\.(exe|com)$/i.test(item.path))
        fail("Desktop entries must reference native executable files");
      const name = "name" in item ? item.name : item.id;
      text(name);
      if (kind === "shortcut") {
        relativeFile(name);
        if (name.includes("/") || name.toLowerCase().endsWith(".lnk"))
          fail("Shortcut name must be a single label without .lnk");
      } else {
        component(name);
        const m = item as NonNullable<DesktopDeclaration["menus"]>[number];
        text(m.label);
        if (!["file", "directory", "background"].includes(m.target))
          fail("Invalid context menu target");
      }
      if (seen.has(name.toLowerCase())) fail("Duplicate desktop entry");
      seen.add(name.toLowerCase());
      if (
        item.args !== undefined &&
        (!Array.isArray(item.args) ||
          item.args.length > 128 ||
          item.args.some(
            (a) =>
              typeof a !== "string" || a.length > 8192 || /[\x00-\x1f]/.test(a),
          ))
      )
        fail("Invalid desktop arguments");
    }
  }
}
