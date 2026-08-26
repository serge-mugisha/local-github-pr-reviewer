import { describe, expect, it } from "vitest";
import {
  DURABLE_EXECUTION_TIMEOUT_MS,
  DURABLE_WAIT_TIMEOUT_MS,
  THREAD_ACTION_EXECUTION_TIMEOUT_MS,
} from "./timing.js";

describe("durable lifecycle timing", () => {
  it("keeps every default waiter alive beyond the worker lifecycle", () => {
    expect(DURABLE_WAIT_TIMEOUT_MS).toBeGreaterThan(DURABLE_EXECUTION_TIMEOUT_MS);
    expect(DURABLE_WAIT_TIMEOUT_MS).toBeGreaterThan(THREAD_ACTION_EXECUTION_TIMEOUT_MS);
  });
});
