import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { githubMetadata } from "../src/github-metadata.ts";
import { emptyState, installId, packageKey } from "../src/store.ts";
import { makeSource } from "../src/catalog.ts";
import { sha256 } from "../src/util.ts";

const root = await mkdtemp(join(tmpdir(), "piko-github-metadata-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const state = emptyState();
const source = makeSource("fixture", "https://publisher.example/source/");
const key = packageKey(source, "gh");
const id = installId(key, "1.0.0");
const payload = "corrupt GitHub helper fixture; never executable";
const dir = "apps/gh/1.0.0";
await mkdir(join(root, dir), { recursive: true });
await writeFile(join(root, dir, "gh.exe"), payload);
state.installs[id] = {
  id,
  key,
  name: "gh",
  version: "1.0.0",
  request: "latest",
  source,
  dir,
  bins: { gh: { path: "gh.exe", kind: "native" } },
  persist: [],
  verified: true,
  checksum: sha256(payload),
  manifestHash: sha256("fixture"),
  kind: "portable",
};
state.defaults[key] = { id, request: "latest" };

test("GitHub credentials are not delegated to external hosts, downloads or arbitrary API endpoints", async () => {
  for (const url of [
    "https://publisher.example/feed.json",
    "https://api.github.com.evil.example/repos/owner/repo/releases/latest",
    "https://github.com/owner/repo/releases/download/v1/tool.zip",
    "https://api.github.com/user",
    "http://127.0.0.1/repos/owner/repo/releases/latest",
  ])
    expect(await githubMetadata(root, state, url)).toBeUndefined();
});

test("an installed but failed gh never silently downgrades to anonymous API access", async () => {
  await expect(
    githubMetadata(
      root,
      state,
      "https://api.github.com/repos/owner/repo/releases/latest",
    ),
  ).rejects.toThrow("No anonymous fallback was attempted");
});

test("missing gh leaves the ordinary HTTP metadata path available", async () => {
  const module = new URL("../src/github-metadata.ts", import.meta.url).href;
  const store = new URL("../src/store.ts", import.meta.url).href;
  const code = `import { githubMetadata } from ${JSON.stringify(module)}; import { emptyState } from ${JSON.stringify(store)}; console.log(await githubMetadata(${JSON.stringify(root)}, emptyState(), "https://api.github.com/repos/owner/repo/releases/latest") === undefined);`;
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: "" };
  for (const key of Object.keys(env))
    if (key.toLowerCase() === "path" && key !== "PATH") delete env[key];
  const child = Bun.spawn([process.execPath, "-e", code], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ exit, err, result: out.trim() }).toEqual({
    exit: 0,
    err: "",
    result: "true",
  });
});
