import { repos } from "@repo/db";

/**
 * Collect all loopback host ports currently pinned to OTHER projects in the organization.
 *
 * This includes:
 * 1. Single-service projects whose `project.hostPort` is set.
 * 2. Compose / multi-service projects whose active deployment has `service_deployment.hostPort` rows.
 *
 * When containers are stopped or restarting (e.g. after a crash or during maintenance),
 * live TCP port scanning on the host cannot see them. Seeding `avoid` with these database-pinned
 * ports prevents another project's deploy from stealing a stopped container's port and causing
 * a Docker bind collision when it restarts.
 */
export async function listOrgPinnedHostPorts(
  organizationId: string,
  excludeProjectId?: string | null,
): Promise<number[]> {
  const otherProjects = (
    await repos.project
      .listByOrganization(organizationId, { perPage: 1000 })
      .then((r) => r.rows)
      .catch(
        () =>
          [] as Array<{ id: string; hostPort: number | null; activeDeploymentId: string | null }>,
      )
  ).filter((p) => !excludeProjectId || p.id !== excludeProjectId);

  const pinned = new Set<number>();
  const activeDeploymentIds: string[] = [];

  for (const p of otherProjects) {
    if (typeof p.hostPort === "number" && p.hostPort > 0) {
      pinned.add(p.hostPort);
    }
    if (p.activeDeploymentId) {
      activeDeploymentIds.push(p.activeDeploymentId);
    }
  }

  if (activeDeploymentIds.length > 0) {
    const serviceDepsMap = await repos.serviceDeployment
      .listByDeployments(activeDeploymentIds)
      .catch(() => new Map<string, Array<{ hostPort: number | null }>>());

    for (const deps of serviceDepsMap.values()) {
      for (const sd of deps) {
        if (typeof sd.hostPort === "number" && sd.hostPort > 0) {
          pinned.add(sd.hostPort);
        }
      }
    }
  }

  return Array.from(pinned);
}
