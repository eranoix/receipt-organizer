import path from 'node:path';
import { GraphDrive, graphConfigFromEnv } from './graph-drive';
import { LocalDrive } from './local-drive';
import type { DriveAdapter } from './types';

const g = globalThis as unknown as { __roDrive?: DriveAdapter };

export function driveRoot(): string {
  return path.resolve(process.env.DRIVE_ROOT ?? './.data/drive');
}

export function drive(): DriveAdapter {
  if (!g.__roDrive) {
    if (process.env.DRIVE_ADAPTER === 'graph') {
      const cfg = graphConfigFromEnv();
      if (!cfg) throw new Error('DRIVE_ADAPTER=graph needs GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET and GRAPH_DRIVE_ID');
      g.__roDrive = new GraphDrive(cfg);
    } else {
      g.__roDrive = new LocalDrive(driveRoot(), { latencyMs: Number(process.env.DRIVE_LATENCY_MS ?? 0) });
    }
  }
  return g.__roDrive;
}

export function setDrive(d: DriveAdapter): void {
  g.__roDrive = d;
}

export * from './types';
