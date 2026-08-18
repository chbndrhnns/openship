import { beforeEach, describe, expect, it, vi } from "vitest";

const projectRepo = vi.hoisted(() => ({
  findById: vi.fn(),
}));

const deploymentRepo = vi.hoisted(() => ({
  findById: vi.fn(),
}));

const serviceRepo = vi.hoisted(() => ({
  findById: vi.fn(),
  findByName: vi.fn(),
  listByProject: vi.fn(),
  listByDeployment: vi.fn(),
  update: vi.fn(),
  updateServiceDeployment: vi.fn(),
}));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      ...actual.repos,
      project: projectRepo,
      deployment: deploymentRepo,
      service: serviceRepo,
    },
  };
});

const mockRuntime = vi.hoisted(() => ({
  name: "docker",
  restart: vi.fn(),
  stop: vi.fn(),
  start: vi.fn(),
  runContainer: vi.fn(),
  removeContainer: vi.fn(),
  dispose: vi.fn(),
  supports: vi.fn().mockReturnValue(true),
  listAllContainers: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../src/lib/deployment-runtime", () => ({
  resolveDeploymentRuntimeForRead: vi.fn().mockResolvedValue({
    runtime: mockRuntime,
    serverId: null,
  }),
}));

vi.mock("../../../src/modules/services/service-container", () => ({
  liveContainerIdWithRuntime: vi.fn().mockResolvedValue("container_existing_12345"),
  containerIdForService: vi.fn().mockReturnValue("container_existing_12345"),
  resolveServicePlatform: vi.fn().mockResolvedValue({
    platform: {
      runtime: mockRuntime,
      routing: null,
      ssl: null,
      system: null,
      executor: null,
      localHost: null,
    },
    effectiveTarget: "local",
    usesManagedRouting: false,
    serverId: null,
  }),
  isMultiServiceRuntime: vi.fn().mockReturnValue(true),
}));

vi.mock("../../../src/lib/route-apply.service", () => ({
  reconcileProjectRoutes: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/modules/domains/domain.service", () => ({
  ensurePendingServiceDomain: vi.fn().mockResolvedValue({ created: false }),
  removeServiceDomain: vi.fn().mockResolvedValue(undefined),
  reuseServerCertForDomain: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/lib/free-domain-guard", () => ({
  assertFreeEndpointsAllowed: vi.fn().mockResolvedValue(undefined),
}));

const deployComposeServicesMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src/modules/deployments/compose/deploy.service", () => ({
  deployComposeServices: deployComposeServicesMock,
}));

vi.mock("../../../src/modules/deployments/deployment-platform", () => ({
  resolveServicePlatform: vi.fn().mockResolvedValue({
    platform: {
      runtime: mockRuntime,
      routing: null,
      ssl: null,
      system: null,
      executor: null,
      localHost: null,
    },
    effectiveTarget: "local",
    usesManagedRouting: false,
    serverId: null,
  }),
  isMultiServiceRuntime: vi.fn().mockReturnValue(true),
}));

vi.mock("../../../src/modules/plans/plan.service", () => ({
  assertPlanAllowsServices: vi.fn().mockResolvedValue(undefined),
}));

import {
  restartServiceContainer,
  updateService,
} from "../../../src/modules/services/service.service";

/**
 * Fix for Issue #615:
 * Service restart supports recreating container with fresh environment and config
 * via recreate: true option, while maintaining fast docker restart by default.
 */
describe("Issue #615 - Service restart and recreate support", () => {
  const ctx = { organizationId: "org_test" } as never;
  const project = {
    id: "proj_test",
    organizationId: "org_test",
    slug: "my-app",
    activeDeploymentId: "dep_test",
    resources: null,
  };

  const initialService = () => ({
    id: "svc_web",
    projectId: "proj_test",
    name: "web",
    image: "nginx:latest",
    kind: "compose",
    enabled: true,
    environment: {
      API_ENDPOINT: "https://v1.api.example.com",
    },
    ports: ["8080:8080"],
    exposed: true,
    exposedPort: "8080",
    domain: "my-app-web",
    customDomain: null,
    domainType: "free",
    publicEndpoints: [{ port: 8080, domainType: "free", domain: "my-app-web" }],
  });

  const deployment = {
    id: "dep_test",
    projectId: "proj_test",
    organizationId: "org_test",
    meta: { runtimeMode: "docker" },
  };

  const serviceDeploymentRow = {
    id: "sd_row_1",
    deploymentId: "dep_test",
    serviceId: "svc_web",
    containerId: "container_existing_12345",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    projectRepo.findById.mockResolvedValue(project);
    deploymentRepo.findById.mockResolvedValue(deployment);
    serviceRepo.findById.mockResolvedValue(initialService());
    serviceRepo.listByProject.mockResolvedValue([initialService()]);
    serviceRepo.listByDeployment.mockResolvedValue([serviceDeploymentRow]);
    serviceRepo.update.mockResolvedValue(undefined);
    serviceRepo.updateServiceDeployment.mockResolvedValue(undefined);
    mockRuntime.restart.mockResolvedValue(undefined);
    deployComposeServicesMock.mockResolvedValue({
      status: "ready",
      services: [
        {
          serviceId: "svc_web",
          name: "web",
          status: "ready",
          containerId: "container_recreated_67890",
          ip: "172.30.0.4",
        },
      ],
    });
  });

  it("performs fast docker restart when recreate is not requested", async () => {
    const result = await restartServiceContainer(ctx, project.id, "svc_web");

    expect(result).toEqual({ containerId: "container_existing_12345" });
    expect(mockRuntime.restart).toHaveBeenCalledWith("container_existing_12345");
    expect(deployComposeServicesMock).not.toHaveBeenCalled();
  });

  it("recreates the container with fresh environment when recreate: true is passed", async () => {
    // 1. Operator updates service configuration / environment variables
    const updatedEnv = {
      API_ENDPOINT: "https://v2.api.example.com",
      NEW_FEATURE_FLAG: "enabled",
    };

    await updateService(ctx, project.id, "svc_web", {
      environment: updatedEnv,
    } as never);

    expect(serviceRepo.update).toHaveBeenCalledWith(
      "svc_web",
      expect.objectContaining({
        environment: updatedEnv,
      }),
    );

    // 2. Operator triggers service restart with recreate: true
    const result = await restartServiceContainer(ctx, project.id, "svc_web", { recreate: true });

    // Container is reprovisioned with fresh configuration
    expect(deployComposeServicesMock).toHaveBeenCalledWith(
      project,
      deployment,
      mockRuntime,
      expect.anything(),
      expect.objectContaining({
        targetServiceIds: new Set(["svc_web"]),
        strictScope: true,
      }),
    );
    expect(result).toEqual({
      containerId: "container_recreated_67890",
      ip: "172.30.0.4",
    });
  });
});
