import { describe, it, expect, vi, beforeEach } from "vitest";

const listByOrganization = vi.fn();
const listByDeployments = vi.fn();

vi.mock("@repo/db", () => ({
  repos: {
    project: {
      listByOrganization: (...args: unknown[]) => listByOrganization(...args),
    },
    serviceDeployment: {
      listByDeployments: (...args: unknown[]) => listByDeployments(...args),
    },
  },
}));

import { listOrgPinnedHostPorts } from "./pinned-host-ports";

describe("listOrgPinnedHostPorts", () => {
  beforeEach(() => {
    listByOrganization.mockReset();
    listByDeployments.mockReset().mockResolvedValue(new Map());
  });

  it("collects pinned host ports from both single-service and compose projects", async () => {
    listByOrganization.mockResolvedValue({
      rows: [
        // Single-service project with pinned hostPort
        { id: "proj-1", hostPort: 20001, activeDeploymentId: "dep-1" },
        // Compose project: hostPort on project is null, but active deployment has service deployments
        { id: "proj-2", hostPort: null, activeDeploymentId: "dep-2" },
        // Current project (to be excluded)
        { id: "current-proj", hostPort: 20007, activeDeploymentId: "dep-current" },
        // Project with no deployment and no hostPort
        { id: "proj-3", hostPort: null, activeDeploymentId: null },
      ],
    });

    listByDeployments.mockResolvedValue(
      new Map([
        [
          "dep-2",
          [
            { serviceName: "server", hostPort: 20005 },
            { serviceName: "worker", hostPort: null },
            { serviceName: "web", hostPort: 20006 },
          ],
        ],
      ]),
    );

    const pinned = await listOrgPinnedHostPorts("org-1", "current-proj");

    expect(pinned).toContain(20001);
    expect(pinned).toContain(20005);
    expect(pinned).toContain(20006);
    expect(pinned).not.toContain(20007);
    expect(listByDeployments).toHaveBeenCalledWith(["dep-1", "dep-2"]);
  });

  it("handles empty organization or database errors without throwing", async () => {
    listByOrganization.mockRejectedValue(new Error("db connection error"));

    const pinned = await listOrgPinnedHostPorts("org-1", "current-proj");
    expect(pinned).toEqual([]);
  });

  it("filters out non-positive or invalid port numbers", async () => {
    listByOrganization.mockResolvedValue({
      rows: [
        { id: "proj-1", hostPort: 0, activeDeploymentId: "dep-1" },
        { id: "proj-2", hostPort: -1, activeDeploymentId: null },
        { id: "proj-3", hostPort: 20010, activeDeploymentId: null },
      ],
    });

    listByDeployments.mockResolvedValue(
      new Map([
        [
          "dep-1",
          [
            { serviceName: "api", hostPort: 0 },
            { serviceName: "db", hostPort: 20011 },
          ],
        ],
      ]),
    );

    const pinned = await listOrgPinnedHostPorts("org-1");
    expect(pinned).toEqual([20010, 20011]);
  });
});
