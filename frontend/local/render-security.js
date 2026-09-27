import React from "react";
import { createRoot } from "react-dom/client";
import { pairingApprovalList } from "./dom.js";
import { PendingPairingRequestsList } from "../shared/security-panels.js";

const h = React.createElement;
const rootsByElement = new WeakMap();

let helpers = {
  formatTimestamp(value) {
    return String(value);
  },
  shortId(value) {
    return String(value);
  },
};

export function configureSecurityRenderers(nextHelpers) {
  helpers = {
    ...helpers,
    ...nextHelpers,
  };
}

export function renderPairingApprovalModal(requests = [], pendingDecisions = {}) {
  renderReactContent(
    pairingApprovalList,
    h(PendingPairingRequestsList, {
      formatTimestamp: helpers.formatTimestamp,
      requests,
      shortId: helpers.shortId,
      pendingDecisions,
    })
  );
}

function renderReactContent(element, content) {
  if (!element) {
    return;
  }
  let root = rootsByElement.get(element);
  if (!root) {
    root = createRoot(element);
    rootsByElement.set(element, root);
  }
  root.render(content);
}
