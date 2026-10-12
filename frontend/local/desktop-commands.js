// The desktop app's menu-bar menu cannot call into this page (it has no IPC here),
// so it dispatches this event on window instead.
export const DESKTOP_COMMAND_EVENT = "sealwire:desktop-command";

export function listenForDesktopCommands(target, { openSettings, setTheme }) {
  const onCommand = (event) => {
    const detail = event?.detail || {};
    if (detail.command === "open-settings") {
      openSettings(detail.tab);
    } else if (detail.command === "set-theme") {
      setTheme(detail.theme);
    }
  };
  target.addEventListener(DESKTOP_COMMAND_EVENT, onCommand);
  return () => target.removeEventListener(DESKTOP_COMMAND_EVENT, onCommand);
}
