import { AsyncLocalStorage } from "node:async_hooks";

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
export const cleanText = (text: string) =>
  text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "?");
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
  private frame = 0;
  private last = -Infinity;
  private started = 0;
  private clock: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private seen = false;
  constructor(
    private readonly options: {
      write: (text: string) => void;
      tty: boolean;
      color: boolean;
      columns?: number;
      verbose?: boolean;
      now?: () => number;
    },
  ) {}
  private now() {
    return this.options.now?.() ?? performance.now();
  }
  private color(value: string, code: number) {
    return this.options.color ? `\x1b[${code}m${value}\x1b[0m` : value;
  }
  private line(text: string) {
    // Stay within one physical row, including wide characters on Windows.
    const limit = Math.max(8, (this.options.columns ?? 100) - 2);
    let width = 0,
      result = "";
    for (const char of cleanText(text)) {
      const size = char.codePointAt(0)! > 0x2ff ? 2 : 1;
      if (width + size > limit - 3) {
        result += "...";
        break;
      }
      result += char;
      width += size;
    }
    this.options.write("\r\x1b[2K" + this.color(result, 36));
  }
  private finishStage() {
    if (!this.options.verbose || !this.options.tty || !this.active) return;
    this.options.write(
      "\r\x1b[2K" +
        this.color(`  + ${this.active}`, 32) +
        `  ${((this.now() - this.started) / 1000).toFixed(1)}s\n`,
    );
  }
  private draw(force = false) {
    if (!this.active) return;
    const now = this.now();
    if (!force && now - this.last < 100) return;
    this.last = now;
    if (this.options.tty)
      this.line(
        `${["|", "/", "-", "\\"][this.frame++ % 4]} ${this.item}${this.active}${this.detail ? "  " + this.detail : ""}`,
      );
  }
  readonly event = (event: ProgressEvent) => {
    if (this.closed) return;
    this.seen = true;
    if (event.kind === "stage") {
      if (
        !this.options.verbose &&
        ![
          "Download",
          "Extract archive",
          "Commit installation",
          "Switch selected version",
        ].includes(event.label)
      ) {
        if (this.options.tty && this.active) this.options.write("\r\x1b[2K");
        this.active = "";
        return;
      }
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
    } else if (event.kind === "result") {
      if (this.options.tty) {
        if (!event.failed) this.finishStage();
        this.options.write("\r\x1b[2K");
      }
      if (this.options.verbose)
        this.options.write(
          this.color(
            `  ${event.failed ? "!" : "+"} ${cleanText(event.label)}`,
            event.failed ? 31 : 32,
          ) + "\n",
        );
      this.active = "";
    } else {
      const seconds = Math.max(0.001, (this.now() - this.started) / 1000);
      const speed = event.received / seconds;
      const total =
        event.total && event.total >= event.received ? event.total : undefined;
      const percent = total
        ? Math.min(
            event.complete && event.received === total ? 100 : 99,
            Math.floor((event.received / total) * 100),
          )
        : undefined;
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
    if (success) this.finishStage();
    if (this.options.tty) this.options.write("\r\x1b[2K");
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
