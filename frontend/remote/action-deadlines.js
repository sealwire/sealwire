export const DEFAULT_ACTION_DEADLINE_MS = 15_000;

// A person's `/delegate` drives a whole turn on the asking agent to write the brief
// before the peer is started, which the relay lets run for five minutes. Giving up
// under that is worse than waiting: the relay carries on and starts the peer anyway,
// so "it timed out" reads as "nothing happened" and the retry delegates twice.
const LONG_DEADLINES_MS = {
  delegate: 330_000,
};

export function actionDeadlineMs(actionType) {
  return LONG_DEADLINES_MS[actionType] || DEFAULT_ACTION_DEADLINE_MS;
}
