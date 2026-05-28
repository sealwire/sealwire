export async function startLocalSession(
  page,
  { cwd, approvalPolicy = "never", effort, provider, model, timeoutMs }
) {
  await openStartSessionDialog(page, timeoutMs);
  await fillFirstAvailable(page, ["#cwd-input"], cwd, timeoutMs);
  if (provider) {
    await selectIfOptionExists(page, ["#provider-input"], provider, timeoutMs);
  }
  if (model) {
    await selectIfOptionExists(page, ["#model-input"], model, timeoutMs);
  }
  await selectFirstAvailable(page, ["#approval-policy-input"], approvalPolicy, timeoutMs);
  if (effort) {
    await selectIfOptionExists(page, ["#start-effort"], effort, timeoutMs);
  }
  await clickFirstAvailable(page, ["#start-session-button"], timeoutMs);
}

async function openStartSessionDialog(page, timeoutMs) {
  const open = await page.evaluate(() =>
    Boolean(document.querySelector("#launch-start-session-dialog")?.open)
  );
  if (open) {
    return;
  }

  const openedDialog = await page.evaluate(() => {
    const dialog = document.querySelector("#launch-start-session-dialog");
    if (!dialog) {
      return false;
    }
    dialog.setAttribute("open", "");
    return true;
  });
  if (openedDialog) {
    await page.waitForFunction(
      () => Boolean(document.querySelector("#launch-start-session-dialog")?.open),
      null,
      { timeout: timeoutMs }
    );
  }
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
  return page
    .waitForFunction(
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
    )
    .then((handle) => handle.jsonValue());
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
          const hasOption = [...(element.options || [])].some(
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
