import { CutlineError } from './errors';
import { ProjectSchema, SCHEMA_VERSION, type Project } from './schema';

type Json = Record<string, unknown>;

export interface Migration {
  from: number;
  to: number;
  description: string;
  migrate(doc: Json): Json;
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function msToSeconds(obj: Json, key: string): void {
  const msKey = `${key}Ms`;
  if (typeof obj[msKey] === 'number') {
    obj[key] = (obj[msKey] as number) / 1000;
    delete obj[msKey];
  }
}

/**
 * Ordered list of migrations. Each one upgrades a document by exactly one
 * schema version. Add a new entry (and bump SCHEMA_VERSION) whenever the
 * document format changes incompatibly.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    from: 0,
    to: 1,
    description:
      'The v0 prototype format stored times in milliseconds (startMs, durationMs, sourceStartMs) and had no schemaVersion; v1 uses seconds.',
    migrate(doc) {
      const tracks = Array.isArray(doc.tracks) ? doc.tracks : [];
      for (const track of tracks) {
        if (!isObject(track) || !Array.isArray(track.clips)) continue;
        for (const clip of track.clips) {
          if (!isObject(clip)) continue;
          msToSeconds(clip, 'start');
          msToSeconds(clip, 'duration');
          msToSeconds(clip, 'sourceStart');
        }
      }
      const assets = Array.isArray(doc.assets) ? doc.assets : [];
      for (const asset of assets) if (isObject(asset)) msToSeconds(asset, 'duration');
      return { ...doc, schemaVersion: 1 };
    },
  },
];

export function getSchemaVersion(doc: Json): number {
  const v = doc.schemaVersion;
  if (v === undefined) return 0;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new CutlineError('UNSUPPORTED_VERSION', `Invalid schemaVersion ${JSON.stringify(v)}.`);
  }
  return v;
}

/** Upgrades any known document version to the current schema and validates it. */
export function migrateProject(
  raw: unknown,
  migrations: readonly Migration[] = MIGRATIONS,
): Project {
  if (!isObject(raw)) {
    throw new CutlineError('INVALID_ARGUMENT', 'A project document must be a JSON object.');
  }
  let doc = JSON.parse(JSON.stringify(raw)) as Json;
  let version = getSchemaVersion(doc);
  if (version > SCHEMA_VERSION) {
    throw new CutlineError(
      'UNSUPPORTED_VERSION',
      `Project schema version ${version} is newer than this Cutline build supports (${SCHEMA_VERSION}).`,
      { hint: 'Upgrade Cutline to open this project.' },
    );
  }
  while (version < SCHEMA_VERSION) {
    const step = migrations.find((m) => m.from === version);
    if (!step) {
      throw new CutlineError('UNSUPPORTED_VERSION', `No migration from schema version ${version}.`);
    }
    doc = step.migrate(doc);
    version = step.to;
  }
  return ProjectSchema.parse(doc);
}
