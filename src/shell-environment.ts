import { join } from "node:path";
import { selectedEnvironment } from "./environment.ts";
import { psQuote } from "./profiles.ts";
import { fail } from "./util.ts";
import type { State } from "./types.ts";

// Environment export is inert text, separate from package initializer approval.
export function shellEnvironment(
  root: string,
  state: State,
  shell: string,
  path = process.env.PATH ?? process.env.Path ?? "",
) {
  const environment = {
    ...selectedEnvironment(root, state),
    PIKO_HOME: root,
    PATH: join(root, "shims") + ";" + path,
  };
  if (shell === "json") return JSON.stringify(environment, null, 2);
  return Object.entries(environment)
    .map(([name, value]) => {
      if (shell === "powershell" || shell === "pwsh")
        return "$env:" + name + " = " + psQuote(value);
      if (shell === "bash") {
        if (name === "PATH")
          return (
            "export PATH=" +
            quote(
              join(root, "shims")
                .replaceAll("\\", "/")
                .replace(
                  /^([a-z]):/i,
                  (_, drive: string) => "/" + drive.toLowerCase(),
                ),
            ) +
            ':"$PATH"'
          );
        return "export " + name + "=" + quote(value);
      }
      if (shell === "cmd") {
        if (/[\r\n%!"\x00]/.test(value))
          fail(
            "CMD export cannot safely represent %, !, quotes or line breaks; use PowerShell/Bash/JSON",
          );
        return '@set "' + name + "=" + value + '"';
      }
      return fail("Choose --shell powershell|pwsh|cmd|bash|json");
    })
    .join(shell === "bash" ? "\n" : "\r\n");
}
function quote(value: string) {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}
