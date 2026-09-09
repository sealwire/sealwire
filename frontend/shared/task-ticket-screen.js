// Public seam for the proprietary ticket page (17b). The public stub exports a
// placeholder; `scripts/with-private.sh` swaps the real module into the same
// path before a private-enabled frontend build.
//
// A sibling of the board rather than of `TaskDetail`: this is a full-area screen
// with its own route, and the embedded detail in List mode is untouched by it.
export { TaskTicketScreen } from "../../crates/sealwire-private/frontend/task-ticket-screen.js";
