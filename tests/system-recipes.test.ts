import { expect, test } from "bun:test";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { powershellExecutable } from "../src/windows.ts";
import { capture, exists } from "../src/util.ts";

test.skipIf(
  !(await exists(
    join(
      import.meta.dir,
      "../../piko-source/packages/tortoise-svn/1.14.9.29743.json",
    ),
  )),
)(
  "shipped system recipes parse as PowerShell and require explicit ownership instead of Scoop takeover",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "piko-system-source-"));
    try {
      for (const [name, version] of [
        ["flclash", "0.9.2"],
        ["tortoise-svn", "1.14.9.29743"],
      ]) {
        const m = JSON.parse(
          await readFile(
            join(
              import.meta.dir,
              "../../piko-source/packages",
              name!,
              version + ".json",
            ),
            "utf8",
          ),
        );
        const p = m.platforms["windows-x64"],
          body = p.configFiles[p.admin.install.path];
        expect(body).toContain("ownership");
        const path = join(dir, name + ".ps1");
        await writeFile(path, body);
        const out = await capture(
          powershellExecutable(),
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$tokens=$null;$errors=$null;$null=[Management.Automation.Language.Parser]::ParseFile($env:PIKO_TEST_SCRIPT,[ref]$tokens,[ref]$errors);if($errors.Count){throw ($errors|Out-String)};'syntax-ok'",
          ],
          { env: { ...process.env, PIKO_TEST_SCRIPT: path } },
        );
        expect(out).toBe("syntax-ok");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
