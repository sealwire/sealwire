import React from "react";

// Public-checkout placeholder. A public relay has no task-team driver, so no run
// has a ticket page; keeping the export lets the frontend still build and keeps
// the proprietary module out of this tree.
export function TaskTicketScreen() {
  return React.createElement(React.Fragment);
}
