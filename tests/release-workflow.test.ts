import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  with?: { path: string };
};
const workflow = Bun.YAML.parse(
  await readFile(".github/workflows/verify.yml", "utf8"),
) as {
  permissions: { contents: string };
  jobs: {
    verify: { steps: Step[] };
    publish: {
      if: string;
      needs: string;
      permissions: { contents: string };
      steps: Step[];
    };
  };
};
const work = await mkdtemp(join(tmpdir(), "piko-release-workflow-"));
afterAll(() => rm(work, { recursive: true, force: true }));

function script(steps: Step[], name: string) {
  const run = steps.find((step) => step.name === name)?.run;
  if (!run) throw new Error(`Missing workflow script: ${name}`);
  return run;
}
const validate = script(
  workflow.jobs.verify.steps,
  "Validate release tag against both version declarations",
);
const publish = script(
  workflow.jobs.publish.steps,
  "Publish verified assets (stable versions become Latest)",
);
async function run(command: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = Bun.spawn(command, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { out, err, code };
}

test("only verified tag pushes can publish, with write access isolated to publishing", () => {
  expect(workflow.permissions.contents).toBe("read");
  expect(workflow.jobs.publish.permissions.contents).toBe("write");
  expect(workflow.jobs.publish.needs).toBe("verify");
  expect(workflow.jobs.publish.if).toBe(
    "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')",
  );
  const upload = workflow.jobs.verify.steps.find((step) =>
    step.uses?.startsWith("actions/upload-artifact@"),
  );
  expect(upload?.with?.path.trim().split(/\r?\n/)).toEqual([
    "dist/*.zip",
    "dist/*.sha256",
    "dist/piko.exe",
    "install.ps1",
  ]);
});

test("tag validation accepts matching stable/prerelease versions and rejects mismatches", async () => {
  const folder = await mkdtemp(join(work, "tag-"));
  await mkdir(join(folder, "src"));
  for (const [tag, packageVersion, sourceVersion, accepted] of [
    ["v1.2.3", "1.2.3", "1.2.3", true],
    ["v1.2.3-beta.1", "1.2.3-beta.1", "1.2.3-beta.1", true],
    ["v1.2.4", "1.2.3", "1.2.3", false],
    ["v1.2.3", "1.2.3", "1.2.4", false],
    ["v1.2", "1.2", "1.2", false],
  ] as const) {
    await writeFile(
      join(folder, "package.json"),
      JSON.stringify({ version: packageVersion }),
    );
    await writeFile(
      join(folder, "src/version.ts"),
      `export const VERSION = "${sourceVersion}";\n`,
    );
    const result = await run(
      ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", validate],
      folder,
      { ...process.env, GITHUB_REF_NAME: tag },
    );
    expect(result.code === 0).toBe(accepted);
  }
}, 30000);

for (const tag of ["v1.2.3", "v1.2.3-beta.1"]) {
  test(`publishing ${tag} verifies checksums and selects the correct Latest policy without contacting GitHub`, async () => {
    const folder = await mkdtemp(join(work, "publish-"));
    await mkdir(join(folder, "dist"));
    const archive = `piko-${tag.slice(1)}-windows-x64.zip`;
    const payload = "release workflow test fixture";
    const hash = createHash("sha256").update(payload).digest("hex");
    await writeFile(join(folder, "dist", archive), payload);
    await writeFile(
      join(folder, "dist", archive + ".sha256"),
      `${hash}  ${archive}\n`,
    );
    await writeFile(join(folder, "dist", "piko.exe"), payload);
    await writeFile(
      join(folder, "dist", "piko.exe.sha256"),
      `${hash}  piko.exe\n`,
    );
    await writeFile(join(folder, "install.ps1"), "# bootstrap fixture\n");
    // A shell function intercepts gh; these tests cannot create remote releases.
    const command = [
      Bun.which("bash")!,
      "-c",
      `gh() { printf '%s\\n' "$@" > published-args.txt; }\n${publish}`,
    ];
    const env = {
      ...process.env,
      RELEASE_TAG: tag,
      GH_TOKEN: "test-not-a-token",
      GH_REPO: "fixture/piko",
    };
    const result = await run(command, folder, env);
    expect({ code: result.code, error: result.err }).toEqual({
      code: 0,
      error: "",
    });
    const args = (await readFile(join(folder, "published-args.txt"), "utf8"))
      .trim()
      .split(/\r?\n/);
    expect(args.slice(0, 3)).toEqual(["release", "create", tag]);
    expect(args).toContain("--verify-tag");
    expect(args.slice(-5)).toEqual([
      `dist/${archive}`,
      `dist/${archive}.sha256`,
      "dist/piko.exe",
      "dist/piko.exe.sha256",
      "install.ps1",
    ]);
    expect(args.includes("--latest")).toBe(!tag.includes("-"));
    expect(args.includes("--prerelease")).toBe(tag.includes("-"));
    expect(args.includes("--latest=false")).toBe(tag.includes("-"));

    await rm(join(folder, "published-args.txt"));
    await writeFile(join(folder, "dist", archive), "tampered archive");
    const rejected = await run(command, folder, env);
    expect(rejected.code).not.toBe(0);
    expect(await Bun.file(join(folder, "published-args.txt")).exists()).toBe(
      false,
    );
    await writeFile(join(folder, "dist", archive), payload);
    await writeFile(join(folder, "dist", "piko.exe"), "tampered executable");
    expect((await run(command, folder, env)).code).not.toBe(0);
    expect(await Bun.file(join(folder, "published-args.txt")).exists()).toBe(
      false,
    );
  }, 30000);
}
