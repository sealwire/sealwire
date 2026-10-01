// Match the label span, never the row. The row also renders its session count, so an
// anchored regex on the row's text cannot match.

export function projectSwitcherOption(page, label, { scope = "" } = {}) {
  const prefix = scope ? `${scope} ` : "";
  return page
    .locator(`${prefix}.project-switcher-option`)
    .filter({
      has: page.locator(".project-switcher-option-label", {
        hasText: new RegExp(`^${escapeRegExp(label)}$`),
      }),
    })
    .first();
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
