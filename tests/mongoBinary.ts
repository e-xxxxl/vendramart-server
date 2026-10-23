// The default in-memory MongoDB version is a ~770 MB download. If a mongod binary is already cached
// locally, use it directly. Override with MONGOMS_SYSTEM_BINARY (full path) to use a different one.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function useCachedMongoBinary() {
  const cached = path.join(os.homedir(), ".cache", "mongodb-binaries", "mongod-x64-win32-6.0.19.exe");
  if (!process.env.MONGOMS_SYSTEM_BINARY && fs.existsSync(cached)) {
    process.env.MONGOMS_SYSTEM_BINARY = cached;
  }
}
