// Public seam for the proprietary Tasks board (16a). The public stub exports a
// placeholder; `scripts/with-private.sh` swaps the real module into the same
// path before a private-enabled frontend build.
//
// Separate from the Tasks shell in `task-team-react.js`, which stays public: the
// toolbar, the List/Board switch and the task detail are not the board.
export { TaskBoard } from "../../crates/sealwire-private/frontend/task-board-react.js";
