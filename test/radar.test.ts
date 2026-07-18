import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import {
  atomicWriteFile,
  pruneRadarCache,
  RADAR_CACHE_POLICY,
  setCacheBaseDir,
  writeJsonFile,
} from "../src/bom/cache";
import {
  discoverRadarProducts,
  parseRadarProductsHtml,
} from "../src/bom/catalog";
import { CATALOG_TTL_MS, RADAR_GIF_CACHE_VERSION } from "../src/bom/constants";
import {
  downloadFrame,
  latestFrameTimeMs,
  parseRadarFrames,
  scrapeFrames,
} from "../src/bom/frames";
import { HttpStatusError, httpGetBuffer, httpGetText } from "../src/bom/http";
import {
  isGifBuffer,
  loadOverlayCandidate,
  renderRadarLoop,
} from "../src/bom/render";

test("radar catalogue and frame fixtures parse and deduplicate", () => {
  const catalogue = parseRadarProductsHtml(
    `<a href="/site" title="Mt Test site information.">Mt Test</a>
     <a href="/products/IDR661.loop.shtml">64 km</a>
     <a href="/products/IDR662.loop.shtml">128 km</a>`,
    "QLD",
  );
  assert.deepEqual(
    catalogue.map(({ id, site, label }) => ({ id, site, label })),
    [
      { id: "IDR661", site: "Mt Test", label: "64 km" },
      { id: "IDR662", site: "Mt Test", label: "128 km" },
    ],
  );

  const frames = parseRadarFrames(`
    theImageNames[0] = "/radar/IDR661.T.202607180100.png";
    theImageNames[1] = "/radar/IDR661.T.202607180106.png";
    theImageNames[2] = "/radar/IDR661.T.202607180106.png";
  `);
  assert.equal(frames.length, 2);
  assert.equal(frames[1].timestamp, "202607180106");
});

test("invalid radar timestamps are unknown instead of being treated as now", () => {
  assert.equal(latestFrameTimeMs("not-a-time"), null);
  assert.equal(latestFrameTimeMs("202602300100"), null);
  assert.equal(latestFrameTimeMs("202607180106"), Date.UTC(2026, 6, 18, 1, 6));
});

test("radar HTTP follows redirects and enforces response limits", async () => {
  const server = await startServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: "/payload" }).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/plain" }).end("radar-data");
  });
  try {
    assert.equal(await httpGetText(`${server.url}/redirect`), "radar-data");
    await assert.rejects(
      httpGetBuffer(`${server.url}/payload`, { maxBytes: 4 }),
      /response limit/,
    );
  } finally {
    await server.close();
  }
});

test("radar HTTP retries only bounded transient failures and honors Retry-After cancellation", async () => {
  const requests = new Map<string, number>();
  let signalRetryRequest!: () => void;
  const retryRequestStarted = new Promise<void>((resolve) => {
    signalRetryRequest = resolve;
  });
  const server = await startServer((request, response) => {
    const path = request.url ?? "";
    const count = (requests.get(path) ?? 0) + 1;
    requests.set(path, count);
    if (path === "/reset" && count === 1) {
      request.socket.destroy();
      return;
    }
    if (path === "/transient" && count === 1) {
      response.writeHead(503, { "Retry-After": "0" }).end();
      return;
    }
    if (path === "/limited" && count === 1) {
      response.writeHead(429, { "Retry-After": "0" }).end();
      return;
    }
    if (path === "/persistent") {
      response.writeHead(500).end();
      return;
    }
    if (path === "/single-attempt") {
      response.writeHead(503).end();
      return;
    }
    if (path === "/bad-request") {
      response.writeHead(400).end();
      return;
    }
    if (path === "/cancel-retry") {
      signalRetryRequest();
      response.writeHead(503, { "Retry-After": "120" }).end();
      return;
    }
    response.end("recovered");
  });
  try {
    const fastRetry = { retryBaseDelayMs: 0, retryDelayCapMs: 5 };
    assert.equal(
      (await httpGetBuffer(`${server.url}/reset`, fastRetry)).toString(),
      "recovered",
    );
    assert.equal(
      (await httpGetBuffer(`${server.url}/transient`, fastRetry)).toString(),
      "recovered",
    );
    assert.equal(
      (await httpGetBuffer(`${server.url}/limited`, fastRetry)).toString(),
      "recovered",
    );
    await assert.rejects(
      httpGetBuffer(`${server.url}/persistent`, fastRetry),
      (error: unknown) =>
        error instanceof HttpStatusError && error.status === 500,
    );
    await assert.rejects(
      httpGetBuffer(`${server.url}/bad-request`, fastRetry),
      (error: unknown) =>
        error instanceof HttpStatusError && error.status === 400,
    );
    await assert.rejects(
      httpGetBuffer(`${server.url}/single-attempt`, {
        ...fastRetry,
        maxAttempts: 1,
      }),
      (error: unknown) =>
        error instanceof HttpStatusError && error.status === 503,
    );
    assert.equal(requests.get("/reset"), 2);
    assert.equal(requests.get("/transient"), 2);
    assert.equal(requests.get("/limited"), 2);
    assert.equal(requests.get("/persistent"), 3);
    assert.equal(requests.get("/bad-request"), 1);
    assert.equal(requests.get("/single-attempt"), 1);

    const controller = new AbortController();
    const cancelled = httpGetBuffer(`${server.url}/cancel-retry`, {
      signal: controller.signal,
      retryDelayCapMs: 1_000,
    });
    await retryRequestStarted;
    controller.abort();
    await assert.rejects(cancelled, { name: "AbortError" });
    assert.equal(requests.get("/cancel-retry"), 1);
  } finally {
    await server.close();
  }
});

test("radar HTTP honors AbortSignal", async () => {
  const server = await startServer((_request, response) => {
    setTimeout(() => response.end("too late"), 100);
  });
  const controller = new AbortController();
  try {
    const request = httpGetText(`${server.url}/slow`, {
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(request, (error: unknown) => {
      return error instanceof Error && error.name === "AbortError";
    });
  } finally {
    await server.close();
  }
});

test("radar HTTP aborts redirected requests and rejects timeouts and early closes", async () => {
  let reachedSlowRedirect = false;
  const server = await startServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: "/slow" }).end();
      return;
    }
    if (request.url === "/slow") {
      reachedSlowRedirect = true;
      return;
    }
    if (request.url === "/early-close") {
      response.writeHead(200, { "Content-Length": "100" });
      response.write("partial");
      response.destroy();
      return;
    }
    response.writeHead(404).end();
  });
  try {
    const controller = new AbortController();
    const redirected = httpGetText(`${server.url}/redirect`, {
      signal: controller.signal,
    });
    while (!reachedSlowRedirect)
      await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(redirected, { name: "AbortError" });
    await assert.rejects(
      httpGetText(`${server.url}/slow`, { timeoutMs: 10 }),
      /Timeout after 10ms/,
    );
    await assert.rejects(
      httpGetText(`${server.url}/early-close`),
      /closed early|aborted|socket hang up/,
    );
    await assert.rejects(
      httpGetText(`${server.url}/not-found`),
      (error: unknown) =>
        error instanceof HttpStatusError && error.status === 404,
    );
  } finally {
    await server.close();
  }
});

test("atomic cache writes replace content without leaving temporary files", () => {
  withCache((root) => {
    const path = join(root, "frame-indexes", "IDR661.json");
    atomicWriteFile(path, "old");
    atomicWriteFile(path, "new");
    assert.equal(readFileSync(path, "utf8"), "new");
    assert.deepEqual(
      readdirSync(join(root, "frame-indexes")).filter((name) =>
        name.includes(".tmp-"),
      ),
      [],
    );
  });
});

test("atomic cache writes retry collisions without following exact temporary symlinks", () => {
  const workspace = mkdtempSync(join(tmpdir(), "bom-radar-atomic-link-test-"));
  const root = join(workspace, "cache");
  const external = join(workspace, "outside.txt");
  mkdirSync(join(root, "frame-indexes"), { recursive: true });
  writeFileSync(external, "protected");
  const path = join(root, "frame-indexes", "IDR661.json");
  const collisionNonce = Buffer.alloc(16, 0x11);
  const successfulNonce = Buffer.alloc(16, 0x22);
  const precreatedTemporaryPath = join(
    dirname(path),
    `.IDR661.json.tmp-${process.pid}-${collisionNonce.toString("hex")}`,
  );
  symlinkSync(external, precreatedTemporaryPath, "file");
  symlinkSync(external, path, "file");
  setCacheBaseDir(root);
  let nonceCalls = 0;
  const randomBytesMock = test.mock.method(crypto, "randomBytes", () => {
    nonceCalls += 1;
    return nonceCalls === 1 ? collisionNonce : successfulNonce;
  });
  try {
    atomicWriteFile(path, "cache");
    assert.equal(nonceCalls, 2);
    assert.equal(readFileSync(path, "utf8"), "cache");
    assert.equal(readFileSync(external, "utf8"), "protected");
    assert.equal(readFileSync(precreatedTemporaryPath, "utf8"), "protected");
  } finally {
    randomBytesMock.mock.restore();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("corrupt cached frames self-heal and concurrent downloads coalesce", async () => {
  await withCacheAsync(async (root) => {
    const png = pngBuffer();
    let requests = 0;
    const server = await startServer((_request, response) => {
      requests += 1;
      setTimeout(() => response.end(png), 20);
    });
    const frame = {
      url: `${server.url}/frame.png`,
      file: "IDR661.T.202607180106.png",
      timestamp: "202602300100",
    };
    const cachedPath = join(root, "frames", "IDR661", frame.file);
    atomicWriteFile(cachedPath, "partial download");
    try {
      const [first, second] = await Promise.all([
        downloadFrame("IDR661", frame),
        downloadFrame("IDR661", frame),
      ]);
      assert.equal(first, cachedPath);
      assert.equal(second, cachedPath);
      assert.equal(requests, 1);
      assert.deepEqual(
        readFileSync(cachedPath).subarray(0, 8),
        png.subarray(0, 8),
      );
    } finally {
      await server.close();
    }
  });
});

test("signal-bearing frame downloads retain active consumers and retry after abort or failure", async () => {
  await withCacheAsync(async () => {
    const png = pngBuffer();
    let requests = 0;
    let failNext = false;
    let signalSecondRequest!: () => void;
    const secondRequestStarted = new Promise<void>((resolve) => {
      signalSecondRequest = resolve;
    });
    const server = await startServer((request, response) => {
      requests += 1;
      if (request.url === "/two.png") signalSecondRequest();
      if (failNext) {
        failNext = false;
        response.writeHead(503).end("retry");
        return;
      }
      setTimeout(() => response.end(png), 25);
    });
    try {
      const firstFrame = testFrame(`${server.url}/one.png`, "one.png");
      const cancelledController = new AbortController();
      const activeController = new AbortController();
      const cancelled = downloadFrame("IDR661", firstFrame, {
        signal: cancelledController.signal,
      });
      const active = downloadFrame("IDR661", firstFrame, {
        signal: activeController.signal,
      });
      cancelledController.abort();
      await assert.rejects(cancelled, { name: "AbortError" });
      await active;
      assert.equal(requests, 1);

      const allAbortFrame = testFrame(`${server.url}/two.png`, "two.png");
      const allAbortA = new AbortController();
      const allAbortB = new AbortController();
      const abortedA = downloadFrame("IDR661", allAbortFrame, {
        signal: allAbortA.signal,
      });
      const abortedB = downloadFrame("IDR661", allAbortFrame, {
        signal: allAbortB.signal,
      });
      await secondRequestStarted;
      allAbortA.abort();
      allAbortB.abort();
      await Promise.all([
        assert.rejects(abortedA, { name: "AbortError" }),
        assert.rejects(abortedB, { name: "AbortError" }),
      ]);
      await downloadFrame("IDR661", allAbortFrame);
      assert.equal(requests, 3);

      const retryFrame = testFrame(`${server.url}/three.png`, "three.png");
      failNext = true;
      await downloadFrame("IDR661", retryFrame);
      assert.equal(requests, 5);
    } finally {
      await server.close();
    }
  });
});

test("identical radar renders reuse recent GIF and downloaded frame", async () => {
  await withCacheAsync(async (root) => {
    const png = pngBuffer();
    let requests = 0;
    const server = await startServer((_request, response) => {
      requests += 1;
      response.end(png);
    });
    const product = {
      id: "IDR661",
      site: "Mt Test",
      state: "QLD",
      label: "64 km",
      loopUrl: `${server.url}/loop`,
    };
    const frame = {
      url: `${server.url}/frame.png`,
      file: "IDR661.T.202607180106.png",
      timestamp: "202602300100",
    };
    writeJsonFile(join(root, "frame-indexes", "IDR661.json"), [frame]);
    for (const feature of ["background", "locations"]) {
      atomicWriteFile(join(root, "_overlays", `IDR661.${feature}.png`), png);
    }

    try {
      const cancelledController = new AbortController();
      const activeController = new AbortController();
      const cancelled = renderRadarLoop(product, 1, {
        signal: cancelledController.signal,
      });
      const concurrent = renderRadarLoop(product, 1, {
        signal: activeController.signal,
      });
      cancelledController.abort();
      await assert.rejects(cancelled, { name: "AbortError" });
      const first = await concurrent;
      assert.equal(first.freshness, "unknown");

      atomicWriteFile(first.gifPath, "partial GIF");
      const reopened = await renderRadarLoop(product, 1);
      assert.equal(reopened.gifPath, first.gifPath);
      assert.equal(requests, 1);
      assert.match(
        readFileSync(first.gifPath).subarray(0, 6).toString("ascii"),
        /^GIF8[79]a$/,
      );

      const withoutTrailer = readFileSync(first.gifPath).subarray(0, -1);
      atomicWriteFile(first.gifPath, withoutTrailer);
      const regenerated = await renderRadarLoop(product, 1);
      assert.equal(regenerated.gifPath, first.gifPath);
      assert.equal(isGifBuffer(readFileSync(first.gifPath)), true);
      assert.equal(requests, 1);
    } finally {
      await server.close();
    }
  });
});

test("GIF validation rejects truncated files, missing trailers, bad dimensions, and malformed blocks", () => {
  const valid = Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
    "base64",
  );
  assert.equal(isGifBuffer(valid), true);
  assert.equal(isGifBuffer(valid.subarray(0, 13)), false);
  assert.equal(isGifBuffer(valid.subarray(0, -1)), false);
  const zeroWidth = Buffer.from(valid);
  zeroWidth.writeUInt16LE(0, 6);
  assert.equal(isGifBuffer(zeroWidth), false);
  const outsideCanvas = Buffer.from(valid);
  const imageSeparator = outsideCanvas.indexOf(0x2c);
  outsideCanvas.writeUInt16LE(2, imageSeparator + 5);
  assert.equal(isGifBuffer(outsideCanvas), false);
  const truncatedSubBlock = Buffer.from(valid);
  truncatedSubBlock[truncatedSubBlock.length - 4] = 20;
  assert.equal(isGifBuffer(truncatedSubBlock), false);

  const validGce = Buffer.concat([
    valid.subarray(0, imageSeparator),
    Buffer.from([0x21, 0xf9, 4, 0, 0, 0, 0, 0]),
    valid.subarray(imageSeparator),
  ]);
  assert.equal(isGifBuffer(validGce), true);
  const malformedGceSize = Buffer.from(validGce);
  malformedGceSize[imageSeparator + 2] = 3;
  assert.equal(isGifBuffer(malformedGceSize), false);
  const malformedGceTerminator = Buffer.from(validGce);
  malformedGceTerminator[imageSeparator + 7] = 1;
  assert.equal(isGifBuffer(malformedGceTerminator), false);

  const noImage = Buffer.concat([
    valid.subarray(0, imageSeparator),
    Buffer.from([0x3b]),
  ]);
  assert.equal(isGifBuffer(noImage), false);
  assert.equal(isGifBuffer(Buffer.concat([valid, Buffer.from([0])])), false);

  const withoutAnyColorTable = Buffer.concat([
    valid.subarray(0, 10),
    Buffer.from([valid[10] & 0x7f]),
    valid.subarray(11, 13),
    valid.subarray(imageSeparator),
  ]);
  assert.equal(isGifBuffer(withoutAnyColorTable), false);
  const localColorDescriptor = Buffer.from(
    withoutAnyColorTable.subarray(0, 23),
  );
  localColorDescriptor[22] = 0x80;
  const withLocalColorTable = Buffer.concat([
    localColorDescriptor,
    Buffer.from([0, 0, 0, 255, 255, 255]),
    withoutAnyColorTable.subarray(23),
  ]);
  assert.equal(isGifBuffer(withLocalColorTable), true);

  const malformedApplication = Buffer.concat([
    valid.subarray(0, imageSeparator),
    Buffer.from([0x21, 0xff, 10]),
    Buffer.alloc(10),
    Buffer.from([0]),
    valid.subarray(imageSeparator),
  ]);
  assert.equal(isGifBuffer(malformedApplication), false);
  const truncatedComment = Buffer.concat([
    valid.subarray(0, imageSeparator),
    Buffer.from([0x21, 0xfe, 3, 0x41]),
    valid.subarray(imageSeparator),
  ]);
  assert.equal(isGifBuffer(truncatedComment), false);
});

test("radar cache pruning bounds frames, GIFs, versions, indexes, and negatives", () => {
  withCache((root) => {
    const now = Date.now();
    const frameDir = join(root, "frames", "IDR661");
    const gifDir = join(root, "gifs", "IDR661");
    for (
      let index = 0;
      index < RADAR_CACHE_POLICY.rawFramesPerProduct + 4;
      index++
    ) {
      agedFile(join(frameDir, `${index}.png`), now - index * 1_000);
    }
    for (
      let index = 0;
      index < RADAR_CACHE_POLICY.gifsPerProduct + 3;
      index++
    ) {
      agedFile(
        join(gifDir, `v${RADAR_GIF_CACHE_VERSION}-1-${index}.gif`),
        now - index * 1_000,
      );
    }
    agedFile(join(gifDir, "v1-1-old.gif"), now);
    agedFile(
      join(root, "frame-indexes", "expired.json"),
      now - RADAR_CACHE_POLICY.frameIndexMaxAgeMs - 1,
    );
    agedFile(
      join(root, "_overlays", "IDR661.background.png.missing"),
      now - RADAR_CACHE_POLICY.negativeOverlayTtlMs - 1,
    );
    agedFile(
      join(frameDir, ".orphan.tmp-1"),
      now - RADAR_CACHE_POLICY.orphanTempMaxAgeMs - 1,
    );

    pruneRadarCache(RADAR_GIF_CACHE_VERSION, now);

    assert.equal(
      readdirSync(frameDir).filter((name) => name.endsWith(".png")).length,
      48,
    );
    assert.equal(
      readdirSync(gifDir).filter((name) => name.endsWith(".gif")).length,
      8,
    );
    assert.equal(
      readdirSync(gifDir).some((name) => name.startsWith("v1-")),
      false,
    );
    assert.equal(
      readdirSync(join(root, "frame-indexes")).includes("expired.json"),
      false,
    );
    assert.equal(readdirSync(join(root, "_overlays")).length, 0);
    assert.equal(
      readdirSync(frameDir).some((name) => name.includes(".tmp-")),
      false,
    );
  });
});

test("radar pruning rejects symlinked managed roots and leaves targets untouched", () => {
  const workspace = mkdtempSync(join(tmpdir(), "bom-radar-symlink-test-"));
  const cacheRoot = join(workspace, "cache");
  const targetsRoot = join(workspace, "targets");
  mkdirSync(cacheRoot);
  mkdirSync(targetsRoot);
  try {
    for (const managed of ["frames", "gifs", "frame-indexes", "_overlays"]) {
      const target = join(targetsRoot, managed);
      mkdirSync(target, { recursive: true });
      const protectedFile =
        managed === "frames"
          ? join(target, "IDR661", "old.png")
          : managed === "gifs"
            ? join(target, "IDR661", "v1-old.gif")
            : managed === "frame-indexes"
              ? join(target, "old.json")
              : join(target, "old.png");
      mkdirSync(dirname(protectedFile), { recursive: true });
      writeFileSync(protectedFile, "outside");
      symlinkSync(target, join(cacheRoot, managed), "dir");
    }
    setCacheBaseDir(cacheRoot);
    assert.throws(
      () => atomicWriteFile(join(cacheRoot, "frames", "new.png"), "cache"),
      /symlinked radar cache directory/,
    );
    pruneRadarCache(RADAR_GIF_CACHE_VERSION, Date.now() + 60 * 60 * 1000);
    assert.equal(
      readFileSync(join(targetsRoot, "frames", "IDR661", "old.png"), "utf8"),
      "outside",
    );
    assert.equal(
      readFileSync(join(targetsRoot, "gifs", "IDR661", "v1-old.gif"), "utf8"),
      "outside",
    );
    assert.equal(
      readFileSync(join(targetsRoot, "frame-indexes", "old.json"), "utf8"),
      "outside",
    );
    assert.equal(
      readFileSync(join(targetsRoot, "_overlays", "old.png"), "utf8"),
      "outside",
    );

    const linkedRoot = join(workspace, "linked-cache");
    symlinkSync(targetsRoot, linkedRoot, "dir");
    setCacheBaseDir(linkedRoot);
    assert.throws(
      () => atomicWriteFile(join(linkedRoot, "new.json"), "cache"),
      /symlinked radar cache root/,
    );
    pruneRadarCache(RADAR_GIF_CACHE_VERSION, Date.now() + 60 * 60 * 1000);
    assert.equal(
      readFileSync(join(targetsRoot, "frames", "IDR661", "old.png"), "utf8"),
      "outside",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("radar pruning rejects nested product and file symlinks in every cache class", () => {
  const workspace = mkdtempSync(join(tmpdir(), "bom-radar-nested-link-test-"));
  const cacheRoot = join(workspace, "cache");
  const targetsRoot = join(workspace, "targets");
  mkdirSync(cacheRoot);
  mkdirSync(targetsRoot);
  try {
    mkdirSync(join(cacheRoot, "frames"));
    mkdirSync(join(cacheRoot, "gifs"));
    mkdirSync(join(cacheRoot, "frame-indexes"));
    mkdirSync(join(cacheRoot, "_overlays"));
    const outsideFrames = join(targetsRoot, "frame-product");
    const outsideGifs = join(targetsRoot, "gif-product");
    mkdirSync(outsideFrames);
    mkdirSync(outsideGifs);
    writeFileSync(join(outsideFrames, "old.png"), "outside-frame");
    writeFileSync(join(outsideGifs, "v1-old.gif"), "outside-gif");
    symlinkSync(outsideFrames, join(cacheRoot, "frames", "IDR999"), "dir");
    symlinkSync(outsideGifs, join(cacheRoot, "gifs", "IDR999"), "dir");
    const outsideIndex = join(targetsRoot, "index.json");
    const outsideOverlay = join(targetsRoot, "overlay.png");
    writeFileSync(outsideIndex, "outside-index");
    writeFileSync(outsideOverlay, "outside-overlay");
    symlinkSync(
      outsideIndex,
      join(cacheRoot, "frame-indexes", "old.json"),
      "file",
    );
    symlinkSync(
      outsideOverlay,
      join(cacheRoot, "_overlays", "old.png"),
      "file",
    );
    const normalFrameProduct = join(cacheRoot, "frames", "IDR661");
    const normalGifProduct = join(cacheRoot, "gifs", "IDR661");
    mkdirSync(normalFrameProduct);
    mkdirSync(normalGifProduct);
    symlinkSync(
      join(outsideFrames, "old.png"),
      join(normalFrameProduct, "linked.png"),
      "file",
    );
    symlinkSync(
      join(outsideGifs, "v1-old.gif"),
      join(normalGifProduct, "v1-linked.gif"),
      "file",
    );

    setCacheBaseDir(cacheRoot);
    pruneRadarCache(RADAR_GIF_CACHE_VERSION, Date.now() + 60 * 60 * 1000);
    assert.equal(
      readFileSync(join(outsideFrames, "old.png"), "utf8"),
      "outside-frame",
    );
    assert.equal(
      readFileSync(join(outsideGifs, "v1-old.gif"), "utf8"),
      "outside-gif",
    );
    assert.equal(readFileSync(outsideIndex, "utf8"), "outside-index");
    assert.equal(readFileSync(outsideOverlay, "utf8"), "outside-overlay");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("signal-bearing overlay downloads coalesce with independent and all-consumer cancellation", async () => {
  await withCacheAsync(async (root) => {
    const png = pngBuffer();
    const requests = new Map<string, number>();
    const startedResolvers = new Map<string, () => void>();
    const started = new Map<string, Promise<void>>();
    for (const path of ["/shared", "/all-abort"]) {
      started.set(
        path,
        new Promise<void>((resolve) => startedResolvers.set(path, resolve)),
      );
    }
    const server = await startServer((request, response) => {
      const path = request.url ?? "";
      const count = (requests.get(path) ?? 0) + 1;
      requests.set(path, count);
      startedResolvers.get(path)?.();
      if (path === "/recover" && count <= 3) {
        response.writeHead(503).end();
        return;
      }
      setTimeout(() => response.end(png), 25);
    });
    const candidate = (name: string, signal?: AbortSignal) => {
      const path = join(root, "_overlays", `${name}.png`);
      return loadOverlayCandidate(
        path,
        `${path}.missing`,
        `${server.url}/${name}`,
        { signal, retryBaseDelayMs: 0 },
      );
    };
    try {
      const cancelledController = new AbortController();
      const activeController = new AbortController();
      const cancelled = candidate("shared", cancelledController.signal);
      const active = candidate("shared", activeController.signal);
      await started.get("/shared");
      cancelledController.abort();
      await assert.rejects(cancelled, { name: "AbortError" });
      assert.ok(await active);
      assert.equal(requests.get("/shared"), 1);

      const firstController = new AbortController();
      const secondController = new AbortController();
      const first = candidate("all-abort", firstController.signal);
      const second = candidate("all-abort", secondController.signal);
      await started.get("/all-abort");
      firstController.abort();
      secondController.abort();
      await Promise.all([
        assert.rejects(first, { name: "AbortError" }),
        assert.rejects(second, { name: "AbortError" }),
      ]);
      assert.ok(await candidate("all-abort"));
      assert.equal(requests.get("/all-abort"), 2);

      assert.equal(await candidate("recover"), null);
      assert.ok(await candidate("recover"));
      assert.equal(requests.get("/recover"), 4);
    } finally {
      await server.close();
    }
  });
});

test("overlay negative markers are written only for authoritative 404 responses", async () => {
  await withCacheAsync(async (root) => {
    const server = await startServer((request, response) => {
      if (request.url === "/missing") response.writeHead(404).end();
      else if (request.url === "/server-error") response.writeHead(503).end();
      else if (request.url === "/timeout") return;
      else if (request.url === "/early-close") {
        response.writeHead(200, { "Content-Length": "100" });
        response.write("partial");
        response.destroy();
      } else response.end("not a png");
    });
    try {
      for (const [name, expectedMissing, timeoutMs] of [
        ["missing", true, undefined],
        ["server-error", false, undefined],
        ["invalid", false, undefined],
        ["timeout", false, 5],
        ["early-close", false, undefined],
      ] as const) {
        const path = join(root, "_overlays", `${name}.png`);
        const missingPath = `${path}.missing`;
        assert.equal(
          await loadOverlayCandidate(
            path,
            missingPath,
            `${server.url}/${name}`,
            { timeoutMs },
          ),
          null,
        );
        assert.equal(existsSync(missingPath), expectedMissing);
      }
    } finally {
      await server.close();
    }
  });
});

test("catalog discovery enforces concurrency and propagates abort despite stale cache", async () => {
  await withCacheAsync(async (root) => {
    let active = 0;
    let maximum = 0;
    const controller = new AbortController();
    const products = await discoverRadarProducts({
      signal: controller.signal,
      getText: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return `<a href="/site" title="Mt Test site information.">Mt Test</a>
          <a href="/products/IDR661.loop.shtml">64 km</a>`;
      },
    });
    assert.equal(products.length, 1);
    assert.equal(maximum, 3);

    const cachePath = join(root, "radar-products.json");
    writeJsonFile(cachePath, [
      {
        id: "IDR661",
        site: "Mt Test",
        state: "QLD",
        label: "64 km",
        loopUrl: "https://example.com/loop",
      },
    ]);
    const stale = new Date(Date.now() - CATALOG_TTL_MS - 1_000);
    utimesSync(cachePath, stale, stale);
    const abortedController = new AbortController();
    abortedController.abort();
    await assert.rejects(
      discoverRadarProducts({
        signal: abortedController.signal,
        getText: async () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        },
      }),
      { name: "AbortError" },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
});

test("catalog discovery shares work while retaining active consumers", async () => {
  await withCacheAsync(async () => {
    const release = deferred<void>();
    const cancelledController = new AbortController();
    const activeController = new AbortController();
    let requests = 0;
    let discoverySignal: AbortSignal | undefined;
    const getText = async (_url: string, options: { signal?: AbortSignal }) => {
      requests += 1;
      discoverySignal = options.signal;
      await release.promise;
      return `<a href="/site" title="Mt Test site information.">Mt Test</a>
        <a href="/products/IDR661.loop.shtml">64 km</a>`;
    };

    const cancelled = discoverRadarProducts({
      signal: cancelledController.signal,
      getText,
    });
    const active = discoverRadarProducts({
      signal: activeController.signal,
      getText,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(requests, 3);

    cancelledController.abort();
    await assert.rejects(cancelled, { name: "AbortError" });
    assert.equal(discoverySignal?.aborted, false);

    release.resolve();
    const products = await active;
    assert.equal(products.length, 1);
    assert.equal(requests, 7);
  });
});

test("catalog discovery aborts and evicts shared work after every consumer leaves", async () => {
  await withCacheAsync(async () => {
    const firstController = new AbortController();
    const secondController = new AbortController();
    let requests = 0;
    let discoverySignal: AbortSignal | undefined;
    const blockedGetText = (
      _url: string,
      options: { signal?: AbortSignal },
    ) => {
      requests += 1;
      discoverySignal = options.signal;
      return new Promise<string>((_resolve, reject) =>
        options.signal?.addEventListener(
          "abort",
          () =>
            reject(
              Object.assign(new Error("catalogue request aborted"), {
                name: "AbortError",
              }),
            ),
          { once: true },
        ),
      );
    };

    const first = discoverRadarProducts({
      signal: firstController.signal,
      getText: blockedGetText,
    });
    const second = discoverRadarProducts({
      signal: secondController.signal,
      getText: blockedGetText,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(requests, 3);

    firstController.abort();
    assert.equal(discoverySignal?.aborted, false);
    secondController.abort();
    await Promise.all([
      assert.rejects(first, { name: "AbortError" }),
      assert.rejects(second, { name: "AbortError" }),
    ]);
    assert.equal(discoverySignal?.aborted, true);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const retried = await discoverRadarProducts({
      getText: async () => {
        requests += 1;
        return `<a href="/site" title="Mt Test site information.">Mt Test</a>
          <a href="/products/IDR661.loop.shtml">64 km</a>`;
      },
    });
    assert.equal(retried.length, 1);
    assert.equal(requests, 10);
  });
});

test("frame scraping requests status only after loop failure or an empty result", async () => {
  await withCacheAsync(async () => {
    let statusRequests = 0;
    const status = async () => {
      statusRequests += 1;
      return "maintenance";
    };
    const product = testProduct("IDR771");
    const validHtml = 'theImageNames[0] = "/radar/IDR771.T.202607180106.png";';
    const valid = await scrapeFrames(product, {
      getText: async () => validHtml,
      getStatusReport: status,
    });
    assert.equal(valid.frames.length, 1);
    assert.equal(statusRequests, 0);

    await assert.rejects(
      scrapeFrames(testProduct("IDR772"), {
        getText: async () => "no frames",
        getStatusReport: status,
      }),
      /No radar frames/,
    );
    assert.equal(statusRequests, 1);
    await assert.rejects(
      scrapeFrames(testProduct("IDR773"), {
        getText: async () => {
          throw new Error("loop failed");
        },
        getStatusReport: status,
      }),
      /Could not load/,
    );
    assert.equal(statusRequests, 2);
  });
});

function pngBuffer() {
  const png = new PNG({ width: 32, height: 32 });
  png.data.fill(255);
  return PNG.sync.write(png);
}

function testFrame(url: string, file: string) {
  return { url, file, timestamp: "202607180106" };
}

function testProduct(id: string) {
  return {
    id,
    site: "Mt Test",
    state: "QLD",
    label: "64 km",
    loopUrl: "https://example.com/loop",
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function withCache(run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "bom-radar-test-"));
  setCacheBaseDir(root);
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function withCacheAsync(run: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "bom-radar-test-"));
  setCacheBaseDir(root);
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function agedFile(path: string, modifiedMs: number) {
  atomicWriteFile(path, "cache");
  const modified = new Date(modifiedMs);
  utimesSync(path, modified, modified);
}

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No test server address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
