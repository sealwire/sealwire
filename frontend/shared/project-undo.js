// An empty project skips its confirm, so it gets an Undo: creating the name again, as no
// membership was lost. `isStillCurrent` voids an Undo raised somewhere you have since left.
import { t } from "./i18n.js";

export function offerProjectUndo({
  name,
  sessionCount = 0,
  recreate,
  showUndo,
  isStillCurrent = () => true,
}) {
  if (sessionCount) {
    return false;
  }
  showUndo({
    message: t("Deleted project “{name}”.", { name }),
    onUndo: () => (isStillCurrent() ? recreate(name) : undefined),
  });
  return true;
}
