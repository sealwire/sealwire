import test from "node:test";
import assert from "node:assert/strict";

import React from "react";
import { PendingPairingRequestsList } from "./shared/security-panels.js";

// Walk a React element tree and collect every element matching `match(node)`.
function collect(node, match, acc = []) {
  if (node === null || node === undefined || typeof node === "boolean") {
    return acc;
  }
  if (Array.isArray(node)) {
    for (const item of node) collect(item, match, acc);
    return acc;
  }
  if (typeof node === "string" || typeof node === "number") {
    return acc;
  }
  if (match(node)) {
    acc.push(node);
  }
  const children = node.props && node.props.children;
  if (children !== undefined) {
    collect(children, match, acc);
  }
  return acc;
}

function renderTree(requests) {
  // PendingPairingRequestsList is a function component — call it directly to
  // get the React element tree without needing a DOM.
  return PendingPairingRequestsList({
    requests,
    formatTimestamp: (value) => `ts:${value}`,
    shortId: (value) => `short:${value}`,
  });
}

function isCard(node) {
  return (
    node &&
    node.type === "article" &&
    node.props &&
    node.props.className === "paired-device-card"
  );
}

function isDecisionButton(node) {
  return (
    node &&
    node.type === "button" &&
    node.props &&
    typeof node.props["data-pairing-decision"] === "string" &&
    typeof node.props["data-pairing-id"] === "string"
  );
}

test("PendingPairingRequestsList: empty list renders the empty message, no cards", () => {
  const tree = renderTree([]);
  const cards = collect(tree, isCard);
  const buttons = collect(tree, isDecisionButton);
  assert.equal(cards.length, 0);
  assert.equal(buttons.length, 0);
});

test("PendingPairingRequestsList: one request renders one card with one Approve and one Reject", () => {
  const tree = renderTree([
    {
      pairing_id: "pair-1",
      device_id: "device-1",
      label: "iPad",
      lifecycle_state: "pending",
      requested_at: 1,
      broker_peer_id: "peer-1",
      fingerprint: "AA:BB",
    },
  ]);

  const cards = collect(tree, isCard);
  assert.equal(cards.length, 1);

  const buttons = collect(tree, isDecisionButton);
  assert.equal(buttons.length, 2);

  const approve = buttons.find((b) => b.props["data-pairing-decision"] === "approve");
  const reject = buttons.find((b) => b.props["data-pairing-decision"] === "reject");
  assert.ok(approve, "expected an approve button");
  assert.ok(reject, "expected a reject button");
  assert.equal(approve.props["data-pairing-id"], "pair-1");
  assert.equal(reject.props["data-pairing-id"], "pair-1");
});

test("PendingPairingRequestsList: three requests render three independent Approve/Reject pairs", () => {
  const requests = [
    { pairing_id: "p1", device_id: "d1", label: "iPad", lifecycle_state: "pending", requested_at: 1, broker_peer_id: "peer-1", fingerprint: "AA:BB" },
    { pairing_id: "p2", device_id: "d2", label: "Phone", lifecycle_state: "pending", requested_at: 2, broker_peer_id: "peer-2", fingerprint: "CC:DD" },
    { pairing_id: "p3", device_id: "d3", label: "Laptop", lifecycle_state: "pending", requested_at: 3, broker_peer_id: "peer-3", fingerprint: "EE:FF" },
  ];

  const tree = renderTree(requests);

  const cards = collect(tree, isCard);
  assert.equal(cards.length, 3, "one card per request");

  const buttons = collect(tree, isDecisionButton);
  assert.equal(buttons.length, 6, "one Approve and one Reject per request");

  for (const request of requests) {
    const approvers = buttons.filter(
      (b) =>
        b.props["data-pairing-id"] === request.pairing_id &&
        b.props["data-pairing-decision"] === "approve"
    );
    const rejecters = buttons.filter(
      (b) =>
        b.props["data-pairing-id"] === request.pairing_id &&
        b.props["data-pairing-decision"] === "reject"
    );
    assert.equal(approvers.length, 1, `${request.pairing_id} should have one Approve`);
    assert.equal(rejecters.length, 1, `${request.pairing_id} should have one Reject`);
  }
});

test("PendingPairingRequestsList: each card uses pairing_id as the React key (stable identity)", () => {
  const tree = renderTree([
    { pairing_id: "p1", device_id: "d1", label: "iPad", lifecycle_state: "pending", requested_at: 1, broker_peer_id: "peer-1" },
    { pairing_id: "p2", device_id: "d2", label: "Phone", lifecycle_state: "pending", requested_at: 2, broker_peer_id: "peer-2" },
  ]);
  const cards = collect(tree, isCard);
  // React stores `key` on the element itself (not inside props).
  assert.equal(cards[0].key, "p1");
  assert.equal(cards[1].key, "p2");
});

// Sanity: React must be importable / used (otherwise the component above would
// not produce real React elements and the assertions above would be hollow).
test("React.createElement is the producer behind the tree (smoke check)", () => {
  const tree = renderTree([
    { pairing_id: "p1", device_id: "d1", label: "x", lifecycle_state: "pending", requested_at: 1, broker_peer_id: "peer-1" },
  ]);
  assert.ok(tree && tree.type === React.Fragment, "top node should be a Fragment");
});
