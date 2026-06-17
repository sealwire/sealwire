import test from "node:test";
import assert from "node:assert/strict";

import { isIosSafari, isStandalone, shouldOfferIosInstall } from "./ios-install.js";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1";
const DESKTOP_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const IPAD_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/604.1";

test("isIosSafari: true for iPhone Safari, false for Chrome-iOS and desktop", () => {
  assert.equal(isIosSafari({ userAgent: IPHONE_SAFARI }), true);
  assert.equal(isIosSafari({ userAgent: IPHONE_CHROME }), false);
  assert.equal(
    isIosSafari({ userAgent: DESKTOP_CHROME, platform: "MacIntel", maxTouchPoints: 0 }),
    false,
  );
  assert.equal(isIosSafari(undefined), false);
});

test("isIosSafari: true for iPadOS (desktop UA + touch points)", () => {
  assert.equal(
    isIosSafari({ userAgent: IPAD_SAFARI, platform: "MacIntel", maxTouchPoints: 5 }),
    true,
  );
});

test("isStandalone: detects navigator.standalone and display-mode", () => {
  assert.equal(isStandalone({ navigator: { standalone: true } }), true);
  assert.equal(isStandalone({ matchMedia: () => ({ matches: true }) }), true);
  assert.equal(isStandalone({ navigator: {}, matchMedia: () => ({ matches: false }) }), false);
  assert.equal(isStandalone(undefined), false);
});

test("shouldOfferIosInstall: only iOS Safari, and not when already installed", () => {
  assert.equal(
    shouldOfferIosInstall({ userAgent: IPHONE_SAFARI }, { matchMedia: () => ({ matches: false }) }),
    true,
  );
  assert.equal(
    shouldOfferIosInstall({ userAgent: IPHONE_SAFARI }, { navigator: { standalone: true } }),
    false,
  );
  assert.equal(shouldOfferIosInstall({ userAgent: IPHONE_CHROME }, {}), false);
});
