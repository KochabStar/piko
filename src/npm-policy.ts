import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { capture, exists, fail, noLinks } from "./util.ts";
import type { npmContext } from "./npm.ts";

// Probe the actual npm executable, using only Piko's own harmless fixture scripts.
// Never infer script-policy enforcement from a version string or config output.
export async function verifyNpmPolicy(
  context: Awaited<ReturnType<typeof npmContext>>,
  control: string,
) {
  await noLinks(control);
  const dir = await mkdtemp(join(control, "npm-policy-"));
  try {
    const packages: Record<string, unknown> = {
      "": {
        name: "piko-policy-probe",
        version: "1.0.0",
        dependencies: { allowed: "1.0.0", denied: "1.0.0" },
      },
    };
    for (const name of ["allowed", "denied"]) {
      const path = join(dir, "node_modules", name);
      await mkdir(path, { recursive: true });
      await writeFile(
        join(path, "package.json"),
        JSON.stringify({
          name,
          version: "1.0.0",
          scripts: {
            postinstall:
              "node -e \"require('fs').writeFileSync('marker','ok')\"",
          },
        }),
      );
      packages["node_modules/" + name] = {
        version: "1.0.0",
        resolved: "https://piko-policy.invalid/" + name + ".tgz",
        hasInstallScript: true,
      };
    }
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "piko-policy-probe",
        version: "1.0.0",
        private: true,
        dependencies: { allowed: "1.0.0", denied: "1.0.0" },
        allowScripts: {
          "https://piko-policy.invalid/allowed.tgz": true,
          "https://piko-policy.invalid/denied.tgz": false,
        },
      }),
    );
    await writeFile(
      join(dir, "package-lock.json"),
      JSON.stringify({
        name: "piko-policy-probe",
        version: "1.0.0",
        lockfileVersion: 3,
        packages,
      }),
    );
    const config = join(dir, "empty.npmrc");
    await writeFile(config, "");
    const globalConfig = join(dir, "global.npmrc");
    await writeFile(globalConfig, "");
    await capture(
      context.node,
      [
        context.npm,
        "rebuild",
        "--prefix=" + dir,
        "--global=false",
        "--workspaces=false",
        "--strict-allow-scripts=true",
        "--ignore-scripts=false",
        "--dangerously-allow-all-scripts=false",
        "--bin-links=false",
        "--rebuild-bundle=false",
        "--offline=true",
        "--no-audit",
        "--no-fund",
        "--update-notifier=false",
        "--userconfig=" + config,
        "--globalconfig=" + globalConfig,
        "--script-shell=" +
          join(process.env.SystemRoot ?? "C:\\Windows", "System32/cmd.exe"),
      ],
      { cwd: dir, env: context.env },
    );
    if (
      !(await exists(join(dir, "node_modules/allowed/marker"))) ||
      (await exists(join(dir, "node_modules/denied/marker")))
    )
      fail(
        "npm failed script-policy enforcement probe; package scripts were not executed",
      );
  } finally {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}
