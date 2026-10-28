import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

// Deliberately harmless lifecycle fixtures: write ONLY inside their package cwd.
// No public registry approval or third-party script is needed for acceptance.
export async function buildSandboxRegistry(
  destination: string,
  registry = "http://localhost:18765/registry/",
): Promise<void> {
  await mkdir(join(destination, "archives"), { recursive: true });
  const metadata: Record<string, any> = {};
  const add = async (
    pkg: Record<string, any>,
    files: Record<string, string>,
    filename: string,
  ) => {
    const bytes = await new Bun.Archive(
      {
        "package/package.json": JSON.stringify(pkg),
        ...Object.fromEntries(
          Object.entries(files).map(([path, value]) => [
            "package/" + path,
            value,
          ]),
        ),
      },
      { compress: "gzip" },
    ).bytes();
    await writeFile(join(destination, "archives", filename), bytes);
    const entry = {
      ...pkg,
      dist: {
        tarball: registry + "archives/" + filename,
        integrity:
          "sha512-" + createHash("sha512").update(bytes).digest("base64"),
      },
    };
    metadata[pkg.name] ??= {
      name: pkg.name,
      "dist-tags": { latest: pkg.version },
      versions: {},
    };
    metadata[pkg.name].versions[pkg.version] = entry;
    metadata[pkg.name]["dist-tags"].latest = pkg.version;
  };
  await add(
    {
      name: "piko-fixture-helper",
      version: "1.0.0",
      scripts: { postinstall: "node postinstall.cjs" },
    },
    {
      "postinstall.cjs":
        "require('fs').writeFileSync('dependency-generated.txt','dependency approved');",
    },
    "helper-1.0.0.tgz",
  );
  for (const version of ["1.0.0", "1.1.0"])
    await add(
      {
        name: "@piko-fixture/scripts",
        version,
        bin: { "piko-script-fixture": "cli.cjs" },
        dependencies: { "piko-fixture-helper": "1.0.0" },
        scripts: { postinstall: "node postinstall.cjs" },
      },
      {
        "cli.cjs":
          "#!/usr/bin/env node\nconsole.log(require('./package.json').version);",
        "postinstall.cjs":
          "const fs=require('fs');fs.writeFileSync('generated.txt','approved build');if(process.env.PIKO_FIXTURE_FAIL){fs.writeFileSync('cli.cjs','broken');process.exit(23)}",
      },
      "scripts-" + version + ".tgz",
    );
  await writeFile(join(destination, "metadata.json"), JSON.stringify(metadata));
}
