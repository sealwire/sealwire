const BUILD_BADGE_ID = "build-badge";
const BUILD_META_URL = `${import.meta.env.BASE_URL}build-meta.json`;

let cachedBuildInfo = null;

export async function fetchBuildInfo(surface = "broker") {
  if (cachedBuildInfo) {
    return cachedBuildInfo;
  }

  if (import.meta.env.DEV) {
    cachedBuildInfo = {
      label: `${surface} · dev live`,
      title: `Dev server · ${window.location.origin}`,
    };
    return cachedBuildInfo;
  }

  try {
    const response = await fetch(BUILD_META_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`build metadata request failed: ${response.status}`);
    }

    const buildMeta = await response.json();
    const builtAt = new Date(buildMeta.builtAtIso);
    const builtAtLabel = Number.isNaN(builtAt.getTime())
      ? buildMeta.builtAtIso || "unknown time"
      : new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(builtAt);

    cachedBuildInfo = {
      label: `${surface} · ${builtAtLabel} · ${buildMeta.buildId || "unknown-build"}`,
      title: `Build ${buildMeta.buildId || "unknown-build"}\nBuilt at ${buildMeta.builtAtIso || builtAtLabel}\nServed from ${window.location.origin}`,
    };
  } catch (error) {
    cachedBuildInfo = {
      label: `${surface} · build unknown`,
      title: error instanceof Error ? error.message : "Build metadata unavailable",
    };
  }

  return cachedBuildInfo;
}

export async function mountBuildBadge(options = {}) {
  const { surface = "broker" } = options;
  document.querySelector(`#${BUILD_BADGE_ID}`)?.remove();

  const badge = document.createElement("div");
  badge.id = BUILD_BADGE_ID;
  badge.className = "build-badge";
  badge.textContent = `${surface} · loading build...`;
  badge.title = "Loading build metadata";
  document.body.appendChild(badge);

  const info = await fetchBuildInfo(surface);
  badge.textContent = info.label;
  badge.title = info.title;
}
