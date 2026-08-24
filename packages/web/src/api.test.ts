import { afterEach, describe, expect, it, vi } from "vitest";
import { errorHasPersistedInput, postSse } from "./api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("postSse", () => {
  it("rejects when the stream publishes an error event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          'event: error\ndata: {"message":"action conflict","inputPersisted":false}\n\n',
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
      ),
    );
    const events: string[] = [];

    const request = postSse("/action", {}, (event) => events.push(event.event));
    await expect(request).rejects.toMatchObject({
      message: "action conflict",
      data: { message: "action conflict", inputPersisted: false },
    });
    expect(events).toEqual(["error"]);
  });

  it("distinguishes persisted provider failures from pre-claim conflicts", () => {
    const persisted = Object.assign(new Error("provider failed"), {
      data: { inputPersisted: true },
    });
    const conflict = Object.assign(new Error("action conflict"), {
      data: { inputPersisted: false },
    });

    expect(errorHasPersistedInput(persisted)).toBe(true);
    expect(errorHasPersistedInput(conflict)).toBe(false);
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
