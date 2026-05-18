import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

import { getFreePort } from "./ports.mjs";

export async function startStaticServer({
  rootDir,
  host = "127.0.0.1",
  indexFile = "index.html",
  pathAliases = {},
  stripStaticPrefix = false,
} = {}) {
  if (!rootDir) {
    throw new Error("startStaticServer requires rootDir");
  }

  const port = await getFreePort(host);
  const resolvedRoot = path.resolve(rootDir);
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${host}:${port}`);
    const relativePath = resolveStaticPath(requestUrl.pathname, {
      indexFile,
      pathAliases,
      stripStaticPrefix,
    });
    let filePath = path.resolve(resolvedRoot, relativePath);
    if (!isPathInside(filePath, resolvedRoot)) {
      response.writeHead(403).end("forbidden");
      return;
    }

    try {
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) {
        filePath = path.join(filePath, indexFile);
      }
      const body = await fs.readFile(filePath);
      response.writeHead(200, {
        "Content-Type": contentType(filePath),
        "Cache-Control": "no-store",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end("not found");
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  return {
    host,
    port,
    server,
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

function resolveStaticPath(pathname, {
  indexFile,
  pathAliases,
  stripStaticPrefix,
}) {
  if (pathname === "/") {
    return indexFile;
  }
  if (Object.prototype.hasOwnProperty.call(pathAliases, pathname)) {
    return pathAliases[pathname];
  }
  if (stripStaticPrefix && pathname.startsWith("/static/")) {
    return pathname.replace(/^\/static\//, "");
  }
  return pathname.replace(/^\/+/, "");
}

function isPathInside(filePath, rootDir) {
  const relative = path.relative(rootDir, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".webmanifest")) return "application/manifest+json";
  return "application/octet-stream";
}
