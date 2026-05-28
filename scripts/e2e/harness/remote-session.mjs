export async function openRemoteSessionPanel(page, timeoutMs) {
  await selectFirstRelayIfNeeded(page, timeoutMs);
  await page.click("#remote-session-toggle");
  await page.waitForFunction(
    () => {
      const dialog = document.querySelector("#remote-start-session-dialog");
      if (dialog?.open) {
        return true;
      }
      const panel = document.querySelector("#remote-session-panel");
      return Boolean(panel && !panel.hidden);
    },
    null,
    { timeout: timeoutMs }
  );
  const hasLegacyPanel = await page.evaluate(() =>
    Boolean(document.querySelector("#remote-session-panel"))
  );
  if (hasLegacyPanel) {
    await page.click("#remote-session-panel summary");
    await page.waitForFunction(
      () => {
        const details = document.querySelector("#remote-session-panel details");
        return Boolean(details && details.open);
      },
      null,
      { timeout: timeoutMs }
    );
  }
}

export async function selectFirstRelayIfNeeded(page, timeoutMs) {
  const needsSelection = await page.evaluate(() => {
    const toggle = document.querySelector("#remote-session-toggle");
    return Boolean(toggle?.disabled);
  });
  if (!needsSelection) {
    return;
  }

  await page.click("#remote-relays-list [data-relay-id]:not([disabled])");
  await page.waitForFunction(
    () => {
      const toggle = document.querySelector("#remote-session-toggle");
      return Boolean(toggle && !toggle.disabled);
    },
    null,
    { timeout: timeoutMs }
  );
}

export async function waitForRemoteMessageInput(page, timeoutMs) {
  await page.waitForFunction(
    () => {
      const input = document.querySelector("#remote-message-input");
      return Boolean(input && !input.disabled);
    },
    null,
    { timeout: timeoutMs }
  );
}

export async function startRemoteSession(
  page,
  { cwd, approvalPolicy = "never", effort, timeoutMs }
) {
  await openRemoteSessionPanel(page, timeoutMs);
  await selectIfOptionExists(page, [
    "#remote-provider-input",
    "#remote-launch-provider-input",
  ], "fake", timeoutMs);
  await selectIfOptionExists(page, [
    "#remote-model-input",
    "#remote-launch-model-input",
  ], "fake-echo", timeoutMs);
  await selectFirstAvailable(page, [
    "#remote-approval-policy-input",
    "#remote-launch-approval-policy-input",
  ], approvalPolicy, timeoutMs);
  if (effort) {
    await selectIfOptionExists(page, [
      "#remote-start-effort",
      "#remote-launch-start-effort",
    ], effort, timeoutMs);
  }
  await fillFirstAvailable(page, [
    "#remote-cwd-input",
    "#remote-start-session-dialog-cwd",
  ], cwd, timeoutMs);
  await clickFirstAvailable(page, [
    "#remote-start-session-button",
    "#remote-start-session-dialog-start",
  ], timeoutMs);
  await page.evaluate(() => {
    document.querySelector("#remote-start-session-dialog")?.close?.();
  });
}

export async function sendPromptAndWaitForReply(page, prompt, { timeoutMs, expectedReply } = {}) {
  await waitForRemoteMessageInput(page, timeoutMs);
  await page.fill("#remote-message-input", prompt);
  await page.click("#remote-send-button");

  const reply = expectedReply ?? prompt.replace("Reply with exactly: ", "");
  await page.waitForFunction(
    (expected) => {
      const transcript = document.querySelector("#remote-transcript")?.textContent || "";
      return transcript.includes(expected);
    },
    reply,
    { timeout: timeoutMs }
  );
}

async function selectFirstAvailable(page, selectors, value, timeoutMs) {
  const selector = await waitForUsableSelector(page, selectors, timeoutMs);
  await page.selectOption(selector, value);
}

async function selectIfOptionExists(page, selectors, value, timeoutMs) {
  const selector = await waitForOptionalSelectorWithOption(page, selectors, value, timeoutMs);
  if (selector) {
    await page.selectOption(selector, value);
  }
}

async function fillFirstAvailable(page, selectors, value, timeoutMs) {
  const selector = await waitForUsableSelector(page, selectors, timeoutMs);
  await page.fill(selector, value);
}

async function clickFirstAvailable(page, selectors, timeoutMs) {
  const selector = await waitForUsableSelector(page, selectors, timeoutMs);
  await page.click(selector);
}

async function waitForUsableSelector(page, selectors, timeoutMs) {
  return page.waitForFunction(
    (candidateSelectors) => {
      for (const selector of candidateSelectors) {
        const element = document.querySelector(selector);
        if (!element) {
          continue;
        }
        const style = window.getComputedStyle(element);
        const visible = style.visibility !== "hidden" && style.display !== "none";
        if (visible && !element.disabled) {
          return selector;
        }
      }
      return null;
    },
    selectors,
    { timeout: timeoutMs }
  ).then((handle) => handle.jsonValue());
}

async function waitForOptionalSelectorWithOption(page, selectors, value, timeoutMs) {
  const deadline = Date.now() + Math.min(timeoutMs ?? 0, 5000);
  while (Date.now() < deadline) {
    const selector = await page.evaluate(
      ({ candidateSelectors, expectedValue }) => {
        for (const selector of candidateSelectors) {
          const element = document.querySelector(selector);
          if (!element || element.disabled) {
            continue;
          }
          const style = window.getComputedStyle(element);
          const visible = style.visibility !== "hidden" && style.display !== "none";
          const hasOption = [...element.options || []].some(
            (option) => option.value === expectedValue
          );
          if (visible && hasOption) {
            return selector;
          }
        }
        return null;
      },
      { candidateSelectors: selectors, expectedValue: value }
    );
    if (selector) {
      return selector;
    }
    await page.waitForTimeout(100);
  }
  return null;
}
