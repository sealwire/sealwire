const BUILD_BADGE_ID = "build-badge";
const BUILD_META_URL = `${import.meta.env.BASE_URL}build-meta.json`;

export async function mountBuildBadge(options = {}) {
  const { surface = "broker" } = options;
  document.querySelector(`#${BUILD_BADGE_ID}`)?.remove();

  const badge = document.createElement("div");
  badge.id = BUILD_BADGE_ID;
  badge.className = "build-badge";
  badge.textContent = `${surface} · loading build...`;
  badge.title = "Loading build metadata";
  document.body.appendChild(badge);

  if (import.meta.env.DEV) {
    badge.textContent = `${surface} · dev live`;
    badge.title = `Dev server · ${window.location.origin}`;
    return;
  }

  try {
    const response = await fetch(BUILD_META_URL, {
      cache: "no-store",
    });
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

    badge.textContent = `${surface} · ${builtAtLabel} · ${buildMeta.buildId || "unknown-build"}`;
    badge.title = `Build ${buildMeta.buildId || "unknown-build"}\nBuilt at ${buildMeta.builtAtIso || builtAtLabel}\nServed from ${window.location.origin}`;
  } catch (error) {
    badge.textContent = `${surface} · build unknown`;
    badge.title = error instanceof Error ? error.message : "Build metadata unavailable";
  }
}
