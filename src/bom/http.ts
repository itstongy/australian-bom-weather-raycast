import { get } from "node:https";
import { BASE_URL, USER_AGENT } from "./constants";

export function httpGetText(url: string) {
  return httpGetBuffer(url).then((buffer) => buffer.toString("latin1"));
}

export function httpGetBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const request = get(
      url,
      {
        headers: {
          Referer: `${BASE_URL}/`,
          "User-Agent": USER_AGENT,
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`GET ${url} returned ${response.statusCode}`));
          response.resume();
          return;
        }

        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks)));
      },
    );

    request.on("error", reject);
    request.setTimeout(15000, () =>
      request.destroy(new Error(`Timeout fetching ${url}`)),
    );
  });
}
