import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export function publishFeed(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
    const parent = fs.openSync(path.dirname(file), "r");
    try {
      fs.fsyncSync(parent);
    } finally {
      fs.closeSync(parent);
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
