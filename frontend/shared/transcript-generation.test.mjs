import test from "node:test";
import assert from "node:assert/strict";

import {
  transcriptPageIsFromAnotherGeneration,
  transcriptPageMatchesGeneration,
} from "./transcript-generation.js";

test("a relay too old to stamp a generation is accepted, exactly as before this existed", () => {
  assert.equal(transcriptPageMatchesGeneration("", ""), true);
  assert.equal(transcriptPageMatchesGeneration(undefined, undefined), true);
});

// The upgrade race, in BOTH orders. Either way one side names a run and the other
// cannot, so there is no basis for calling them the same — and merging is what puts
// one message on screen twice.
test("a generation on only one side is refused, whichever side it is", () => {
  assert.equal(transcriptPageMatchesGeneration("gen-a", ""), false);
  assert.equal(transcriptPageMatchesGeneration("gen-a", undefined), false);
  assert.equal(transcriptPageMatchesGeneration("", "gen-a"), false);
  assert.equal(transcriptPageMatchesGeneration(undefined, "gen-a"), false);
});

test("a page must carry the same generation to be merged", () => {
  assert.equal(transcriptPageMatchesGeneration("gen-a", "gen-a"), true);
  assert.equal(transcriptPageMatchesGeneration("gen-a", "gen-b"), false);
});

test("the session/page convenience wrapper agrees", () => {
  assert.equal(
    transcriptPageIsFromAnotherGeneration(
      { transcript_generation: "gen-a" },
      { transcript_generation: "gen-b" }
    ),
    true
  );
  assert.equal(
    transcriptPageIsFromAnotherGeneration(
      { transcript_generation: "gen-a" },
      { transcript_generation: "gen-a" }
    ),
    false
  );
  assert.equal(transcriptPageIsFromAnotherGeneration({}, {}), false);
});
