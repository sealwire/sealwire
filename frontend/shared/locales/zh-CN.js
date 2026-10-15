// Keyed by the English the UI passes to t(). One file per area of the UI, so several people
// can translate at once; a test fails if two areas give the same English different Chinese.
import common from "./zh-CN/common.js";
import local from "./zh-CN/local.js";
import remote from "./zh-CN/remote.js";
import shared from "./zh-CN/shared.js";
import tasks from "./zh-CN/tasks.js";
import transcript from "./zh-CN/transcript.js";

export const parts = { common, local, remote, shared, tasks, transcript };

export default Object.assign({}, ...Object.values(parts));
