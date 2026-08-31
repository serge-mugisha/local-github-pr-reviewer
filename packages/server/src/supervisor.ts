import { superviseWorkQueue } from "./workQueue.js";

void superviseWorkQueue().catch((error) => {
  console.error(`Reviewer queue supervisor failed: ${String(error)}`);
  process.exitCode = 1;
});
