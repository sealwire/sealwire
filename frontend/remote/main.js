import { applyDocumentLanguage } from "../shared/i18n.js";
import { mountRemoteApp } from "./react-app.js";

// iOS Safari ignores user-scalable=no, so its pinch has to be cancelled here. Touch devices
// only: Mac Safari sends the same event for a trackpad pinch, and that should still zoom.
if (navigator.maxTouchPoints > 0) {
  document.addEventListener("gesturestart", (event) => event.preventDefault());
}

applyDocumentLanguage();
mountRemoteApp();
