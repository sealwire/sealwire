import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { startupView } from "./startup-view.mjs";
import "./desktop.css";

const root = document.querySelector("#desktop-root");

listen("desktop://status", (event) => render(event?.payload));
refresh();

async function refresh() {
  try {
    render(await invoke("desktop_status"));
  } catch (error) {
    render({ phase: "failed", message: formatError(error), logs: [] });
  }
}

function render(status) {
  const view = startupView(status);
  root.replaceChildren(
    el("div", { className: "startup", "data-state": view.state }, [
      el("img", { className: "startup-mark", alt: "", src: "/sealwire_mark.png" }),
      el("p", { className: "startup-title", role: "status" }, [view.title]),
      view.detail ? el("p", { className: "startup-detail" }, [view.detail]) : null,
      view.canRetry
        ? el("button", { className: "startup-retry", type: "button", onclick: retry }, ["Try again"])
        : null,
      view.logs.length
        ? el("details", { className: "startup-logs" }, [
            el("summary", {}, ["Details"]),
            el("pre", {}, [view.logs.join("\n")]),
          ])
        : null,
    ]),
  );
}

async function retry(event) {
  event.currentTarget.disabled = true;
  try {
    await invoke("desktop_retry");
  } catch (error) {
    render({ phase: "failed", message: formatError(error), logs: [] });
  }
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "className") {
      node.className = value;
    } else if (key === "onclick") {
      node.addEventListener("click", value);
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of children) {
    if (child !== null && child !== undefined) {
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }
  return node;
}

function formatError(error) {
  return typeof error === "string" ? error : error?.message || String(error);
}
