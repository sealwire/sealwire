import { useSyncExternalStore } from "react";

import {
  loadRelayNicknames,
  subscribeRelayNicknames,
} from "./relay-nicknames.js";

export function useRelayNicknames() {
  return useSyncExternalStore(
    subscribeRelayNicknames,
    loadRelayNicknames,
    loadRelayNicknames
  );
}
