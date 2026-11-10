/**
 * An issue named the way a thread link names one: which tracker, the host it is served from, the
 * scope the tracker addresses it by, and the issue's native key within that scope.
 *
 * `host` and `scope` are written the way `resolveGitHostBinding` writes a project's binding —
 * lower case, the full repository path below the host — because links are matched against those.
 */
export interface IssueLink {
  readonly tracker: string;
  readonly host: string;
  readonly scope: string;
  readonly key: string;
}

/** The host itself, one of its subdomains, or an install named after the provider. */
function isHostOf(hostname: string, apex: string, label?: string): boolean {
  if (hostname === apex || hostname.endsWith(`.${apex}`)) return true;
  return label !== undefined && hostname.split(".").includes(label);
}

/**
 * Each host is recognised only by a path shape it alone uses, from a plausible hostname; GitLab's
 * `/-/` is trusted anywhere, `/issues/` only on GitHub- or Forgejo-like hosts. Standalone tracker
 * URLs are not recognised: their scope needs the project binding.
 */
export function parseIssueUrl(targetUrl: string): IssueLink | null {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();

  // GitLab, self-hosted included: /{group}/[{subgroup}/...]{repo}/-/issues/{n}
  const gitlab = /^\/([^/]+(?:\/[^/]+)+)\/-\/issues\/(\d+)(?:\/|$)/u.exec(url.pathname);
  if (gitlab) return claim("gitlab", host, gitlab);
  // Azure DevOps work items: /{org}/{project}/_workitems/edit/{n}. The scope is the repository
  // path the project binding writes, which a work item URL does not carry, so the organisation
  // and project stand in for it; the service matches by host and prefix.
  if (isHostOf(host, "dev.azure.com") || host.endsWith(".visualstudio.com")) {
    const match = /^\/([^/]+\/[^/]+)\/_workitems\/edit\/(\d+)(?:\/|$)/u.exec(url.pathname);
    return claim("azure-devops", host, match);
  }
  // GitHub, and any Enterprise install: /{owner}/{repo}/issues/{n}
  const twoSegments = /^\/([^/]+\/[^/]+)\/issues\/(\d+)(?:\/|$)/u.exec(url.pathname);
  if (twoSegments && isHostOf(host, "github.com", "github")) {
    return claim("github", host, twoSegments);
  }
  // Forgejo and Gitea write the same shape on arbitrary self-hosted domains, including nested
  // organisations on some installs. Only believed from a host named after them.
  const forgejo = /^\/([^/]+(?:\/[^/]+)+)\/issues\/(\d+)(?:\/|$)/u.exec(url.pathname);
  if (
    forgejo &&
    (isHostOf(host, "codeberg.org") ||
      isHostOf(host, "forgejo.org", "forgejo") ||
      isHostOf(host, "gitea.com", "gitea"))
  ) {
    return claim("forgejo", host, forgejo);
  }
  return null;
}

function claim(tracker: string, host: string, match: RegExpExecArray | null): IssueLink | null {
  const scope = match?.[1];
  const key = match?.[2];
  return scope && key && Number.isSafeInteger(Number(key)) && Number(key) > 0
    ? { tracker, host, scope: scope.toLowerCase(), key }
    : null;
}
