import { expect, test } from "bun:test";
import {
  activityLine,
  accentGradient,
  fitText,
  progressBar,
  textWidth,
  tint,
} from "../src/terminal-style.ts";
import { humanOutput, table } from "../src/display.ts";
import { ProgressRenderer } from "../src/progress.ts";

const strip = (text: string) =>
  text.replace(/\x1b\[[0-9;]*[mKG]/g, "").replace(/\r/g, "");
const view = {
  stage: "Download",
  package: "main/llvm",
  position: "2/3",
  percent: 42,
  transferred: "42.0 MiB / 100.0 MiB",
  speed: "10.0 MiB/s",
  eta: "ETA 6s",
  frame: 2,
};

test("Gemini-inspired activity uses a dot spinner, thin bar and semantic blue/purple accents", () => {
  const plain = activityLine(view, 140, { color: false, unicode: true });
  expect(plain).toBe(
    "  ⠹  2/3  main/llvm  Download  ━━━━━━━╸──────────  42%  42.0 MiB / 100.0 MiB  10.0 MiB/s  · ETA 6s",
  );
  const rgb = activityLine(view, 140, {
    color: true,
    unicode: true,
    trueColor: true,
  });
  expect(rgb).toContain("\x1b[38;2;197;138;249m");
  expect(rgb).toContain("\x1b[38;2;168;199;250m");
  expect(rgb).toContain(
    "\x1b[1m\x1b[38;2;168;199;250mmain/llvm\x1b[39m\x1b[22m",
  );
  expect(strip(rgb)).toBe(plain);
  const ansi = activityLine(view, 140, { color: true });
  expect(ansi).not.toContain("38;2;");
  expect(ansi).toContain("\x1b[95m");
  expect(strip(ansi)).toBe(plain);
  expect(plain).not.toContain("\x1b");
});

test("color hierarchy accents names and versions without changing table layout", () => {
  const gradient = accentGradient("abc", { color: true, trueColor: true });
  expect(gradient).toContain("\x1b[38;2;197;138;249ma");
  expect(gradient).toContain("\x1b[38;2;168;199;250mb");
  expect(gradient).toContain("\x1b[38;2;140;233;255mc");
  expect(strip(gradient)).toBe("abc");
  expect(accentGradient("abc", { color: false })).toBe("abc");
  const plain = table(
    ["PACKAGE", "VERSION", "SELECTED", "VERIFIED"],
    [
      ["main/tool", "2.0.0", "*", "yes"],
      ["main/other", "1.0.0", "-", "no"],
    ],
  );
  const colored = humanOutput(plain, true, { trueColor: true });
  expect(strip(colored)).toBe(plain);
  expect(colored).toContain("\x1b[38;2;168;199;250mmain/tool");
  expect(colored).toContain("\x1b[38;2;197;138;249m2.0.0");
  expect(colored).toContain("\x1b[38;2;129;201;149myes");
  expect(colored).not.toContain("\x1b[48;");
  expect(humanOutput(plain, false)).toBe(plain);
});

test("live layout stays within one row at narrow widths, with CJK, emoji and terminal resize", () => {
  for (const width of [1, 2, 8, 20, 40, 60, 80, 100, 120, 140]) {
    for (const color of [false, true]) {
      const out = activityLine(
        { ...view, package: "main/中文软件-🔧-a-very-long-name" },
        width,
        { color, unicode: true },
      );
      expect(textWidth(strip(out))).toBeLessThanOrEqual(width);
      expect(strip(out)).not.toContain("\n");
    }
  }
  expect(textWidth("e\u0301中文⠹━")).toBe(7);
  expect(fitText("中文中文", 5)).toBe("中...");
  expect(fitText("中文", 1)).toBe(".");
  expect(
    table(
      ["A", "B"],
      [
        ["中文", "v"],
        ["x", "w"],
      ],
    ),
  ).toBe("A     B\n中文  v\nx     w");
  let columns = 140,
    output = "",
    now = 0;
  const ui = new ProgressRenderer({
    write: (s) => {
      output = s;
    },
    tty: true,
    color: true,
    getColumns: () => columns,
    now: () => now,
  });
  try {
    ui.event({ kind: "item", package: "main/中文软件", index: 1, total: 3 });
    ui.event({ kind: "stage", label: "Download" });
    now = 1000;
    ui.event({ kind: "download", received: 42, total: 100 });
    expect(strip(output)).toContain("42%");
    columns = 32;
    now = 2000;
    ui.event({ kind: "download", received: 50, total: 100 });
    expect(textWidth(strip(output))).toBeLessThanOrEqual(31);
    expect(output).not.toContain("\n");
  } finally {
    ui.close(true);
  }
});

test("unknown totals remain indeterminate and ASCII fallback retains useful progress", () => {
  const unknown = activityLine(
    { ...view, percent: undefined, transferred: "42.0 MiB" },
    120,
    { color: true },
  );
  expect(strip(unknown)).toContain("42.0 MiB");
  expect(strip(unknown)).not.toContain("%");
  expect(strip(unknown)).not.toContain("ETA");
  const ascii = activityLine(view, 140, { color: false, unicode: false });
  expect(ascii).toMatch(/^[\x20-\x7e]+$/);
  expect(ascii).toContain("42%");
  expect(ascii).toContain("10.0 MiB/s");
  expect(strip(progressBar(0, 10, { color: true }))).toBe("──────────");
  expect(strip(progressBar(100, 10, { color: true }))).toBe("━━━━━━━━━━");
});

test("visual decoration cannot inject terminal commands; no-color output and JSON stay literal", () => {
  const unsafe = activityLine(
    { ...view, package: "main/\x1b[2J\nunsafe", speed: "10\rB/s" },
    140,
    { color: false },
  );
  expect(unsafe).not.toMatch(/[\x00-\x1f]/);
  const literal = "All packages are up to date.";
  expect(humanOutput(literal, false)).toBe(literal);
  expect(strip(humanOutput(literal, true))).toBe(
    "✓  All packages are up to date.",
  );
  expect(strip(humanOutput("main/tool (2): updated", true))).toBe(
    "✓  main/tool (2)  updated",
  );
  expect(
    strip(humanOutput("main/tool (2): failed - missing approval", true)),
  ).toBe("✕  main/tool (2)  failed - missing approval");
  expect(strip(humanOutput(literal, true, { unicode: false }))).toBe(
    "+  All packages are up to date.",
  );
  const json = '{"version":"2","status":"updated"}';
  expect(humanOutput(json, false)).toBe(json);
  expect(tint("value", "muted", { color: false })).toBe("value");
});
