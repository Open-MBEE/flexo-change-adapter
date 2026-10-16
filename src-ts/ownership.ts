import * as fs from "node:fs";
import * as path from "node:path";
import {
  branch,
  ConfigurationError,
  type Configuration,
} from "./configuration.ts";
import { canonicalJson } from "./contracts.ts";
import { publishFeed } from "./feed.ts";

// Call under the state-directory writer lock before creating destination state.
export function bindStateDirectory(configuration: Configuration) {
  const file = path.join(configuration.state_directory, "ownership.json");
  const identity = canonicalJson({
    branch_uri: branch(configuration.source).uri,
    database: configuration.database,
  });
  fs.mkdirSync(configuration.state_directory, { recursive: true });
  if (fs.existsSync(file)) {
    if (canonicalJson(JSON.parse(fs.readFileSync(file, "utf8"))) !== identity)
      throw new ConfigurationError(
        "State directory belongs to another source or journal; select a separate state directory",
      );
    return;
  }
  publishFeed(file, JSON.parse(identity));
}
