/** Every remote provider the plugin knows. Add a new one here (and its options in source.ts). The local one is `local/`. */
import { github } from './github.ts';
import { gitlab } from './gitlab.ts';
import { metrics } from './metrics.ts';

export const REMOTE = { gitlab, github, metrics };
export type RemoteId = keyof typeof REMOTE;
export const REMOTE_IDS = Object.keys(REMOTE) as RemoteId[];
export const REMOTE_HOSTS = [...new Set(Object.values(REMOTE).flatMap((p) => p.hosts))];
