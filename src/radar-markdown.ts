import { pathToFileURL } from "node:url";

export function radarImageMarkdown({
  alt,
  path,
  size,
}: {
  alt: string;
  path: string;
  size: number;
}) {
  const url = new URL(pathToFileURL(path));
  url.searchParams.set("raycast-width", String(size));
  url.searchParams.set("raycast-height", String(size));

  return `![${alt}](${url.href})`;
}
