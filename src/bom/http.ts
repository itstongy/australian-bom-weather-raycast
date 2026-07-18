import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BASE_URL, USER_AGENT } from "./constants";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 100;
const DEFAULT_RETRY_DELAY_CAP_MS = 1_000;
const ABSOLUTE_RETRY_DELAY_CAP_MS = 2_000;

export type HttpGetOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  retryDelayCapMs?: number;
};

export class HttpStatusError extends Error {
  readonly status: number;
  readonly url: string;
  readonly retryAfterMs?: number;

  constructor(url: string, status: number, retryAfterMs?: number) {
    super(`GET ${url} returned HTTP ${status}`);
    this.name = "HttpStatusError";
    this.url = url;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function httpGetText(url: string, options: HttpGetOptions = {}) {
  return httpGetBuffer(url, {
    maxBytes: DEFAULT_MAX_TEXT_BYTES,
    ...options,
  }).then((buffer) => buffer.toString("latin1"));
}

export function httpGetBuffer(
  url: string,
  options: HttpGetOptions = {},
): Promise<Buffer> {
  return getBufferWithRetries(url, options);
}

async function getBufferWithRetries(url: string, options: HttpGetOptions) {
  const requestedAttempts = options.maxAttempts;
  const maxAttempts = Math.max(
    1,
    Math.min(
      DEFAULT_MAX_ATTEMPTS,
      Number.isFinite(requestedAttempts)
        ? Math.floor(requestedAttempts as number)
        : DEFAULT_MAX_ATTEMPTS,
    ),
  );
  const requestedDelayCap = options.retryDelayCapMs;
  const delayCapMs = Math.max(
    0,
    Math.min(
      ABSOLUTE_RETRY_DELAY_CAP_MS,
      Number.isFinite(requestedDelayCap)
        ? (requestedDelayCap as number)
        : DEFAULT_RETRY_DELAY_CAP_MS,
    ),
  );
  const requestedBaseDelay = options.retryBaseDelayMs;
  const baseDelayMs = Math.max(
    0,
    Math.min(
      delayCapMs,
      Number.isFinite(requestedBaseDelay)
        ? (requestedBaseDelay as number)
        : DEFAULT_RETRY_BASE_DELAY_MS,
    ),
  );

  for (let attempt = 1; ; attempt++) {
    try {
      return await getBufferOnce(url, options, 0);
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableError(error)) throw error;
      const retryAfterMs =
        error instanceof HttpStatusError ? error.retryAfterMs : undefined;
      const delayMs = Math.min(
        delayCapMs,
        retryAfterMs ?? baseDelayMs * 2 ** (attempt - 1),
      );
      await waitForRetry(delayMs, options.signal, url);
    }
  }
}

function getBufferOnce(
  url: string,
  options: HttpGetOptions,
  redirectCount: number,
): Promise<Buffer> {
  const parsedUrl = new URL(url);
  const request = parsedUrl.protocol === "http:" ? httpRequest : httpsRequest;
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return Promise.reject(new Error(`Unsupported URL protocol for ${url}`));
  }
  if (options.signal?.aborted) return Promise.reject(abortError(url));

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const fail = (error: Error) => finish(() => reject(error));
    const onAbort = () => req.destroy(abortError(url));

    const req = request(
      parsedUrl,
      {
        headers: {
          Referer: `${BASE_URL}/`,
          "User-Agent": USER_AGENT,
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (redirectCount >= MAX_REDIRECTS) {
            fail(new Error(`Too many redirects fetching ${url}`));
            return;
          }
          let redirectedUrl: string;
          try {
            redirectedUrl = new URL(
              response.headers.location,
              parsedUrl,
            ).toString();
          } catch {
            fail(new Error(`Invalid redirect from ${url}`));
            return;
          }
          getBufferOnce(redirectedUrl, options, redirectCount + 1).then(
            (value) => finish(() => resolve(value)),
            fail,
          );
          return;
        }

        if (status !== 200) {
          response.resume();
          fail(
            new HttpStatusError(
              url,
              status,
              parseRetryAfter(response.headers["retry-after"]),
            ),
          );
          return;
        }

        const contentLength = Number(response.headers["content-length"]);
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
          fail(
            new Error(
              `GET ${url} exceeded the ${maxBytes}-byte response limit`,
            ),
          );
          response.destroy();
          return;
        }

        const chunks: Buffer[] = [];
        let received = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          received += buffer.length;
          if (received > maxBytes) {
            fail(
              new Error(
                `GET ${url} exceeded the ${maxBytes}-byte response limit`,
              ),
            );
            response.destroy();
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => finish(() => resolve(Buffer.concat(chunks))));
        response.on("aborted", () =>
          fail(new Error(`Response aborted fetching ${url}`)),
        );
        response.on("error", fail);
        response.on("close", () => {
          if (!response.complete)
            fail(new Error(`Response closed early fetching ${url}`));
        });
      },
    );

    options.signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", fail);
    req.setTimeout(timeoutMs, () => {
      const error = new Error(`Timeout after ${timeoutMs}ms fetching ${url}`);
      error.name = "TimeoutError";
      req.destroy(error);
    });
    req.end();
  });
}

function isRetryableError(error: unknown) {
  if (error instanceof HttpStatusError) {
    return (
      error.status === 408 ||
      error.status === 429 ||
      (error.status >= 500 && error.status <= 599)
    );
  }
  if (!(error instanceof Error) || error.name === "AbortError") return false;
  if (error.name === "TimeoutError") return true;
  const code = (error as NodeJS.ErrnoException).code;
  if (
    code &&
    [
      "ECONNRESET",
      "EPIPE",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "ENETDOWN",
      "ENETUNREACH",
      "EHOSTUNREACH",
    ].includes(code)
  ) {
    return true;
  }
  return /Response (?:aborted|closed early)/.test(error.message);
}

function parseRetryAfter(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const dateMs = Date.parse(raw);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, dateMs - Date.now());
}

function waitForRetry(
  delayMs: number,
  signal: AbortSignal | undefined,
  url: string,
) {
  if (signal?.aborted) return Promise.reject(abortError(url));
  if (delayMs <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError(url));
    };
    function finish() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(url: string) {
  const error = new Error(`Request aborted fetching ${url}`);
  error.name = "AbortError";
  return error;
}
