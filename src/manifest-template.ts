import { createHash } from "node:crypto";

type Json = Record<string, any>;
const object = (v: unknown): v is Json =>
  v !== null && typeof v === "object" && !Array.isArray(v);
function requireThat(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
const checksumKey = (n: number) => (n === 0 ? "sha256" : "sha256" + (n + 1));
const quotaKey = (n: number) => (n === 0 ? "maxBytes" : "maxBytes" + (n + 1));
function versionName(version: string) {
  requireThat(
    typeof version === "string" &&
      /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,99}$/.test(version) &&
      !version.includes("..") &&
      !["constructor", "prototype", "__proto__"].includes(version),
    "Unsafe template version",
  );
}
function keys(
  value: unknown,
  allowed: string[],
  label: string,
): asserts value is Json {
  requireThat(
    object(value) && Object.keys(value).every((k) => allowed.includes(k)),
    "Invalid " + label,
  );
}

// Only declared download/path fields are interpolated. Configuration, shell,
// environment, bootstrap/admin code and persistence declarations are literals.
// {root}, {persist}, {app} and unrelated application placeholders are untouched.
function transform(
  manifest: Json,
  version: string,
  row: Json,
  encode: boolean,
) {
  const m = structuredClone(manifest);
  const path = (value: any) =>
    typeof value === "string"
      ? value
          .split(encode ? version : "{version}")
          .join(encode ? "{version}" : version)
      : value;
  m.version = encode ? "{version}" : version;
  const p = m.platforms?.["windows-x64"];
  requireThat(object(p), "Template is missing Windows x64 distribution");
  const ds = p.downloads ?? [p];
  requireThat(
    Array.isArray(ds) && ds.length > 0 && ds.length <= 32,
    "Invalid template downloads",
  );
  ds.forEach((d: Json, n: number) => {
    const key = checksumKey(n),
      quota = quotaKey(n);
    if (encode) {
      if (Object.hasOwn(d, "maxBytes")) row[quota] = d.maxBytes;
      d.maxBytes = "{" + quota + "}";
    } else {
      requireThat(
        d.maxBytes === "{" + quota + "}",
        "Invalid template quota placeholder",
      );
      if (Object.hasOwn(row, quota)) {
        requireThat(
          Number.isSafeInteger(row[quota]) &&
            row[quota] > 0 &&
            row[quota] <= 2147483648,
          "Invalid version download quota",
        );
        d.maxBytes = row[quota];
      } else delete d.maxBytes;
    }
    if (encode) {
      requireThat(
        typeof d.sha256 === "string" && /^[a-f0-9]{64}$/i.test(d.sha256),
        "Template releases require SHA256",
      );
      row[key] = d.sha256;
      d.sha256 = "{" + key + "}";
    } else {
      requireThat(
        d.sha256 === "{" + key + "}" && /^[a-f0-9]{64}$/i.test(row[key] ?? ""),
        "Missing or invalid version SHA256",
      );
      d.sha256 = row[key];
    }
    for (const key of ["url", "file", "into", "stripPrefix"])
      if (d[key] !== undefined) d[key] = path(d[key]);
    if (d.nested)
      for (const step of d.nested)
        for (const key of ["path", "stripPrefix"])
          if (step[key] !== undefined) step[key] = path(step[key]);
    if (d.files)
      d.files = Object.fromEntries(
        Object.entries(d.files).map(([from, to]) => [path(from), path(to)]),
      );
  });
  if (p.bin)
    for (const [name, b] of Object.entries(p.bin)) {
      if (typeof b === "string") p.bin[name] = path(b);
      else if (object(b)) b.path = path(b.path);
    }
  for (const kind of ["shortcuts", "fonts", "associations", "menus"])
    if (p.desktop?.[kind])
      p.desktop[kind] = p.desktop[kind].map((e: any) =>
        typeof e === "string" ? path(e) : { ...e, path: path(e.path) },
      );
  return m;
}

export function resolveManifestDocument(
  document: unknown,
  name: string,
  version: string,
): Json {
  requireThat(object(document), "Invalid manifest document");
  if (document.schemaVersion !== 2) return document;
  keys(
    document,
    ["schemaVersion", "name", "recipes", "versions"],
    "template document fields",
  );
  requireThat(
    document.name === name &&
      object(document.recipes) &&
      object(document.versions),
    "Template package identity mismatch",
  );
  versionName(version);
  requireThat(
    Object.hasOwn(document.versions, version),
    "Version is not registered in template document: " + version,
  );
  const row = document.versions[version];
  requireThat(
    object(row) &&
      typeof row.recipe === "string" &&
      /^r[0-9a-f]{16}$/.test(row.recipe) &&
      Object.hasOwn(document.recipes, row.recipe),
    "Unknown template recipe",
  );
  const recipe = document.recipes[row.recipe];
  requireThat(
    object(recipe) &&
      recipe.schemaVersion === 1 &&
      recipe.name === name &&
      recipe.version === "{version}",
    "Invalid template recipe identity",
  );
  const p = recipe.platforms?.["windows-x64"];
  const count = Array.isArray(p?.downloads) ? p.downloads.length : 1;
  requireThat(count > 0 && count <= 32, "Invalid template download count");
  const allowed = [
    "recipe",
    ...Array.from({ length: count }, (_, i) => checksumKey(i)),
    ...Array.from({ length: count }, (_, i) => quotaKey(i)),
  ];
  keys(row, allowed, "version checksum fields");
  return transform(recipe, version, row, false);
}

export function appendManifest(document: unknown, manifest: Json): Json {
  versionName(manifest.version);
  requireThat(
    document === undefined || object(document),
    "Invalid existing template document",
  );
  const result: Json =
    document === undefined
      ? { schemaVersion: 2, name: manifest.name, recipes: {}, versions: {} }
      : structuredClone(document);
  requireThat(
    result.schemaVersion === 2 &&
      result.name === manifest.name &&
      object(result.recipes) &&
      object(result.versions),
    "Cannot append to an invalid template package",
  );
  requireThat(
    !Object.hasOwn(result.versions, manifest.version),
    "Never replace an already-published template version",
  );
  const row: Json = {};
  const recipe = transform(manifest, manifest.version, row, true);
  const id =
    "r" +
    createHash("sha256")
      .update(JSON.stringify(recipe))
      .digest("hex")
      .slice(0, 16);
  requireThat(
    !Object.hasOwn(result.recipes, id) ||
      JSON.stringify(result.recipes[id]) === JSON.stringify(recipe),
    "Template recipe hash collision",
  );
  result.recipes[id] = recipe;
  result.versions[manifest.version] = { recipe: id, ...row };
  // Property insertion order is part of existing installed manifest hashes.
  // Keep the original ordering when a per-version quota follows other fields.
  const expanded = resolveManifestDocument(
    result,
    manifest.name,
    manifest.version,
  );
  requireThat(
    JSON.stringify(expanded) === JSON.stringify(manifest),
    "Template expansion changes manifest meaning",
  );
  return result;
}
