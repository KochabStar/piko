import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { artifactBytes } from "../src/cache.ts";
import { exists, sha256 } from "../src/util.ts";

const work = await mkdtemp(join(tmpdir(), "piko-offline-cache-"));
const bytes = Buffer.from("verified offline artifact fixture");
const checksum = sha256(bytes);
let requests = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() {
    requests++;
    return new Response(bytes);
  },
});
const url = `http://127.0.0.1:${server.port}/artifact`;

afterAll(async () => {
  server.stop(true);
  await rm(work, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
});

test("offline missing or unverified artifacts never contact the publisher", async () => {
  const root = join(work, "missing");
  const before = requests;
  await expect(
    artifactBytes(root, url, checksum, false, undefined, undefined, true),
  ).rejects.toThrow("Offline artifact cache miss");
  await expect(
    artifactBytes(root, url, checksum, true, undefined, undefined, true),
  ).rejects.toThrow("Offline installs require a verified cached artifact");
  await expect(
    artifactBytes(root, url, undefined, false, undefined, undefined, true),
  ).rejects.toThrow("Offline installs require a verified cached artifact");
  expect(requests).toBe(before);
  expect(await exists(join(root, "cache", "artifacts", checksum))).toBe(false);
});

test("offline artifacts reuse verified bytes and reject tampering without refetching", async () => {
  const root = join(work, "cached");
  await artifactBytes(root, url, checksum);
  const before = requests;
  expect(
    await artifactBytes(root, url, checksum, false, undefined, undefined, true),
  ).toEqual(bytes);
  await writeFile(join(root, "cache", "artifacts", checksum), "tampered");
  await expect(
    artifactBytes(root, url, checksum, false, undefined, undefined, true),
  ).rejects.toThrow("Cached artifact checksum mismatch");
  expect(requests).toBe(before);
});
