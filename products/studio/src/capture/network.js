import http from "node:http";
import net from "node:net";
import { lookup } from "node:dns/promises";

// R1 deliberately supports IPv4 only. Resolve once and connect to that exact
// checked address: a second browser-side DNS lookup must not undo the gate.
export function isPublicIPv4(address) {
  if (net.isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

export function parseCaptureUrl(input) {
  if (typeof input !== "string" || input.length > 2048)
    throw new Error("Enter an HTTP or HTTPS URL (maximum 2048 characters).");
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Enter a valid HTTP or HTTPS URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Capture requires HTTP/HTTPS without URL credentials.");
  if (net.isIP(url.hostname.replaceAll(/[\[\]]/g, "")) === 6)
    throw new Error("IPv6-only capture is not supported in R1.");
  if (
    net.isIP(url.hostname) === 4 &&
    !isPublicIPv4(url.hostname) &&
    !url.hostname.startsWith("127.")
  )
    throw new Error(
      "Capture cannot access private or metadata network addresses.",
    );
  if (
    url.hostname !== "localhost" &&
    !url.hostname.startsWith("127.") &&
    url.port &&
    !["80", "443"].includes(url.port)
  )
    throw new Error("Public capture supports HTTP/HTTPS standard ports only.");
  return url;
}

export async function resolveTarget(url, selectedUrl, resolver = lookup) {
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Unsupported network target.");
  const localSelected =
    selectedUrl.hostname === "localhost" ||
    (net.isIP(selectedUrl.hostname) === 4 &&
      selectedUrl.hostname.startsWith("127."));
  const exactLocal = localSelected && url.origin === selectedUrl.origin;
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!exactLocal && ![80, 443].includes(port))
    throw new Error(
      "Only the selected loopback origin or public standard ports are allowed.",
    );
  let timeout;
  const addresses = await Promise.race([
    resolver(url.hostname, { family: 4, all: true }),
    new Promise((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error("Capture DNS lookup timed out.")),
        5000,
      );
      timeout.unref();
    }),
  ]).finally(() => clearTimeout(timeout));
  if (
    !addresses.length ||
    addresses.some(
      ({ address }) =>
        !isPublicIPv4(address) && !(exactLocal && address.startsWith("127.")),
    )
  )
    throw new Error(
      "Private, reserved, and metadata network addresses are blocked.",
    );
  return { address: addresses[0].address, port };
}

export async function createCaptureProxy(selectedUrl) {
  const sockets = new Set();
  let closed = false;
  const track = (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.setTimeout(15000, () => socket.destroy());
    return socket;
  };
  let transferred = 0;
  const limit = (chunk) => {
    transferred += chunk.length;
    if (transferred > 100 * 1024 * 1024)
      for (const socket of sockets) socket.destroy();
  };
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url);
      if (url.protocol !== "http:")
        throw new Error("HTTP proxy requires HTTP URL.");
      const target = await resolveTarget(url, selectedUrl);
      if (closed || request.destroyed) throw new Error("Capture proxy closed.");
      const headers = { ...request.headers, host: url.host };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      const upstream = http.request(
        {
          hostname: target.address,
          port: target.port,
          method: request.method,
          path: url.pathname + url.search,
          headers,
        },
        (remote) => {
          response.writeHead(remote.statusCode, remote.headers);
          remote.on("data", limit);
          remote.pipe(response);
        },
      );
      upstream.on("socket", track);
      upstream.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end("Capture network request failed.");
      });
      request.on("data", limit);
      request.pipe(upstream);
      response.on("close", () => upstream.destroy());
    } catch {
      response.writeHead(403);
      response.end("Capture blocked a private or unsupported network target.");
    }
  });
  server.on("connection", track);
  server.on("connect", async (request, socket, head) => {
    try {
      const target = await resolveTarget(
        new URL(`https://${request.url}`),
        selectedUrl,
      );
      if (closed || socket.destroyed) return;
      const upstream = track(
        net.connect(target.port, target.address, () => {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) upstream.write(head);
          socket.on("data", limit);
          upstream.on("data", limit);
          socket.pipe(upstream);
          upstream.pipe(socket);
        }),
      );
      upstream.on("error", () => socket.destroy());
      socket.on("close", () => upstream.destroy());
    } catch {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    }
  });
  server.on("upgrade", (_request, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    server: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
