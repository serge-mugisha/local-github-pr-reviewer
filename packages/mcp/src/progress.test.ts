import { describe, expect, it, vi } from "vitest";
import { createDurableProgressReporter } from "./progress.js";

describe("createDurableProgressReporter", () => {
  it("shares the ten-second throttle policy across durable work types", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-24T00:00:30.000Z"));
      const sendProgress = vi.fn();
      const report = createDurableProgressReporter(
        { progressToken: "token", sendProgress },
        "Thread action",
      );
      const work = { id: 7, started_at: "2026-08-24T00:00:00.000Z" };

      report(work);
      report(work);
      vi.advanceTimersByTime(10_000);
      report(work);

      expect(sendProgress).toHaveBeenCalledTimes(2);
      expect(sendProgress).toHaveBeenLastCalledWith(
        expect.objectContaining({ message: expect.stringContaining("Thread action 7") }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
