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
  await localPage.waitForFunction(
    () =>
      Boolean(document.querySelector("[data-pairing-id][data-pairing-decision='approve']")),
    null,
    { timeout: timeoutMs }
  );
  await localPage.click("[data-pairing-id][data-pairing-decision='approve']");
}

export async function waitForPairedRemote(remotePage, timeoutMs) {
  await remotePage.waitForFunction(
    () => {
      const stored = JSON.parse(
        window.localStorage.getItem("agent-relay.remote-state") ||
          window.localStorage.getItem("agent-relay.remote-state-v2") ||
          "null"
      );
      return Boolean(
        stored?.clientAuth?.clientId && Object.keys(stored?.remoteProfiles || {}).length
      );
    },
    null,
    { timeout: timeoutMs }
  );
}
