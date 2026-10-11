const DEFAULT_TIMEOUT_MS = Number(process.env.BROWSER_E2E_TIMEOUT_MS || 45000);

// Open the local sessions drawer the way a user does, and require it to STAY open.
//
// The open state is owned by the thread-list store, not by the element. Every
// render writes `details.open` back from `viewingConversation || activeProjectId
// || threadList.drawerOpen` (frontend/local/render-session.js), and the store only
// hears about a change through the `toggle` listener app.js installs. app.js is a
// module, so it executes AFTER `domcontentloaded` — which is all `page.goto`
// normally waits for. Assigning `.open` from the test therefore opens the drawer
// in the DOM while the store still believes it is shut, and the next render — a
// session snapshot, a search keystroke — closes it again.
//
// What makes that expensive is that a shut `<details>` keeps its rows in the DOM.
// Count-based waits (`querySelectorAll(...).length === n`) go on passing, so the
// failure surfaces steps later at the first thing that needs a VISIBLE row: a
// timeout in a step that has nothing to do with the drawer. That was the nightly
// `browser-local-full-fake` failure, and it reproduces exactly by running the old
// helper at `DOMContentLoaded` — i.e. before the listener exists.
//
// So click the summary, let the browser fire a real `toggle`, and then hold: a
// drawer that springs shut again is the store disagreeing, and retrying the click
// is what lets it be recorded.
export async function openSessionsDrawer(page, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  await page.waitForSelector(".sidebar-drawer-summary", {
    state: "visible",
    timeout: timeoutMs,
  });

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const open = await page.evaluate(() =>
      Boolean(document.querySelector(".sidebar-drawer")?.open)
    );
    if (!open) {
      await page.click(".sidebar-drawer-summary");
    }
    // Hold it: the render that closes it again lands a beat later, so sampling
    // once would pass either way.
    const held = await page
      .evaluate(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () => resolve(Boolean(document.querySelector(".sidebar-drawer")?.open)),
              250
            );
          })
      )
      .catch(() => false);
    if (held) {
      return;
    }
  }

  throw new Error(
    "the sessions drawer would not stay open — the store never recorded the toggle, so a " +
      "render closed it again"
  );
}
