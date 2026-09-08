import { randomUUID } from "node:crypto";

// Ids for the things a person has to come back and act on — a question, an
// approval.
//
// These were a counter in main(), unique only for the life of one worker
// process. The surfaces cache against them (a half-typed answer, a fetched
// question body, a submit error) and those caches outlive the worker, so after a
// restart a brand-new "ask:1" met the cached "ask:1" and inherited it: one
// question's text over another question's options, with nothing on screen to
// suggest anything was wrong. Random ids retire the whole class rather than
// asking every cache to defend itself.
export function createRequestIdMinter() {
  return () => randomUUID();
}
