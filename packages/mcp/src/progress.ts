export interface DurableProgressContext {
  signal?: AbortSignal;
  progressToken?: string | number;
  sendProgress(params: {
    progressToken: string | number;
    progress: number;
    message: string;
  }): void | Promise<void>;
}

export function createDurableProgressReporter(
  context: DurableProgressContext,
  label: string,
): (work: { id: number | string; started_at: string | null; created_at?: string }) => void {
  let lastProgressAt = 0;
  return (work) => {
    const timestamp = Date.now();
    if (context.progressToken === undefined || timestamp - lastProgressAt < 10_000) return;
    lastProgressAt = timestamp;
    const beganAt = work.started_at ?? work.created_at ?? new Date(timestamp).toISOString();
    const elapsedSeconds = Math.max(0, Math.round((timestamp - Date.parse(beganAt)) / 1_000));
    void Promise.resolve(
      context.sendProgress({
        progressToken: context.progressToken,
        progress: elapsedSeconds,
        message: `${label} ${work.id} is healthy and still running (${elapsedSeconds}s elapsed).`,
      }),
    ).catch(() => {
      // Durable work continues if this client disconnects.
    });
  };
}
