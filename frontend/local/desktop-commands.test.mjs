import { test } from "node:test";
import assert from "node:assert/strict";
import { DESKTOP_COMMAND_EVENT, listenForDesktopCommands } from "./desktop-commands.js";

function setup() {
  const target = new EventTarget();
  const calls = [];
  const stop = listenForDesktopCommands(target, {
    openSettings: (tab) => calls.push(["openSettings", tab]),
    setTheme: (theme) => calls.push(["setTheme", theme]),
  });
  const send = (detail) => target.dispatchEvent(new CustomEvent(DESKTOP_COMMAND_EVENT, { detail }));
  return { calls, send, stop };
}

test("the menu-bar Settings items open that settings page", () => {
  const { calls, send } = setup();
  send({ command: "open-settings", tab: "devices" });
  assert.deepEqual(calls, [["openSettings", "devices"]]);
});

test("the menu-bar Theme items set the page theme", () => {
  const { calls, send } = setup();
  send({ command: "set-theme", theme: "dark" });
  assert.deepEqual(calls, [["setTheme", "dark"]]);
});

test("unknown or empty commands are ignored, and the listener can be removed", () => {
  const { calls, send, stop } = setup();
  send({ command: "format-disk" });
  send(undefined);
  stop();
  send({ command: "open-settings", tab: "access" });
  assert.deepEqual(calls, []);
});
