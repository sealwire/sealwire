import { Keyboard } from "@capacitor/keyboard";
import "./native.css";

Keyboard.setAccessoryBarVisible({ isVisible: false }).catch((error) => {
  console.warn("could not hide the keyboard accessory bar", error);
});
