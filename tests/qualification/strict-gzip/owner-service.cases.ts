import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateServiceInspection,
  validateServiceReceipt,
} from "./owner-service.ts";
import { POSTGRES_OWNER } from "./postgres-owner-fixture.ts";
const id = "a".repeat(64),
  networkName = "github_network_" + "b".repeat(32);
function fixture() {
  const image = {
    Id: POSTGRES_OWNER.imageConfigDigest,
    Os: "linux",
    Architecture: "amd64",
    RepoDigests: [POSTGRES_OWNER.image],
    Config: {
      Entrypoint: ["docker-entrypoint.sh"],
      Cmd: ["postgres"],
      Volumes: { "/var/lib/postgresql/data": {} },
      Env: ["PATH=/synthetic/image/bin", "PG_MAJOR=17"],
    },
  };
  const container = {
    Id: id,
    Image: image.Id,
    Config: {
      Image: POSTGRES_OWNER.image,
      Entrypoint: image.Config.Entrypoint,
      Cmd: image.Config.Cmd,
      Env: [
        ...image.Config.Env,
        `POSTGRES_DB=${POSTGRES_OWNER.database}`,
        `POSTGRES_USER=${POSTGRES_OWNER.admin}`,
        `POSTGRES_PASSWORD=${POSTGRES_OWNER.adminPassword}`,
        "POSTGRES_HOST_AUTH_METHOD=scram-sha-256",
        "GITHUB_ACTIONS=true",
        "CI=true",
      ],
    },
    State: { Running: true, Health: { Status: "healthy" } },
    RestartCount: 0,
    HostConfig: {
      Tmpfs: {
        "/var/lib/postgresql/data": "rw,noexec,nosuid,nodev,size=268435456",
      },
      Privileged: false,
      Binds: null,
      CapAdd: null,
      Devices: [],
      DeviceRequests: null,
      VolumesFrom: null,
      SecurityOpt: null,
      NetworkMode: networkName,
      PortBindings: {
        "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55432" }],
      },
    },
    NetworkSettings: {
      Networks: { [networkName]: {} },
      Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "55432" }] },
    },
    Mounts: [],
  };
  const network = {
    Name: networkName,
    Driver: "bridge",
    Scope: "local",
    Ingress: false,
  };
  return { container, image, network };
}
test("accepts exact existing Actions-owned local service and strips private inspection values", () => {
  const { container, image, network } = fixture();
  const receipt = validateServiceInspection(container, image, network, id);
  const summary = validateServiceReceipt(receipt);
  assert.equal(summary.platform, "linux/amd64");
  assert.equal(summary.loopbackOnlyPublishedPort, true);
  assert.equal(summary.serviceMemory, "not-observed");
  for (const secret of [
    id,
    "/private/ignored/path",
    POSTGRES_OWNER.adminPassword,
    "PG_MAJOR",
  ])
    assert.ok(!JSON.stringify(summary).includes(secret));
});
const mutations: Record<string, (v: any) => void> = {
  "wrong container": (v) => (v.container.Id = "d".repeat(64)),
  "wrong image reference": (v) =>
    (v.container.Config.Image = "postgres:latest"),
  "wrong running image digest": (v) =>
    (v.container.Image = "sha256:" + "d".repeat(64)),
  "wrong image content": (v) => (v.image.Id = "sha256:" + "d".repeat(64)),
  "wrong platform": (v) => (v.image.Architecture = "arm64"),
  "wrong image repository association": (v) =>
    (v.image.RepoDigests = ["other"]),
  "stopped service": (v) => (v.container.State.Running = false),
  "unhealthy service": (v) => (v.container.State.Health.Status = "unhealthy"),
  "restarted service": (v) => (v.container.RestartCount = 1),
  "privileged service": (v) => (v.container.HostConfig.Privileged = true),
  "host bind mount": (v) => (v.container.HostConfig.Binds = ["/private:/host"]),
  "extra capability": (v) => (v.container.HostConfig.CapAdd = ["SYS_ADMIN"]),
  "device access": (v) => (v.container.HostConfig.Devices = [{}]),
  "device request": (v) => (v.container.HostConfig.DeviceRequests = [{}]),
  "inherited volume": (v) => (v.container.HostConfig.VolumesFrom = ["other"]),
  "security override": (v) =>
    (v.container.HostConfig.SecurityOpt = ["unconfined"]),
  "host networking": (v) => (v.container.HostConfig.NetworkMode = "host"),
  "non Actions network": (v) => {
    v.container.HostConfig.NetworkMode = "other";
    v.network.Name = "other";
  },
  "non local network": (v) => (v.network.Scope = "swarm"),
  "non bridge network": (v) => (v.network.Driver = "overlay"),
  "ingress network": (v) => (v.network.Ingress = true),
  "additional network": (v) =>
    (v.container.NetworkSettings.Networks.other = {}),
  "wildcard configured binding": (v) =>
    (v.container.HostConfig.PortBindings["5432/tcp"][0].HostIp = "0.0.0.0"),
  "wildcard actual binding": (v) =>
    (v.container.NetworkSettings.Ports["5432/tcp"][0].HostIp = "0.0.0.0"),
  "extra published port": (v) =>
    (v.container.NetworkSettings.Ports["80/tcp"] = []),
  "wrong command": (v) => (v.container.Config.Cmd = ["sh"]),
  "alternate image command": (v) => {
    v.container.Config.Cmd = ["sh"];
    v.image.Config.Cmd = ["sh"];
  },
  "extra image volume": (v) => (v.image.Config.Volumes["/other"] = {}),
  "actual mount": (v) => v.container.Mounts.push({ Type: "volume" }),
  "missing tmpfs": (v) => (v.container.HostConfig.Tmpfs = {}),
  "extra tmpfs": (v) => (v.container.HostConfig.Tmpfs["/other"] = "rw"),
  "wrong tmpfs options": (v) =>
    (v.container.HostConfig.Tmpfs["/var/lib/postgresql/data"] = "rw"),
  "unreviewed environment": (v) =>
    v.container.Config.Env.push("UNREVIEWED=value"),
  "wrong auth method": (v) =>
    (v.container.Config.Env = v.container.Config.Env.map((e: string) =>
      e.startsWith("POSTGRES_HOST_AUTH_METHOD=")
        ? "POSTGRES_HOST_AUTH_METHOD=trust"
        : e,
    )),
  "duplicate environment": (v) =>
    v.container.Config.Env.push(v.container.Config.Env[0]),
};
for (const [name, edit] of Object.entries(mutations))
  test(`refuses ${name} without any Docker or socket call`, () => {
    const value = fixture();
    edit(value);
    assert.throws(() =>
      validateServiceInspection(
        value.container,
        value.image,
        value.network,
        id,
      ),
    );
  });
for (const [key, value] of Object.entries({
  image: "postgres:latest",
  imageConfigDigest: "sha256:" + "f".repeat(64),
  platform: "linux/arm64",
  containerIdentitySha256: "bad",
  loopbackOnlyPublishedPort: false,
  setupContainerRestarts: 1,
  productionCredentials: true,
  exactNativeTransport: "203.0.113.1:5432",
}))
  test(`sanitized service receipt refuses changed ${key}`, () => {
    const v = fixture();
    const receipt = validateServiceInspection(
      v.container,
      v.image,
      v.network,
      id,
    );
    assert.throws(() => validateServiceReceipt({ ...receipt, [key]: value }));
  });
