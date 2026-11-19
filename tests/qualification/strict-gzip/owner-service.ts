// Setup-only read of the Actions-owned disposable service. This file is never
// imported by a native owner and never starts, stops, or reconfigures a service.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { POSTGRES_OWNER, sha256 } from "./postgres-owner-fixture.ts";
const empty = (value: unknown) =>
  assert.ok(
    value === null ||
      value === undefined ||
      (Array.isArray(value) && value.length === 0),
  );
export function validateServiceInspection(
  container: any,
  image: any,
  network: any,
  expectedId: string,
) {
  assert.match(expectedId, /^[a-f0-9]{64}$/);
  assert.equal(container.Id, expectedId);
  assert.equal(container.Config.Image, POSTGRES_OWNER.image);
  assert.equal(container.Image, POSTGRES_OWNER.imageConfigDigest);
  assert.equal(image.Id, POSTGRES_OWNER.imageConfigDigest);
  assert.equal(image.Os, "linux");
  assert.equal(image.Architecture, "amd64");
  assert.ok(
    Array.isArray(image.RepoDigests) &&
      image.RepoDigests.some(
        (digest: string) =>
          digest === POSTGRES_OWNER.image ||
          digest === POSTGRES_OWNER.image.replace("docker.io/library/", ""),
      ),
  );
  assert.equal(container.State.Running, true);
  assert.equal(container.State.Health.Status, "healthy");
  assert.equal(container.RestartCount, 0);
  assert.equal(container.HostConfig.Privileged, false);
  for (const key of [
    "Binds",
    "CapAdd",
    "Devices",
    "DeviceRequests",
    "VolumesFrom",
    "SecurityOpt",
  ])
    empty(container.HostConfig[key]);
  assert.equal(container.HostConfig.NetworkMode, network.Name);
  assert.match(network.Name, /^github_network_[a-f0-9]{32}$/);
  assert.equal(network.Driver, "bridge");
  assert.equal(network.Scope, "local");
  assert.equal(network.Ingress, false);
  assert.deepEqual(Object.keys(container.NetworkSettings.Networks), [
    network.Name,
  ]);
  assert.deepEqual(container.HostConfig.PortBindings, {
    "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55432" }],
  });
  assert.deepEqual(container.NetworkSettings.Ports, {
    "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55432" }],
  });
  assert.deepEqual(container.Config.Entrypoint, image.Config.Entrypoint);
  assert.deepEqual(container.Config.Cmd, image.Config.Cmd);
  assert.deepEqual(image.Config.Entrypoint, ["docker-entrypoint.sh"]);
  assert.deepEqual(image.Config.Cmd, ["postgres"]);
  assert.deepEqual(image.Config.Volumes, { "/var/lib/postgresql/data": {} });
  assert.deepEqual(container.Mounts, []);
  assert.deepEqual(container.HostConfig.Tmpfs, {
    "/var/lib/postgresql/data": "rw,noexec,nosuid,nodev,size=268435456",
  });
  const baseline = new Map<string, string>(
    (image.Config.Env as string[]).map((value) => {
      const at = value.indexOf("=");
      assert.ok(at > 0);
      return [value.slice(0, at), value.slice(at + 1)];
    }),
  );
  for (const [key, value] of Object.entries({
    POSTGRES_DB: POSTGRES_OWNER.database,
    POSTGRES_USER: POSTGRES_OWNER.admin,
    POSTGRES_PASSWORD: POSTGRES_OWNER.adminPassword,
    POSTGRES_HOST_AUTH_METHOD: "scram-sha-256",
    GITHUB_ACTIONS: "true",
    CI: "true",
  }))
    baseline.set(key, value);
  assert.deepEqual(
    [...container.Config.Env].sort(),
    [...baseline].map(([key, value]) => `${key}=${value}`).sort(),
  );
  return {
    schemaVersion: 1,
    image: POSTGRES_OWNER.image,
    imageConfigDigest: POSTGRES_OWNER.imageConfigDigest,
    platform: "linux/amd64",
    expectedServerVersionNum: POSTGRES_OWNER.serverVersionNum,
    containerIdentitySha256: sha256(expectedId),
    loopbackOnlyPublishedPort: true,
    exactNativeTransport: "127.0.0.1:55432",
    healthyAtSetup: true,
    setupContainerRestarts: 0,
    unexpectedMountsOrPrivileges: false,
    networkScope: "actions-owned-local-bridge",
    productionCredentials: false,
    setupOnly: true,
    storage: "fixed-ephemeral-tmpfs",
  };
}
export function validateServiceReceipt(receipt: any) {
  assert.equal(receipt.setupOnly, true);
  assert.equal(receipt.storage, "fixed-ephemeral-tmpfs");
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.image, POSTGRES_OWNER.image);
  assert.equal(receipt.imageConfigDigest, POSTGRES_OWNER.imageConfigDigest);
  assert.equal(receipt.platform, "linux/amd64");
  assert.equal(
    receipt.expectedServerVersionNum,
    POSTGRES_OWNER.serverVersionNum,
  );
  assert.match(receipt.containerIdentitySha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.loopbackOnlyPublishedPort, true);
  assert.equal(receipt.exactNativeTransport, "127.0.0.1:55432");
  assert.equal(receipt.healthyAtSetup, true);
  assert.equal(receipt.setupContainerRestarts, 0);
  assert.equal(receipt.unexpectedMountsOrPrivileges, false);
  assert.equal(receipt.networkScope, "actions-owned-local-bridge");
  assert.equal(receipt.productionCredentials, false);
  return {
    image: POSTGRES_OWNER.image,
    imageConfigDigest: POSTGRES_OWNER.imageConfigDigest,
    platform: "linux/amd64",
    expectedServerVersionNum: POSTGRES_OWNER.serverVersionNum,
    containerIdentitySha256: receipt.containerIdentitySha256,
    loopbackOnlyPublishedPort: true,
    setupContainerRestarts: 0,
    setupOnly: true,
    storage: "fixed-ephemeral-tmpfs",
    serviceMemory: "not-observed",
    scope: "disposable-synthetic-only",
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    assert.equal(process.argv.length, 4);
    const id = process.argv[2]!,
      output = process.argv[3]!;
    assert.match(id, /^[a-f0-9]{64}$/);
    assert.ok(path.isAbsolute(output));
    const inspect = (args: string[]) => {
      const value = JSON.parse(
        execFileSync(
          "docker",
          ["--host", "unix:///var/run/docker.sock", ...args],
          {
            env: { PATH: process.env.PATH },
            encoding: "utf8",
            timeout: 5000,
            maxBuffer: 1024 * 1024,
            stdio: ["ignore", "pipe", "pipe"],
          },
        ),
      );
      assert.ok(Array.isArray(value) && value.length === 1);
      return value[0];
    };
    const container = inspect(["inspect", "--type", "container", id]);
    const image = inspect(["image", "inspect", POSTGRES_OWNER.image]);
    const name = container.HostConfig.NetworkMode;
    assert.match(name, /^github_network_[a-f0-9]{32}$/);
    const network = inspect(["network", "inspect", name]);
    const receipt = validateServiceInspection(container, image, network, id);
    writeFileSync(output, JSON.stringify(receipt) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    console.log("Validated disposable local PostgreSQL service identity.");
  } catch {
    console.error("PostgreSQL service identity validation failed.");
    process.exitCode = 1;
  }
}
