import React from "react";

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
      const result = await window.sealwireNative.scanQrCode();
      if (result?.value) {
        onScanned(result.value);
      }
    } catch (scanError) {
      setError(scanError?.message || String(scanError));
    }
  }

  return h(
    "div",
    { className: "scan-pairing" },
    h(
      "button",
      { className: "settings-button is-primary", onClick: () => void scan(), type: "button" },
      "Scan QR code"
    ),
    error ? h("p", { className: "scan-pairing-error", role: "alert" }, error) : null
  );
}
