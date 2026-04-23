import React from "react";
import { createRoot } from "react-dom/client";
import {
  allowedRootsInput,
  allowedRootsList,
  allowedRootsSummary,
  pairedDevicesList,
  pairingExpiry,
  pairingLinkInput,
  pairingPanel,
  pairingQr,
  pendingPairingsList,
} from "./dom.js";
import { svgDataUrl } from "../svg.js";
import {
  AllowedRootsList,
  DeviceRecordsList,
  PairingQrImage,
  PendingPairingRequestsList,
} from "../shared/security-panels.js";

const h = React.createElement;
const rootsByElement = new WeakMap();

let helpers = {
  formatTimestamp(value) {
    return String(value);
  },
  shortId(value) {
    return String(value);
  },
  workspaceBasename(value) {
    return String(value);
  },
};

export function configureSecurityRenderers(nextHelpers) {
  helpers = {
    ...helpers,
    ...nextHelpers,
  };
}

export function renderPairingPanel(pairing) {
  pairingPanel.hidden = !pairing;

  if (!pairing) {
    renderReactContent(pairingQr, null);
    pairingLinkInput.value = "";
    renderText(pairingExpiry, "Pairing ticket not created yet.");
    return;
  }

  renderReactContent(
    pairingQr,
    h(PairingQrImage, {
      src: svgDataUrl(pairing.pairing_qr_svg),
    })
  );
  pairingLinkInput.value = pairing.pairing_url;
  renderText(pairingExpiry, `Expires ${helpers.formatTimestamp(pairing.expires_at)}`);
}

export function renderAllowedRoots(roots, { draftDirty = false } = {}) {
  const configuredRoots = Array.isArray(roots) ? roots : [];

  if (!draftDirty && allowedRootsInput) {
    allowedRootsInput.value = configuredRoots.join("\n");
  }

  renderText(
    allowedRootsSummary,
    configuredRoots.length
      ? configuredRoots.length === 1
        ? "Every device on this relay is limited to one root directory."
        : `Every device on this relay is limited to ${configuredRoots.length} root directories.`
      : "This relay is currently unrestricted. Any device can start or resume sessions in any workspace."
  );
  renderReactContent(
    allowedRootsList,
    h(AllowedRootsList, {
      roots: configuredRoots,
      workspaceBasename: helpers.workspaceBasename,
    })
  );
}

export function renderDeviceRecords(records = []) {
  renderReactContent(
    pairedDevicesList,
    h(DeviceRecordsList, {
      formatTimestamp: helpers.formatTimestamp,
      records,
      shortId: helpers.shortId,
    })
  );
}

export function renderPendingPairingRequests(requests = []) {
  renderReactContent(
    pendingPairingsList,
    h(PendingPairingRequestsList, {
      formatTimestamp: helpers.formatTimestamp,
      requests,
      shortId: helpers.shortId,
    })
  );
}

function renderText(element, value) {
  renderReactContent(element, value || "");
}

function renderReactContent(element, content) {
  if (!element) {
    return;
  }

  if (element.nodeType !== 1) {
    renderStubContent(element, content);
    return;
  }

  let root = rootsByElement.get(element);
  if (!root) {
    root = createRoot(element);
    rootsByElement.set(element, root);
  }

  root.render(content);
}

function renderStubContent(element, content) {
  const children = flattenStubNodes(content);
  element.children = children;
  element.innerHTML = "";
  element.textContent = children.map((child) => child.textContent || "").join("");
}

function flattenStubNodes(content) {
  if (content === null || content === undefined || content === false) {
    return [];
  }

  if (Array.isArray(content)) {
    return content.flatMap(flattenStubNodes);
  }

  if (typeof content === "string" || typeof content === "number") {
    return [{ tagName: "#TEXT", textContent: String(content) }];
  }

  if (typeof content.type === "function") {
    return flattenStubNodes(content.type(content.props || {}));
  }

  if (content.type === React.Fragment) {
    return flattenStubNodes(content.props?.children);
  }

  if (typeof content.type !== "string") {
    return [];
  }

  const props = content.props || {};
  const childNodes = flattenStubNodes(props.children);
  const node = {
    alt: props.alt || "",
    children: childNodes,
    className: props.className || "",
    dataset: propsToDataset(props),
    hidden: Boolean(props.hidden),
    innerHTML: "",
    readOnly: Boolean(props.readOnly),
    src: props.src || "",
    tagName: content.type.toUpperCase(),
    textContent: childNodes.map((child) => child.textContent || "").join(""),
    value: props.value || "",
  };
  return [node];
}

function propsToDataset(props) {
  const dataset = {};
  for (const [key, value] of Object.entries(props)) {
    if (!key.startsWith("data-")) {
      continue;
    }
    dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
  }
  return dataset;
}
