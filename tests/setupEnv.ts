// Runs before any test file imports app code, so env validation sees these values.
import { useCachedMongoBinary } from "./mongoBinary.js";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-test-secret-test-secret-1234";
process.env.CLIENT_ORIGIN = "http://localhost:3000";
useCachedMongoBinary();
