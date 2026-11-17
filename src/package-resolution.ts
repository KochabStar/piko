import { join } from "node:path";
import {
  chooseVersion,
  distributionDownloads,
  loadManifest,
  loadPackageDocument,
  normalizeManifest,
} from "./catalog.ts";
import {
  compareVersions,
  discover,
  nextManifest,
  validateUpstreamRule,
  type UpstreamNetwork,
} from "./upstream.ts";
import { prepareUpstreamManifest } from "./upstream-payload.ts";
import { githubMetadata } from "./github-metadata.ts";
import {
  atomicJson,
  download,
  exists,
  fail,
  json,
  noLinks,
  record,
  resolveUrl,
  sha256,
} from "./util.ts";
import type { CatalogPackage, Manifest, Source, State } from "./types.ts";

export type ResolutionSession = {
  requests: Map<string, Promise<unknown>>;
  resolutions: Map<string, Promise<Manifest>>;
};
export function resolutionSession(): ResolutionSession {
  return { requests: new Map(), resolutions: new Map() };
}
function network(
  root: string,
  state: State,
  session: ResolutionSession,
): UpstreamNetwork {
  const once = <T>(key: string, run: () => Promise<T>): Promise<T> => {
    if (!session.requests.has(key)) session.requests.set(key, run());
    return session.requests.get(key)! as Promise<T>;
  };
  const text = (url: string) =>
    once(
      "text:" + url,
      async () =>
        (await githubMetadata(root, state, url)) ??
        Buffer.from(await download(url, 8 * 1024 * 1024)).toString("utf8"),
    );
  return {
    text,
    json: (url) => once("json:" + url, async () => JSON.parse(await text(url))),
    redirect: (url) =>
      once("redirect:" + url, async () => (await resolveUrl(url)).href),
  };
}
function exactPath(
  root: string,
  source: Source,
  name: string,
  version: string,
) {
  return join(
    root,
    "cache",
    "resolved",
    sha256(JSON.stringify([source.identity, name, version])) + ".json",
  );
}
export async function savedManifest(
  root: string,
  source: Source,
  name: string,
  version: string,
): Promise<Manifest | undefined> {
  const path = exactPath(root, source, name, version);
  await noLinks(path);
  if (!(await exists(path))) return;
  const saved = await json(path);
  if (
    saved.source !== source.identity ||
    saved.name !== name ||
    saved.version !== version
  )
    fail("Resolved manifest cache identity mismatch");
  const manifest = normalizeManifest(saved.manifest, name, version);
  if (sha256(JSON.stringify(manifest)) !== saved.manifestHash)
    fail("Resolved manifest cache content mismatch");
  return manifest;
}

function assertResolvedConstraint(version: string, request: string): void {
  if (/^\d+(?:\.\d+)?$/.test(request)) {
    if (version !== request && !version.startsWith(request + "."))
      fail(
        "Inspected upstream version does not satisfy the requested numeric constraint",
      );
    return;
  }
  const prerelease = version
    .match(
      /(?:^|[-.])((?:alpha|beta|rc|pre|preview|canary|nightly|dev|next)[a-z0-9.-]*)/i,
    )?.[1]
    ?.toLowerCase();
  if (request === "latest" || request === "stable") {
    if (prerelease)
      fail("Inspected upstream version does not satisfy the stable channel");
  } else if (request === "next" || request === "prerelease") {
    if (!prerelease)
      fail(
        "Inspected upstream version does not satisfy the prerelease channel",
      );
  } else if (request === "alpha" || request === "beta") {
    if (!prerelease?.startsWith(request))
      fail("Inspected upstream version does not satisfy the requested channel");
  } else if (version !== request) {
    fail(
      "Inspected upstream version does not satisfy the exact version request",
    );
  }
}
export async function resolvePackageManifest(
  root: string,
  state: State,
  source: Source,
  name: string,
  entry: CatalogPackage,
  request = "latest",
  options: {
    offline?: boolean;
    preview?: boolean;
    currentVersion?: string;
    session?: ResolutionSession;
    preflight?: (manifest: Manifest) => Promise<void>;
  } = {},
): Promise<Manifest> {
  const session = options.session ?? resolutionSession();
  const exact =
    Object.hasOwn(entry.versions, request) ||
    (!/^(latest|stable|next|beta|alpha|prerelease|\d+(?:\.\d+)?)$/.test(
      request,
    ) &&
      !Object.hasOwn(entry.aliases ?? {}, request));
  if (exact) {
    const saved = await savedManifest(root, source, name, request);
    if (saved || Object.hasOwn(entry.versions, request)) {
      const manifest =
        saved ??
        (await loadManifest(
          root,
          source,
          entry.versions[request]!,
          name,
          request,
          options,
        ));
      if (
        options.preview &&
        distributionDownloads(manifest.platforms["windows-x64"]!).some(
          (download) => !download.sha256,
        )
      )
        fail("Candidate lacks required SHA-256");
      await options.preflight?.(manifest);
      return manifest;
    }
    if (options.offline) fail("Exact upstream manifest unavailable offline");
  }
  const key = JSON.stringify([
    source.identity,
    name,
    entry.latest,
    entry.versions[entry.latest],
    request,
    !!options.offline,
    !!options.preview,
    options.currentVersion,
  ]);
  // A caller's permission preflight is never inherited from another consumer.
  // Network/document requests remain shared, but preparation with an operation-
  // specific preflight must run inside that operation's authorization boundary.
  let pending = options.preflight ? undefined : session.resolutions.get(key);
  if (!pending) {
    pending = (async () => {
      const documentKey =
        "document:" +
        JSON.stringify([
          source.identity,
          name,
          entry.latest,
          entry.versions[entry.latest],
        ]);
      if (!session.requests.has(documentKey))
        session.requests.set(
          documentKey,
          loadPackageDocument(
            root,
            source,
            entry.versions[entry.latest]!,
            name,
            entry.latest,
            options,
          ),
        );
      const document = await session.requests.get(documentKey)!;
      const baseline = normalizeManifest(document, name, entry.latest);
      if (!record(document) || !Object.hasOwn(document, "upstream")) {
        const version = chooseVersion(
          Object.keys(entry.versions),
          request,
          entry.latest,
          entry.aliases,
        );
        const manifest =
          version === entry.latest
            ? baseline
            : await loadManifest(
                root,
                source,
                entry.versions[version]!,
                name,
                version,
                options,
              );
        if (
          options.preview &&
          distributionDownloads(manifest.platforms["windows-x64"]!).some(
            (download) => !download.sha256,
          )
        )
          fail("Candidate lacks required SHA-256");
        return manifest;
      }
      const rule = validateUpstreamRule(document.upstream);
      const recipeIdentity =
        record(document.versions) &&
        record(document.versions[entry.latest]) &&
        typeof document.versions[entry.latest]!.recipe === "string"
          ? document.versions[entry.latest]!.recipe
          : sha256(JSON.stringify(baseline));
      const policy = sha256(JSON.stringify([rule, recipeIdentity]));
      const requestPath = join(
        root,
        "cache",
        "resolved-requests",
        sha256(JSON.stringify([source.identity, name, policy, request])) +
          ".json",
      );
      if (options.offline) {
        await noLinks(requestPath);
        if (!(await exists(requestPath)))
          fail(
            "Upstream resolution unavailable offline; resolve this request online first",
          );
        const pointer = await json(requestPath);
        if (
          pointer.policy !== policy ||
          pointer.source !== source.identity ||
          pointer.request !== request
        )
          fail("Offline upstream resolution identity mismatch");
        const saved = await savedManifest(root, source, name, pointer.version);
        if (saved) return saved;
        if (pointer.version === baseline.version) return baseline;
        fail("Exact upstream manifest unavailable offline");
      }
      const constraint = entry.aliases?.[request] ?? request;
      const candidate = await discover(
        rule,
        baseline,
        network(root, state, session),
        constraint,
      );
      if (
        candidate.version === baseline.version &&
        !candidate.versionFromPE &&
        !rule.versionFromPE
      ) {
        const primary = (baseline.platforms["windows-x64"]!.downloads ?? [
          baseline.platforms["windows-x64"]!,
        ])[0]!;
        if (
          candidate.url !== primary.url ||
          (candidate.sha256 &&
            primary.sha256 &&
            candidate.sha256.toLowerCase() !== primary.sha256.toLowerCase())
        )
          fail("Same-version upstream payload changed; refusing overwrite");
        if (
          rule.trust === "publisher" &&
          !candidate.sha256 &&
          !candidate.sha512 &&
          !rule.signature
        )
          fail(
            "Publisher trust requires an upstream strong digest or declared signature",
          );
        await options.preflight?.(baseline);
        if (!options.preview) {
          const saved = await savedManifest(
            root,
            source,
            name,
            baseline.version,
          );
          if (saved && JSON.stringify(saved) !== JSON.stringify(baseline))
            fail(
              "Installed version has different manifest content; refusing overwrite",
            );
          if (!saved)
            await atomicJson(exactPath(root, source, name, baseline.version), {
              source: source.identity,
              name,
              version: baseline.version,
              policy,
              trust: rule.trust,
              rule,
              candidate: { ...candidate, assetBytes: undefined },
              manifestHash: sha256(JSON.stringify(baseline)),
              manifest: baseline,
            });
          await atomicJson(requestPath, {
            source: source.identity,
            request,
            policy,
            version: baseline.version,
          });
        }
        return baseline;
      }
      if (
        options.currentVersion &&
        candidate.version !== options.currentVersion &&
        !candidate.versionFromPE &&
        !rule.versionFromPE &&
        compareVersions(candidate.version, options.currentVersion) < 0
      )
        fail(
          "Upstream/request resolves to an older version; refusing downgrade",
        );
      const preview = nextManifest(baseline, candidate, rule);
      await options.preflight?.(preview);
      if (
        rule.trust === "publisher" &&
        !candidate.sha256 &&
        !candidate.sha512 &&
        !rule.signature
      )
        fail(
          "Publisher trust requires an upstream strong digest or declared signature",
        );
      if (options.preview)
        return await prepareUpstreamManifest(
          root,
          state,
          baseline,
          candidate,
          rule,
          { preview: true },
        );
      const path = exactPath(root, source, name, candidate.version);
      const saved = await savedManifest(root, source, name, candidate.version);
      let manifest: Manifest;
      if (saved) {
        const prior = await json(path);
        if (prior.policy !== policy)
          fail(
            "Upstream rule or recipe changed for an already resolved version; publish a new version",
          );
        const primary = (saved.platforms["windows-x64"]!.downloads ?? [
          saved.platforms["windows-x64"]!,
        ])[0]!;
        if (
          candidate.url !== primary.url ||
          (candidate.sha256 &&
            candidate.sha256.toLowerCase() !== primary.sha256?.toLowerCase()) ||
          (["sha512", "md5", "stripPrefix"] as const).some(
            (field) =>
              candidate[field] !== undefined &&
              prior.candidate?.[field] !== candidate[field],
          )
        )
          fail(
            "Published upstream version has different content; refusing overwrite",
          );
        manifest = saved;
      } else {
        manifest = await prepareUpstreamManifest(
          root,
          state,
          baseline,
          candidate,
          rule,
        );
        assertResolvedConstraint(manifest.version, constraint);
        if (
          options.currentVersion &&
          manifest.version !== options.currentVersion &&
          compareVersions(manifest.version, options.currentVersion) < 0
        )
          fail(
            "Upstream/request resolves to an older version; refusing downgrade",
          );
        const existing = Object.values(state.installs).find(
          (i) =>
            i.source.identity === source.identity &&
            i.name === name &&
            i.version === manifest.version,
        );
        const manifestHash = sha256(JSON.stringify(manifest));
        if (existing && existing.manifestHash !== manifestHash)
          fail(
            "Installed version has different manifest content; refusing overwrite",
          );
        const finalPath = exactPath(root, source, name, manifest.version);
        const prior = await savedManifest(root, source, name, manifest.version);
        if (prior && JSON.stringify(prior) !== JSON.stringify(manifest))
          fail(
            "Published upstream version has different content; refusing overwrite",
          );
        await atomicJson(finalPath, {
          source: source.identity,
          name,
          version: manifest.version,
          policy,
          trust: rule.trust,
          rule,
          candidate: { ...candidate, assetBytes: undefined },
          manifestHash,
          manifest,
        });
      }
      await atomicJson(requestPath, {
        source: source.identity,
        request,
        policy,
        version: manifest.version,
      });
      return manifest;
    })();
    if (!options.preflight) session.resolutions.set(key, pending);
  }
  const manifest = await pending;
  assertResolvedConstraint(
    manifest.version,
    entry.aliases?.[request] ?? request,
  );
  await options.preflight?.(manifest);
  return manifest;
}
