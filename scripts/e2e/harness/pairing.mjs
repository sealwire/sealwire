import assert from "node:assert/strict";

export async function openSecurityModal(page) {
  const isOpen = await page.evaluate(() =>
    Boolean(document.querySelector("#security-modal")?.open)
  );
  if (isOpen) {
    return;
  }

  await page.click("#open-security-header");
  await page.waitForFunction(() => {
    const dialog = document.querySelector("#security-modal");
    return Boolean(dialog?.open);
  });
}

export async function closeSecurityModal(page, timeoutMs) {
  const isOpen = await page.evaluate(() =>
    Boolean(document.querySelector("#security-modal")?.open)
  );
  if (!isOpen) {
    return;
  }

  await page.click("#close-security-modal");
  await page.waitForFunction(
    () => {
      const dialog = document.querySelector("#security-modal");
      return !dialog?.open;
    },
    null,
    { timeout: timeoutMs }
  );
}

export async function startPairingFromLocalPage(
  localPage,
  { lanIp, brokerPort, timeoutMs, previousUrl = "" }
) {
  await openSecurityModal(localPage);
  await localPage.click("#start-pairing-button");
  await localPage.waitForFunction(
    (previous) => {
      const input = document.querySelector("#pairing-link-input");
      return Boolean(
        input &&
          input.value.startsWith("http") &&
          (!previous || input.value !== previous)
      );
    },
    previousUrl,
    { timeout: timeoutMs }
  );
  const pairingUrl = await localPage.inputValue("#pairing-link-input");
  assert.ok(
    pairingUrl.startsWith(`http://${lanIp}:${brokerPort}/?pairing=`),
    `pairing url should use broker public url, got: ${pairingUrl}`
  );
  return pairingUrl;
}

export async function approvePairing(localPage, timeoutMs) {
  const approveSelector = "[data-pairing-id][data-pairing-decision='approve']";
  const modalApproveSelector = `#pairing-approval-modal[open] ${approveSelector}`;
  await localPage.waitForFunction(
    ({ approveSelector, modalApproveSelector }) =>
      Boolean(
        document.querySelector(modalApproveSelector) ||
          document.querySelector(approveSelector)
      ),
    { approveSelector, modalApproveSelector },
    { timeout: timeoutMs }
  );

  const modalApproveButton = localPage.locator(modalApproveSelector).first();
  if ((await modalApproveButton.count()) > 0) {
    await modalApproveButton.click({ timeout: timeoutMs });
    return;
  }

  await localPage.locator(approveSelector).first().click({ timeout: timeoutMs });
}

export async function waitForPairedRemote(remotePage, timeoutMs) {
  await remotePage.waitForFunction(
    () => {
      const stored = [
        "agent-relay.remote-state",
        "agent-relay.remote-state-v3",
        "agent-relay.remote-state-v2",
      ]
        .map((key) => {
          try {
            return JSON.parse(window.localStorage.getItem(key) || "null");
          } catch {
            return null;
          }
        })
        .find((value) => value?.remoteProfiles);
      const profiles = stored?.remoteProfiles || {};
      return Boolean(
        Object.keys(profiles).length &&
          (stored.activeRelayId || stored.clientAuth?.clientId)
      );
    },
    null,
    { timeout: timeoutMs }
  );
}
