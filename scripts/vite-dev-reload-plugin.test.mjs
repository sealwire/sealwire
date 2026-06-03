import assert from "node:assert/strict";
import test from "node:test";

import { devReloadPlugin } from "./vite-dev-reload-plugin.mjs";

function withEnv(env, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("dev reload client is injected as an external script, never inline (CSP-safe)", () => {
  withEnv({ RELAY_DEV_RELOAD: "1", RELAY_DEV_RELOAD_PORT: "5174" }, () => {
    const plugin = devReloadPlugin();
    const tags = plugin.transformIndexHtml();
    assert.equal(tags.length, 1, "should inject exactly one tag");
    const [tag] = tags;
    assert.equal(tag.tag, "script");
    // The whole point: a src attribute (external, same-origin) so `script-src
    // 'self'` allows it. An inline script (children) would be blocked by CSP.
    assert.ok(tag.attrs?.src, "reload script must be external (have a src)");
    assert.ok(
      tag.attrs.src.startsWith("/"),
      "reload script src must be a same-origin absolute path"
    );
    assert.ok(
      !("children" in tag) || tag.children == null,
      "reload script must NOT be inline (no children) — CSP would block it"
    );
  });
});

test("the emitted reload asset path matches the injected src", () => {
  withEnv({ RELAY_DEV_RELOAD: "1" }, () => {
    const plugin = devReloadPlugin();
    const emitted = [];
    plugin.generateBundle.call(
      {
        emitFile(file) {
          emitted.push(file);
        },
      }
    );
    assert.equal(emitted.length, 1, "should emit exactly one asset");
    const [asset] = emitted;
    assert.equal(asset.type, "asset");
    const [tag] = plugin.transformIndexHtml();
    assert.equal(
      tag.attrs.src,
      `/static/${asset.fileName}`,
      "injected src must point at the emitted asset under /static"
    );
    assert.match(asset.source, /EventSource/, "asset should contain the reload client");
  });
});

test("plugin is a no-op when RELAY_DEV_RELOAD is unset", () => {
  withEnv({ RELAY_DEV_RELOAD: undefined }, () => {
    const plugin = devReloadPlugin();
    assert.equal(plugin.name, "agent-relay-dev-reload-disabled");
    assert.equal(typeof plugin.transformIndexHtml, "undefined");
  });
});
