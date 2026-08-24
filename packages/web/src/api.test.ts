import { afterEach, describe, expect, it, vi } from "vitest";
import { postSse } from "./api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("postSse", () => {
  it("rejects when the stream publishes an error event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response('event: error\ndata: {"message":"action conflict"}\n\n', {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    );
    const events: string[] = [];

    await expect(postSse("/action", {}, (event) => events.push(event.event))).rejects.toThrow(
      "action conflict",
    );
    expect(events).toEqual(["error"]);
  });

  it("resolves after a successful terminal event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response('event: done\ndata: {"ok":true}\n\n', {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    );
    const events: string[] = [];

    await expect(postSse("/action", {}, (event) => events.push(event.event))).resolves.toBe(
      undefined,
    );
    expect(events).toEqual(["done"]);
  });
});
