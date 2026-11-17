import { isAbsolute } from "node:path";
import { fail, record, relativeFile } from "./util.ts";
import type { ServiceDeclaration, ServiceReceipt } from "./types.ts";

const allowed = new Set([
  "name",
  "displayName",
  "description",
  "binPath",
  "args",
  "startType",
  "depends",
  "startAfterInstall",
  "stopBeforeUninstall",
]);
export const serviceNameKey = (name: string) => name.toLowerCase();
function text(
  value: unknown,
  maximum: number,
  empty = false,
): asserts value is string {
  if (
    typeof value !== "string" ||
    (!empty && !value.trim()) ||
    value.length > maximum ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    fail("Invalid service declaration text");
}
function name(value: unknown): asserts value is string {
  text(value, 256);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_. $-]{0,255}$/.test(value) ||
    value.trim() !== value
  )
    fail("Invalid Windows service name");
}
export function validateServices(
  value: unknown,
): asserts value is ServiceDeclaration[] {
  if (!Array.isArray(value) || value.length > 32)
    fail("services requires at most 32 declarations");
  const seen = new Set<string>();
  for (const service of value) {
    if (
      !record(service) ||
      Object.keys(service).some((key) => !allowed.has(key))
    )
      fail("Invalid service declaration fields");
    name(service.name);
    const key = serviceNameKey(service.name);
    if (seen.has(key))
      fail("Duplicate Windows service name (case-insensitive)");
    seen.add(key);
    text(service.displayName, 256);
    if (service.description !== undefined)
      text(service.description, 8192, true);
    if (typeof service.binPath !== "string")
      fail("Service binPath must be a package-relative executable");
    relativeFile(service.binPath);
    if (!/\.exe$/i.test(service.binPath))
      fail("Service binPath must be an .exe");
    if (!["auto", "demand", "disabled"].includes(service.startType as string))
      fail("Invalid service startType");
    if (service.args !== undefined) {
      if (!Array.isArray(service.args) || service.args.length > 128)
        fail("Invalid service args");
      for (const argument of service.args) text(argument, 8192, true);
    }
    if (service.depends !== undefined) {
      if (!Array.isArray(service.depends) || service.depends.length > 64)
        fail("Invalid service depends");
      const dependencies = new Set<string>();
      for (const dependency of service.depends) {
        name(dependency);
        const dependencyKey = serviceNameKey(dependency);
        if (dependencyKey === key || dependencies.has(dependencyKey))
          fail("Duplicate or self service dependency");
        dependencies.add(dependencyKey);
      }
    }
    for (const flag of ["startAfterInstall", "stopBeforeUninstall"])
      if (service[flag] !== undefined && typeof service[flag] !== "boolean")
        fail(`Invalid service ${flag}`);
    if (service.startType === "disabled" && service.startAfterInstall === true)
      fail("Disabled services cannot startAfterInstall");
  }
  const declarations = new Map(
    value.map((service) => [serviceNameKey(service.name), service]),
  );
  const visiting = new Set<string>(),
    visited = new Set<string>();
  function visit(key: string) {
    if (visiting.has(key)) fail("Cyclic service dependencies");
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of declarations.get(key)?.depends ?? []) {
      const next = serviceNameKey(dependency);
      if (declarations.has(next)) visit(next);
    }
    visiting.delete(key);
    visited.add(key);
  }
  for (const key of declarations.keys()) visit(key);
}

export function validateServiceReceipt(
  value: unknown,
): asserts value is ServiceReceipt {
  if (!record(value)) fail("Invalid service receipt");
  name(value.name);
  if (
    typeof value.packageId !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.packageId) ||
    value.id !== `${value.packageId}/${serviceNameKey(value.name)}`
  )
    fail("Invalid service receipt identity");
  text(value.displayName, 256);
  text(value.installedVersion, 100);
  if (
    typeof value.installedAt !== "string" ||
    !Number.isFinite(Date.parse(value.installedAt)) ||
    !["registered", "failed", "removed"].includes(value.status as string)
  )
    fail("Invalid service receipt status");
  if (value.owned !== undefined && typeof value.owned !== "boolean")
    fail("Invalid service ownership flag");
  if (
    value.error !== undefined &&
    (typeof value.error !== "string" || value.error.length > 65536)
  )
    fail("Invalid service failure record");
  if (value.config !== undefined) {
    const config = value.config;
    if (
      !record(config) ||
      Object.keys(config).some(
        (key) =>
          ![
            "binaryPath",
            "startType",
            "serviceType",
            "errorControl",
            "account",
            "displayName",
            "description",
            "depends",
          ].includes(key),
      )
    )
      fail("Invalid service configuration receipt");
    if (
      typeof config.binaryPath !== "string" ||
      typeof config.account !== "string" ||
      typeof config.displayName !== "string" ||
      typeof config.description !== "string" ||
      !Number.isInteger(config.startType) ||
      !Number.isInteger(config.serviceType) ||
      !Number.isInteger(config.errorControl) ||
      !Array.isArray(config.depends)
    )
      fail("Invalid service configuration receipt");
    text(config.binaryPath, 32766);
    const image = /^"([^"]+)"(?: |$)/.exec(config.binaryPath);
    if (!image || !isAbsolute(image[1]!) || !/\.exe$/i.test(image[1]!))
      fail("Service receipt needs a quoted absolute executable");
    if (
      ![2, 3, 4].includes(config.startType as number) ||
      config.serviceType !== 16 ||
      config.errorControl !== 1 ||
      config.account !== "LocalSystem"
    )
      fail("Unsupported service receipt configuration");
    text(config.displayName, 256);
    text(config.description, 8192, true);
    if (config.displayName !== value.displayName || config.depends.length > 64)
      fail("Invalid receipted service dependencies");
    const seen = new Set<string>();
    for (const dependency of config.depends) {
      name(dependency);
      const key = serviceNameKey(dependency);
      if (key === serviceNameKey(value.name) || seen.has(key))
        fail("Invalid receipted service dependency");
      seen.add(key);
    }
  }
  if (value.owned === true && !value.config)
    fail("Owned service receipt is missing configuration");
  if (value.status === "registered" && value.owned !== true)
    fail("Registered service receipt lacks ownership");
  if (value.status === "removed" && value.owned === true)
    fail("Removed service receipt cannot retain ownership");
}
