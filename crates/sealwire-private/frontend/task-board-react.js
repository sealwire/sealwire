import React from "react";

// Public-checkout placeholder. A public relay has no task-team driver, so the
// board has nothing to lay out; keeping the export lets the frontend still build
// and keeps the proprietary module out of this tree.
export function TaskBoard() {
  return React.createElement(React.Fragment);
}
