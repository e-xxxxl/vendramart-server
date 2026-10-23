import { MongoMemoryServer } from "mongodb-memory-server";
import { useCachedMongoBinary } from "./mongoBinary.js";

/**
 * One in-memory MongoDB for the whole run. Every test file connects to it and uses its own database (see
 * helpers.startDb), so files cannot see each other's data and can run side by side. Starting a separate mongod
 * for each of the 25 files was most of the test time and the cause of the occasional slow-start failure.
 */
let mongod: MongoMemoryServer | undefined;

export default async function setup() {
  useCachedMongoBinary();
  mongod = await MongoMemoryServer.create();
  // Worker processes are started after this and inherit the variable.
  process.env.TEST_MONGO_URI = mongod.getUri();
  return async () => {
    await mongod?.stop();
  };
}
