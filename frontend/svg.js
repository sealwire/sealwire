export function svgDataUrl(svgMarkup) {
  const normalized = String(svgMarkup ?? "").trim();
  if (!normalized) {
    return "";
  }

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(normalized)}`;
}
