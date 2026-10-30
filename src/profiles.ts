import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  atomicJson,
  exists,
  fail,
  json,
  noLinks,
  record,
  sha256,
} from "./util.ts";
import type { ProfileIntegration, State } from "./types.ts";

export const profileJournal = (root: string) =>
  join(root, "operations", "profile.json");
export function profileKey(path: string): string {
  return sha256(resolve(path).toLowerCase());
}
export function profileMarkers(root: string) {
  const id = sha256(resolve(root).toLowerCase()).slice(0, 16);
  return { start: `# >>> piko ${id} >>>`, end: `# <<< piko ${id} <<<` };
}
export function psQuote(value: string): string {
  // PowerShell 5.1 reads BOM-less Profiles using the active ANSI code page.
  // Keep generated path expressions ASCII even when the real path is Unicode.
  if (/[^\x20-\x7e]/.test(value))
    return `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value, "utf8").toString("base64")}')))`;
  return "'" + value.replaceAll("'", "''") + "'";
}
export async function profileBytes(path: string): Promise<Buffer | null> {
  if (!isAbsolute(path)) fail("Profile path must be absolute");
  await noLinks(path);
  if (!(await exists(path))) return null;
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024)
    fail("Profile must be an unlinked regular file of at most 1 MiB");
  return await readFile(path);
}
function decode(bytes: Buffer | null) {
  if (!bytes)
    return { text: "", encoding: "utf8" as const, bom: Buffer.alloc(0) };
  if (bytes[0] === 255 && bytes[1] === 254) {
    if (bytes.length % 2) fail("Invalid UTF-16LE Profile");
    return {
      text: bytes.subarray(2).toString("utf16le"),
      encoding: "utf16le" as const,
      bom: bytes.subarray(0, 2),
    };
  }
  const bom = bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]))
    ? bytes.subarray(0, 3)
    : Buffer.alloc(0);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(bom.length),
    );
  } catch {
    fail(
      "Profile encoding must be UTF-8 or UTF-16LE; convert explicitly first",
    );
  }
  return { text, encoding: "utf8" as const, bom };
}
export function profileEol(bytes: Buffer | null): string {
  return decode(bytes).text.includes("\r\n") ? "\r\n" : "\n";
}
export function editProfile(
  root: string,
  bytes: Buffer | null,
  previous: string | undefined,
  block: string | undefined,
): Buffer {
  const decoded = decode(bytes),
    { start, end } = profileMarkers(root);
  let text = decoded.text;
  if (previous) {
    if (
      text.split(start).length !== 2 ||
      text.split(end).length !== 2 ||
      text.split(previous).length !== 2
    )
      fail("Managed Profile block changed; inspect manually");
    text = text.replace(previous, block ?? "");
  } else if (block) {
    if (text.includes(start) || text.includes(end))
      fail("Untracked Piko Profile block; inspect manually");
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    text += (text && !text.endsWith("\n") ? eol : "") + block;
  }
  return Buffer.concat([decoded.bom, Buffer.from(text, decoded.encoding)]);
}
function sameBytes(a: Buffer | null, b: Buffer | null): boolean {
  return a === null ? b === null : b !== null && a.equals(b);
}
export async function replaceProfile(
  path: string,
  expected: Buffer | null,
  next: Buffer | null,
): Promise<void> {
  if (!sameBytes(await profileBytes(path), expected))
    fail("Profile changed after preview; refusing to overwrite");
  if (sameBytes(expected, next)) return;
  if (next === null) {
    await rm(path);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await noLinks(temp);
    await writeFile(temp, next, { flag: "wx" });
    if (!sameBytes(await profileBytes(path), expected))
      fail("Profile changed during write; refusing to overwrite");
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

type ProfileChange = {
  path: string;
  beforeRevision: number;
  before: string | null;
  after: string;
  beforeProfile: ProfileIntegration | null;
  afterProfile: ProfileIntegration | null;
};
function validateProfileChange(root: string, value: unknown) {
  if (
    !record(value) ||
    typeof value.path !== "string" ||
    !isAbsolute(value.path) ||
    resolve(value.path) !== value.path ||
    !Number.isSafeInteger(value.beforeRevision) ||
    value.beforeRevision < 0 ||
    !(value.before === null || typeof value.before === "string") ||
    typeof value.after !== "string"
  )
    fail("Invalid Profile recovery journal");
  const entry = value as ProfileChange;
  const decodeBytes = (value: string): Buffer => {
    const bytes = Buffer.from(value, "base64");
    if (bytes.length > 1024 * 1024 || bytes.toString("base64") !== value)
      fail("Invalid Profile recovery bytes");
    return bytes;
  };
  const markers = profileMarkers(root);
  for (const profile of [entry.beforeProfile, entry.afterProfile]) {
    if (profile === null) continue;
    if (
      !record(profile) ||
      profile.path !== entry.path ||
      (profile.shell !== undefined &&
        !["powershell", "bash"].includes(profile.shell)) ||
      typeof profile.block !== "string" ||
      profile.block.length > 16384 ||
      !record(profile.approvals) ||
      !profile.block.startsWith(markers.start) ||
      !profile.block.endsWith(markers.end)
    )
      fail("Invalid Profile recovery ownership");
    for (const [key, approval] of Object.entries(profile.approvals))
      if (
        !/^[a-z0-9._-]+--[a-f0-9]{16}$/.test(key) ||
        !record(approval) ||
        typeof approval.binding !== "string" ||
        !/^[a-f0-9]{64}$/.test(approval.binding)
      )
        fail("Invalid Profile recovery approval");
  }
  if (entry.beforeProfile === null && entry.afterProfile === null)
    fail("Profile recovery has no ownership transition");
  const before = entry.before === null ? null : decodeBytes(entry.before),
    after = decodeBytes(entry.after);
  if (
    !editProfile(
      root,
      before,
      entry.beforeProfile?.block,
      entry.afterProfile?.block,
    ).equals(after)
  )
    fail("Profile recovery bytes do not match the managed block edit");
  return { entry, before, after };
}

// Called under the existing mutation lock. State publication decides whether
// recovery keeps the edit or restores the exact previous Profile bytes.
export async function stageProfileChange(
  root: string,
  state: State,
  path: string,
  before: Buffer | null,
  after: Buffer,
  afterProfile: ProfileIntegration | null,
): Promise<void> {
  path = resolve(path);
  const journal = profileJournal(root),
    key = profileKey(path);
  await noLinks(journal);
  const entries = (await exists(journal)) ? (await json(journal)).changes : [];
  if (
    !Array.isArray(entries) ||
    entries.some(
      (e) =>
        typeof e.path !== "string" ||
        profileKey(e.path) === key ||
        e.beforeRevision !== state.revision,
    )
  )
    fail("Unrecovered Profile operation");
  if (!sameBytes(await profileBytes(path), before))
    fail("Profile changed after confirmation; preview again");
  const change: ProfileChange = {
    path,
    before: before?.toString("base64") ?? null,
    after: after.toString("base64"),
    beforeRevision: state.revision,
    beforeProfile: state.profiles?.[key] ?? null,
    afterProfile,
  };
  validateProfileChange(root, change);
  for (const entry of entries) validateProfileChange(root, entry);
  const journalValue = { changes: [...entries, change] };
  if (
    entries.length >= 100 ||
    after.length > 1024 * 1024 ||
    Buffer.byteLength(JSON.stringify(journalValue)) > 4 * 1024 * 1024
  )
    fail(
      "Profile recovery journal limit exceeded; integrate fewer Profiles per operation",
    );
  if (before) {
    const backup = `${path}.piko-backup-${crypto.randomUUID()}`;
    await noLinks(backup);
    await writeFile(backup, before, { flag: "wx" });
  }
  await mkdir(dirname(journal), { recursive: true });
  await atomicJson(journal, journalValue);
  await replaceProfile(path, before, after);
}

export async function recoverProfile(
  root: string,
  state: State,
): Promise<void> {
  const journal = profileJournal(root);
  await noLinks(journal);
  if (!(await exists(journal))) return;
  const info = await lstat(journal);
  if (!info.isFile() || info.nlink !== 1 || info.size > 4 * 1024 * 1024)
    fail("Invalid Profile recovery journal size/type");
  const journalValue = await json(journal);
  if (
    !record(journalValue) ||
    !Array.isArray(journalValue.changes) ||
    journalValue.changes.length > 100
  )
    fail("Invalid Profile recovery changes");
  const seen = new Set<string>();
  // Validate the whole journal, ownership and external bytes before any write.
  const changes = [];
  for (const value of journalValue.changes) {
    const { entry, before, after } = validateProfileChange(root, value),
      key = profileKey(entry.path);
    if (seen.has(key)) fail("Duplicate Profile recovery target");
    if (entry.beforeRevision !== journalValue.changes[0].beforeRevision)
      fail("Mixed Profile recovery revisions");
    seen.add(key);
    const currentProfile = state.profiles?.[key] ?? null,
      committed =
        state.revision === entry.beforeRevision + 1 &&
        JSON.stringify(currentProfile) === JSON.stringify(entry.afterProfile);
    if (
      !committed &&
      (state.revision !== entry.beforeRevision ||
        JSON.stringify(currentProfile) !== JSON.stringify(entry.beforeProfile))
    )
      fail("Profile recovery state drift; inspect manually");
    const current = await profileBytes(entry.path),
      desired = committed ? after : before;
    if (
      !sameBytes(current, desired) &&
      !sameBytes(current, committed ? before : after)
    )
      fail(
        "Profile changed during interrupted operation; preserve journal and inspect manually",
      );
    changes.push({ path: entry.path, current, desired });
  }
  for (const { path, current, desired } of changes)
    await replaceProfile(path, current, desired);
  await rm(journal);
}
