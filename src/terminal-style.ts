// Piko's terminal palette: use the terminal background, not a hardcoded dark
// panel. ANSI colors are the fallback; RGB accents are used only when supported.
export type Tone =
  | "accent"
  | "blue"
  | "purple"
  | "cyan"
  | "muted"
  | "success"
  | "error"
  | "warning"
  | "strong";
export type TerminalStyle = {
  color: boolean;
  unicode?: boolean;
  trueColor?: boolean;
};
const palette: Record<Exclude<Tone, "strong">, [number, string]> = {
  accent: [94, "168;199;250"],
  blue: [94, "168;199;250"],
  purple: [95, "197;138;249"],
  cyan: [96, "140;233;255"],
  muted: [90, "154;160;166"],
  success: [92, "129;201;149"],
  error: [91, "242;139;130"],
  warning: [93, "253;214;99"],
};
export const plainText = (text: string) =>
  text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "?");
export function tint(text: string, tone: Tone, style: TerminalStyle): string {
  if (!style.color || !text) return text;
  if (tone === "strong") return `\x1b[1m${tint(text, "blue", style)}\x1b[22m`;
  const [ansi, rgb] = palette[tone];
  return `\x1b[${style.trueColor ? "38;2;" + rgb : ansi}m${text}\x1b[39m`;
}
export function symbol(
  kind: "success" | "error" | "download" | "separator",
  unicode = true,
): string {
  return unicode
    ? { success: "✓", error: "✕", download: "↓", separator: "·" }[kind]
    : { success: "+", error: "!", download: "v", separator: "|" }[kind];
}
export function cellWidth(char: string): number {
  const n = char.codePointAt(0)!;
  if (/\p{Mark}/u.test(char) || n === 0x200d || n === 0xfe0f) return 0;
  return n >= 0x1100 &&
    (n <= 0x115f ||
      n === 0x2329 ||
      n === 0x232a ||
      (n >= 0x2e80 && n <= 0xa4cf && n !== 0x303f) ||
      (n >= 0xac00 && n <= 0xd7a3) ||
      (n >= 0xf900 && n <= 0xfaff) ||
      (n >= 0xfe10 && n <= 0xfe19) ||
      (n >= 0xfe30 && n <= 0xfe6f) ||
      (n >= 0xff00 && n <= 0xff60) ||
      (n >= 0xffe0 && n <= 0xffe6) ||
      (n >= 0x1f300 && n <= 0x1faff) ||
      (n >= 0x20000 && n <= 0x3ffff))
    ? 2
    : 1;
}
export function textWidth(text: string): number {
  return Array.from(text).reduce((n, char) => n + cellWidth(char), 0);
}
export function fitText(text: string, width: number): string {
  const safe = plainText(text),
    limit = Math.max(0, width);
  if (textWidth(safe) <= limit) return safe;
  if (limit <= 3) return ".".repeat(limit);
  let out = "",
    used = 0;
  for (const char of safe) {
    const size = cellWidth(char);
    if (used + size > limit - 3) break;
    out += char;
    used += size;
  }
  return out + "...";
}
// Keep the gradient inside the blue/purple/cyan family, rather than coloring
// every field. Foreground-only RGB preserves the user's terminal background.
export function accentGradient(text: string, style: TerminalStyle): string {
  if (!style.color) return text;
  const chars = Array.from(text);
  const stops = [palette.purple[1], palette.blue[1], palette.cyan[1]].map((s) =>
    s.split(";").map(Number),
  );
  return chars
    .map((char, index) => {
      const t = chars.length <= 1 ? 0 : (index / (chars.length - 1)) * 2;
      const segment = Math.min(1, Math.floor(t)),
        fraction = t - segment;
      const rgb = stops[segment]!.map((value, channel) =>
        Math.round(value + (stops[segment + 1]![channel]! - value) * fraction),
      );
      if (style.trueColor) return `\x1b[38;2;${rgb.join(";")}m${char}\x1b[39m`;
      return tint(
        char,
        (["purple", "blue", "cyan"] as const)[Math.min(2, Math.round(t))]!,
        style,
      );
    })
    .join("");
}

export function progressBar(
  percent: number,
  width: number,
  style: TerminalStyle,
): string {
  const count = Math.max(0, width),
    value = Math.max(0, Math.min(100, percent));
  const filled = Math.floor((value / 100) * count);
  const head = value > 0 && value < 100 && filled < count;
  const solid = style.unicode !== false ? "━" : "=";
  const empty = style.unicode !== false ? "─" : "-";
  const cursor = style.unicode !== false ? "╸" : ">";
  let out = accentGradient(solid.repeat(filled), style);
  if (head) out += tint(cursor, "cyan", style);
  return (
    out +
    tint(
      empty.repeat(Math.max(0, count - filled - Number(head))),
      "muted",
      style,
    )
  );
}
export type ActivityView = {
  stage: string;
  package?: string;
  position?: string;
  detail?: string;
  percent?: number;
  transferred?: string;
  speed?: string;
  eta?: string;
  frame: number;
};
export function activityLine(
  view: ActivityView,
  width: number,
  style: TerminalStyle,
): string {
  const limit = Math.max(1, Math.floor(width));
  const state: ActivityView = {
    ...view,
    stage: plainText(view.stage),
    package: plainText(view.package ?? ""),
    position: plainText(view.position ?? ""),
    detail: plainText(view.detail ?? ""),
  };
  const progress = state.transferred !== undefined;
  const pct = state.percent === undefined ? "" : `${state.percent}%`;
  const sep = symbol("separator", style.unicode !== false);
  type Part = { text: string; tone?: Tone; raw?: string };
  const parts: Part[] = [{ text: "*", raw: spinner(state.frame, style) }];
  if (state.position && limit >= 100)
    parts.push({ text: state.position, tone: "muted" });
  const packageLimit =
    limit < 50
      ? Math.max(5, Math.floor(limit / 3))
      : Math.min(30, Math.floor(limit / 3));
  if (state.package)
    parts.push({ text: fitText(state.package, packageLimit), tone: "strong" });
  if (!progress || limit >= 90)
    parts.push({
      text: fitText(state.stage, Math.max(4, Math.min(24, limit / 3))),
      tone: "accent",
    });
  if (progress) {
    if (pct) {
      const barWidth =
        limit >= 110 ? 18 : limit >= 75 ? 12 : limit >= 45 ? 8 : 0;
      if (barWidth)
        parts.push({
          text: "-".repeat(barWidth),
          raw: progressBar(state.percent!, barWidth, style),
        });
      parts.push({ text: pct, tone: "cyan" });
    }
    if (limit >= 105 || !pct)
      parts.push({ text: plainText(state.transferred!), tone: "muted" });
    if (state.speed && limit >= 60)
      parts.push({ text: plainText(state.speed), tone: "muted" });
    if (state.eta && pct && limit >= 120)
      parts.push({ text: `${sep} ${plainText(state.eta)}`, tone: "muted" });
  } else if (state.detail && limit >= 60)
    parts.push({
      text: fitText(state.detail, Math.floor(limit / 3)),
      tone: "muted",
    });
  const indent = limit >= 24 ? "  " : "";
  let used = textWidth(indent),
    out = indent;
  for (const part of parts) {
    const gap = used > textWidth(indent) ? "  " : "";
    const remaining = limit - used - gap.length;
    if (remaining <= 0) break;
    const text = fitText(part.text, remaining);
    out +=
      gap +
      (text === part.text && part.raw !== undefined
        ? part.raw
        : tint(text, part.tone ?? "muted", style));
    used += gap.length + textWidth(text);
  }
  return out;
}

export function spinner(frame: number, style: TerminalStyle): string {
  const frames =
    style.unicode === false
      ? ["|", "/", "-", "\\"]
      : ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const tones: Tone[] = ["purple", "blue", "cyan", "blue"];
  return tint(
    frames[frame % frames.length]!,
    tones[Math.floor(frame / 3) % tones.length]!,
    style,
  );
}
