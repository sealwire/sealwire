import { registerPlugin } from "@capacitor/core";
import { Keyboard } from "@capacitor/keyboard";
import { PushNotifications } from "@capacitor/push-notifications";
import { createNativePush } from "./native-push.js";
import "./native.css";

Keyboard.setAccessoryBarVisible({ isVisible: false }).catch((error) => {
  console.warn("could not hide the keyboard accessory bar", error);
});

// The remote page also ships to browsers, so Capacitor stays behind this bridge.
const QRScanner = registerPlugin("QRScanner");
window.sealwireNative = {
  scanQrCode: (labels) => QRScanner.scan(labels),
  push: createNativePush(PushNotifications, registerPlugin("PushConfiguration")),
};
window.dispatchEvent(new Event("sealwire-native-ready"));
