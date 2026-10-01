// The session menu's Delete… and Archive turn the menu into an in-place confirm
// rather than opening a browser dialog. Returns what the confirm said.
export async function confirmThreadMenuRemoval(page, { timeoutMs = 30000 } = {}) {
  await page.waitForSelector("#thread-menu-confirm:not([hidden]) #thread-menu-confirm-ok", {
    state: "visible",
    timeout: timeoutMs,
  });
  const copy = await page.evaluate(() => ({
    title: document.querySelector("#thread-menu-confirm-title")?.textContent || "",
    body: document.querySelector("#thread-menu-confirm-body")?.textContent || "",
    confirmLabel: document.querySelector("#thread-menu-confirm-ok")?.textContent || "",
  }));
  await page.click("#thread-menu-confirm-ok", { timeout: timeoutMs });
  return copy;
}
