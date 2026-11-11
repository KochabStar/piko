import { AsyncLocalStorage } from "node:async_hooks";
import {
  activityLine,
  plainText,
  symbol,
  tint,
  type TerminalStyle,
} from "./terminal-style.ts";

export type ProgressEvent =
  | { kind: "stage"; label: string; detail?: string }
  | { kind: "download"; received: number; total?: number; complete?: boolean }
  | { kind: "item"; package: string; index: number; total: number }
  | { kind: "result"; label: string; failed?: boolean };
const context = new AsyncLocalStorage<(event: ProgressEvent) => void>();
export function progressSink(): (event: ProgressEvent) => void {
  return context.getStore() ?? (() => {});
}
export function report(event: ProgressEvent): void {
  context.getStore()?.(event);
}
export function withProgress<T>(
  listener: (event: ProgressEvent) => void,
  fn: () => Promise<T>,
): Promise<T> {
  return context.run(listener, fn);
}
export const cleanText = plainText;
export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = Math.max(0, bytes),
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}
export class ProgressRenderer {
  private active = "";
  private detail = "";
  private item = "";
  private packageName = "";
  private position = "";
  private transfer:
    | { percent?: number; transferred: string; speed: string; eta?: string }
    | undefined;
  private frame = 0;
  private last = -Infinity;
  private started = 0;
  private lastLabel = "";
  // Recent (time, received) samples for a windowed transfer speed. The
  // whole-run average keeps falling as a long download progresses and makes
  // healthy transfers look slower and slower; the window shows what happens
  // now and keeps the ETA honest.
  private samples: { at: number; received: number }[] = [];
  // Transfers render two rows (identity + transfer detail); remember that so
  // redraws and the final clear also erase the second row.
  private multiRow = false;
  private clock: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private seen = false;
  constructor(
    private readonly options: {
      write: (text: string) => void;
      tty: boolean;
      color: boolean;
      columns?: number;
      getColumns?: () => number;
      unicode?: boolean;
      trueColor?: boolean;
      verbose?: boolean;
      now?: () => number;
      // Windows Terminal / ConEmu consume OSC 9;4 (taskbar progress) and
      // OSC 9;9 (toast) sequences; other terminals discard them. Only emit
      // them where they are known to work, gated by WT_SESSION.
      taskbar?: boolean;
    },
  ) {}
  private now() {
    return this.options.now?.() ?? performance.now();
  }
  private style(): TerminalStyle {
    return {
      color: this.options.color,
      unicode: this.options.unicode ?? true,
      trueColor: this.options.trueColor,
    };
  }
  private color(value: string, code: number) {
    return tint(value, code === 31 ? "error" : "success", this.style());
  }
  private finishStage(clear = "\r\x1b[2K"): boolean {
    if (!this.options.verbose || !this.options.tty || !this.active)
      return false;
    this.options.write(
      clear +
        this.color(
          `  ${symbol("success", this.style().unicode)} ${this.active}`,
          32,
        ) +
        `  ${((this.now() - this.started) / 1000).toFixed(1)}s\n`,
    );
    return true;
  }
  private erase(): string {
    const clear = this.multiRow ? "\r\x1b[2K\x1b[1A\r\x1b[2K" : "\r\x1b[2K";
    this.multiRow = false;
    return clear;
  }
  private draw(force = false) {
    if (!this.active) return;
    const now = this.now();
    if (!force && now - this.last < 100) return;
    this.last = now;
    if (this.options.tty) {
      const stage =
        {
          "Refresh source": "Refreshing source",
          "Load manifest": "Loading manifest",
          "Check available updates": "Checking updates",
          "Resolve update candidate": "Checking version",
          "Extract archive": "Extracting",
          "Commit installation": "Installing",
          "Switch selected version": "Selecting",
        }[this.active] ?? this.active;
      const line = activityLine(
        {
          stage,
          package: this.packageName,
          position: this.position,
          detail: this.detail,
          ...this.transfer,
          frame: this.frame++,
        },
        Math.max(
          1,
          (this.options.getColumns?.() ?? this.options.columns ?? 100) - 1,
        ),
        this.style(),
      );
      const clear = this.erase();
      this.multiRow = line.includes("\n");
      this.options.write(
        clear +
          line +
          (this.options.taskbar && this.transfer?.percent !== undefined
            ? `\x1b]9;4;1;${this.transfer.percent}\x07`
            : ""),
      );
    }
  }
  readonly event = (event: ProgressEvent) => {
    if (this.closed) return;
    this.seen = true;
    if (event.kind === "stage") {
      if (event.label === "Resolve package" && !this.position)
        this.packageName = cleanText(event.detail ?? "");
      this.transfer = undefined;
      this.samples = [];
      this.finishStage();
      this.active = cleanText(event.label);
      this.detail = cleanText(event.detail ?? "");
      this.started = this.now();
      this.last = -Infinity;
      if (this.options.tty) {
        if (!this.clock) {
          this.clock = setInterval(() => this.draw(), 120);
          this.clock.unref();
        }
        this.draw(true);
      } else if (this.options.verbose || this.active === "Download")
        this.options.write(
          `  > ${this.options.verbose ? this.item : ""}${this.active}${this.options.verbose && this.detail ? "  " + this.detail : ""}\n`,
        );
    } else if (event.kind === "item") {
      this.item = `[${event.index}/${event.total}] ${cleanText(event.package)}  `;
      this.position = `${event.index}/${event.total}`;
      this.packageName = cleanText(event.package);
    } else if (event.kind === "result") {
      this.lastLabel = cleanText(event.label);
      if (this.options.tty) {
        const clear = this.erase();
        if (!event.failed) this.finishStage(clear);
        else this.options.write(clear);
      }
      if (this.options.verbose)
        this.options.write(
          this.color(
            `  ${symbol(event.failed ? "error" : "success", this.style().unicode)} ${cleanText(event.label)}`,
            event.failed ? 31 : 32,
          ) + "\n",
        );
      this.active = "";
    } else {
      const now = this.now();
      this.samples.push({ at: now, received: event.received });
      while (this.samples.length > 2 && now - this.samples[0]!.at > 3000)
        this.samples.shift();
      const window = this.samples;
      const elapsed = (window.at(-1)!.at - window[0]!.at) / 1000;
      const speed =
        window.length > 1 && elapsed >= 0.5
          ? (window.at(-1)!.received - window[0]!.received) / elapsed
          : event.received / Math.max(0.001, (now - this.started) / 1000);
      const total =
        event.total && event.total >= event.received ? event.total : undefined;
      const percent = total
        ? Math.min(
            event.complete && event.received === total ? 100 : 99,
            Math.floor((event.received / total) * 100),
          )
        : undefined;
      this.transfer = {
        percent,
        transferred: `${formatBytes(event.received)}${total ? " / " + formatBytes(total) : ""}`,
        speed: `${formatBytes(speed)}/s`,
        eta:
          total && speed > 0 && !event.complete
            ? `ETA ${Math.ceil((total - event.received) / speed)}s`
            : undefined,
      };
      const bar =
        percent === undefined
          ? ""
          : `[${"=".repeat(Math.floor(percent / 10))}${"-".repeat(10 - Math.floor(percent / 10))}] ${percent}%  `;
      this.detail = `${bar}${formatBytes(event.received)}${total ? " / " + formatBytes(total) : ""}  ${formatBytes(speed)}/s${total && speed > 0 && !event.complete ? "  ETA " + Math.ceil((total - event.received) / speed) + "s" : ""}`;
      if (this.options.tty) this.draw(!!event.complete);
      else if (
        event.complete ||
        (this.options.verbose && this.now() - this.last >= 2000)
      ) {
        this.last = this.now();
        this.options.write(`    ${this.detail}\n`);
      }
    }
  };
  close(success: boolean) {
    if (this.closed) return;
    this.closed = true;
    if (this.clock) clearInterval(this.clock);
    if (!this.seen) return;
    if (this.options.taskbar) {
      // Clear the taskbar indicator and toast the outcome so a long download
      // can finish while the user works in another window.
      this.options.write("\x1b]9;4;0;\x07");
      if (this.lastLabel)
        this.options.write(
          `\x1b]9;9;Piko: ${this.lastLabel}${success ? "" : " (failed)"}\x07`,
        );
    }
    const clear = this.erase();
    if (success && !this.finishStage(clear) && this.options.tty)
      this.options.write(clear);
    else if (!success && this.options.tty) this.options.write(clear);
    if (this.options.verbose)
      this.options.write(
        this.color(
          success ? "  + Completed" : "  ! Failed; see error details below",
          success ? 32 : 31,
        ) + "\n",
      );
  }
}

// Count unique relayed byte ranges. aria2 can retry or overlap a range; those
// bytes must not falsely increase the downloaded percentage.
export class TransferRanges {
  private ranges: [number, number][] = [];
  add(start: number, size: number): number {
    let a = start,
      b = start + size;
    const merged: [number, number][] = [];
    for (const [x, y] of this.ranges) {
      if (y < a) merged.push([x, y]);
      else if (b < x) {
        merged.push([a, b]);
        a = x;
        b = y;
      } else {
        a = Math.min(a, x);
        b = Math.max(b, y);
      }
    }
    merged.push([a, b]);
    this.ranges = merged;
    return merged.reduce((n, [x, y]) => n + y - x, 0);
  }
}
