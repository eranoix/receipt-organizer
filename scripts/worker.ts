import { closePool } from '../src/lib/db';
import { createWorker, runForever } from '../src/lib/server/worker';

const ctx = createWorker();
const stop = new AbortController();
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`[worker] ${sig}, finishing the current tick`);
    stop.abort();
  });
}
console.log(`[worker] ${ctx.id} starting (drive=${process.env.DRIVE_ADAPTER ?? 'local'}, extractor=${process.env.EXTRACTOR ?? 'mock'})`);
runForever(ctx, Number(process.env.WORKER_INTERVAL_MS ?? 1_000), stop.signal)
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
