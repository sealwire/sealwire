import { registerPlugin } from "@capacitor/core";
import { Keyboard } from "@capacitor/keyboard";
import "./native.css";

Keyboard.setAccessoryBarVisible({ isVisible: false }).catch((error) => {
  console.warn("could not hide the keyboard accessory bar", error);
});

// The remote page cannot import Capacitor (it also ships to browsers), so the scanner
// reaches it through this global.
const QRScanner = registerPlugin("QRScanner");
window.sealwireNative = { scanQrCode: () => QRScanner.scan() };
