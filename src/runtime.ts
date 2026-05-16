import { environment } from "@raycast/api";
import { join } from "node:path";
import { setCacheBaseDir } from "./bom/cache";

export function configureRuntime() {
  setCacheBaseDir(join(environment.supportPath, "cache"));
}
