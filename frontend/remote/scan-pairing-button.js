import React from "react";

import { t } from "../shared/i18n.js";
import { isNativeApp } from "./surface-wording.js";

const h = React.createElement;

// App only: in a phone browser the system camera already opens the pairing link there.
// `window.sealwireNative` is installed by the app's native shell.
export function ScanPairingButton({ onScanned }) {
  const [error, setError] = React.useState(null);
  if (!isNativeApp()) {
    return null;
  }

  async function scan() {
    setError(null);
    try {
      const result = await window.sealwireNative.scanQrCode({
        cancelLabel: t("Cancel"),
        hint: t("Point at the pairing QR code in your relay's Settings › Devices."),
      });
      if (result?.value) {
        onScanned(result.value);
      }
    } catch (scanError) {
      setError(scanErrorText(scanError));
    }
  }

  return h(
    "div",
    { className: "scan-pairing" },
    h(
      "button",
      { className: "settings-button is-primary", onClick: () => void scan(), type: "button" },
      t("Scan QR code")
    ),
    error ? h("p", { className: "scan-pairing-error", role: "alert" }, error) : null
  );
}

// The scanner reports a code rather than prose, so the message follows the page's language.
function scanErrorText(error) {
  switch (error?.code) {
    case "no-camera":
      return t("This device has no camera.");
    case "camera-denied":
      return t("Camera access is off for Sealwire. Turn it on in Settings › Sealwire › Camera.");
    case "unavailable":
      return t("The scanner could not open.");
    default:
      return error?.message || String(error);
  }
}
