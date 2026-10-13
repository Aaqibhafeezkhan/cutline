import { defaultContext, type OpContext } from './ids';
import { ProjectSchema, SCHEMA_VERSION, type Project, type ProjectSettings } from './schema';

export interface CreateProjectInput {
  name: string;
  id?: string;
  settings?: Partial<ProjectSettings>;
  /** Create the default V1 + A1 tracks (default true). */
  defaultTracks?: boolean;
}

export function createProject(input: CreateProjectInput, ctx: OpContext = defaultContext): Project {
  const now = ctx.now();
  const tracks =
    input.defaultTracks === false
      ? []
      : [
          { id: ctx.newId('track'), kind: 'video' as const, name: 'V1' },
          { id: ctx.newId('track'), kind: 'audio' as const, name: 'A1' },
        ];
  return ProjectSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: input.id ?? ctx.newId('proj'),
    name: input.name,
    createdAt: now,
    updatedAt: now,
    settings: input.settings ?? {},
    assets: [],
    tracks,
  });
}
