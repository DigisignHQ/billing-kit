import { test } from "node:test";
import { Pool } from "pg";
import { MongoClient } from "mongodb";
import { postgresStorage } from "../../src/adapters/postgres.js";
import { mongoStorage } from "../../src/adapters/mongodb.js";
import { storageContract } from "../contract.js";
import { advancedContract } from "../advanced-contract.js";
// Dedicated disposable databases only. Never point these URLs at application databases.
test("PostgreSQL adapter against a real server", async () => {
  if (!process.env.BILLING_KIT_TEST_POSTGRES_URL)
    throw new Error(
      "Set BILLING_KIT_TEST_POSTGRES_URL to a disposable database",
    );
  const pool = new Pool({
    connectionString: process.env.BILLING_KIT_TEST_POSTGRES_URL,
  });
  try {
    const storage = postgresStorage(pool);
    await storage.migrate();
    await storageContract(storage);
    await advancedContract(storage);
  } finally {
    await pool.end();
  }
});
test("MongoDB adapter against a real server", async () => {
  if (!process.env.BILLING_KIT_TEST_MONGODB_URL)
    throw new Error("Set BILLING_KIT_TEST_MONGODB_URL to a disposable server");
  const client = await MongoClient.connect(
    process.env.BILLING_KIT_TEST_MONGODB_URL,
  );
  const db = client.db(`billing_kit_test_${Date.now()}`);
  try {
    await storageContract(mongoStorage(db));
    await advancedContract(mongoStorage(db));
  } finally {
    await db.dropDatabase();
    await client.close();
  }
});
