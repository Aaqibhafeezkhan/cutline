import { z } from 'zod';
import {
  AnimatablePropertySchema,
  AssetSchema,
  ColorSchema,
  DurationSchema,
  IdSchema,
  KeyframeSchema,
  ProjectSettingsSchema,
  TimeSchema,
  TrackKindSchema,
  TransitionSchema,
  WordSchema,
} from '../schema';

// Patch schemas have no defaults: only the fields that are sent are changed.

export const TransformPatchSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    scale: z.number().positive().max(20),
    rotation: z.number().finite(),
    opacity: z.number().min(0).max(1),
  })
  .partial();

export const EffectsPatchSchema = z
  .object({
    brightness: z.number().min(-1).max(1).nullable(),
    contrast: z.number().min(-1).max(1).nullable(),
    saturation: z.number().min(-1).max(1).nullable(),
    blur: z.number().min(0).max(50).nullable(),
  })
  .partial()
  .describe('Effect values to set; null removes an effect');

export const TextStylePatchSchema = z
  .object({
    fontFamily: z.string().min(1).max(200),
    fontSize: z.number().positive().max(1000),
    color: ColorSchema,
    backgroundColor: ColorSchema.nullable(),
    align: z.enum(['left', 'center', 'right']),
    bold: z.boolean(),
    italic: z.boolean(),
    strokeColor: ColorSchema,
    strokeWidth: z.number().min(0).max(50),
    maxWidth: z.number().min(0.05).max(1),
  })
  .partial();

export const CaptionStylePatchSchema = z
  .object({
    fontFamily: z.string().min(1).max(200),
    fontSize: z.number().positive().max(400),
    color: ColorSchema,
    backgroundColor: ColorSchema.nullable(),
    highlightColor: ColorSchema.nullable(),
    position: z.enum(['bottom', 'middle', 'top']),
    margin: z.number().min(0).max(0.5),
    maxWidth: z.number().min(0.1).max(1),
  })
  .partial();

export const ClipPropsPatchSchema = z
  .object({
    name: z.string().max(256),
    transform: TransformPatchSchema,
    effects: EffectsPatchSchema,
    keyframes: z
      .partialRecord(AnimatablePropertySchema, z.array(KeyframeSchema).max(500))
      .describe('Replaces the keyframes of each given property; [] removes the animation'),
    fadeIn: z.number().min(0).max(60),
    fadeOut: z.number().min(0).max(60),
    volume: z.number().min(0).max(4),
    muted: z.boolean(),
    text: z.string().min(1).max(2000),
    style: TextStylePatchSchema,
    words: z.array(WordSchema).max(500).describe('Caption word timings, clip-relative seconds'),
    transitionIn: TransitionSchema.nullable(),
  })
  .partial();

const PlacementModeSchema = z
  .enum(['error', 'overwrite', 'insert'])
  .default('error')
  .describe(
    'If the range is occupied: "error" (default), "overwrite" existing material, or "insert" (push later clips right)',
  );

const RangeSchema = z
  .object({ start: TimeSchema, end: TimeSchema })
  .refine((r) => r.end > r.start, { message: 'end must be greater than start' });

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export const UpdateProjectOpSchema = z.object({
  type: z.literal('update_project'),
  name: z.string().min(1).max(200).optional(),
  settings: ProjectSettingsSchema.partial().optional(),
});

export const AddAssetOpSchema = z.object({
  type: z.literal('add_asset'),
  asset: AssetSchema.extend({ id: IdSchema.optional(), createdAt: z.string().optional() }),
});

export const RemoveAssetOpSchema = z.object({
  type: z.literal('remove_asset'),
  assetId: IdSchema,
  removeClips: z.boolean().default(false).describe('Also delete clips that use the asset'),
});

export const AddTrackOpSchema = z.object({
  type: z.literal('add_track'),
  kind: TrackKindSchema,
  name: z.string().min(1).max(100).optional(),
  index: z.number().int().min(0).optional().describe('Stack position, 0 = bottom (default: top)'),
  id: IdSchema.optional(),
});

export const UpdateTrackOpSchema = z.object({
  type: z.literal('update_track'),
  trackId: IdSchema,
  name: z.string().min(1).max(100).optional(),
  muted: z.boolean().optional(),
  hidden: z.boolean().optional(),
  locked: z.boolean().optional(),
  volume: z.number().min(0).max(4).optional(),
  captionStyle: CaptionStylePatchSchema.optional(),
});

export const RemoveTrackOpSchema = z.object({
  type: z.literal('remove_track'),
  trackId: IdSchema,
});

export const MoveTrackOpSchema = z.object({
  type: z.literal('move_track'),
  trackId: IdSchema,
  index: z.number().int().min(0).describe('New stack position, 0 = bottom'),
});

export const AddClipOpSchema = z.object({
  type: z.literal('add_clip'),
  assetId: IdSchema,
  trackId: IdSchema.optional().describe('Target track (default: first suitable track with room)'),
  start: TimeSchema.optional().describe('Timeline position (default: end of the target track)'),
  sourceStart: TimeSchema.default(0).describe('In-point within the asset'),
  duration: DurationSchema.optional().describe(
    'Default: rest of the asset after sourceStart (5 s for images)',
  ),
  clipType: z
    .enum(['video', 'audio', 'image'])
    .optional()
    .describe('Default from asset kind; use "audio" to place only the audio of a video'),
  mode: PlacementModeSchema,
  props: ClipPropsPatchSchema.optional(),
  id: IdSchema.optional(),
});

export const AddTextOpSchema = z.object({
  type: z.literal('add_text'),
  text: z.string().min(1).max(2000),
  start: TimeSchema,
  duration: DurationSchema.default(3),
  trackId: IdSchema.optional().describe('Video track (default: a text track on top)'),
  style: TextStylePatchSchema.optional(),
  transform: TransformPatchSchema.optional(),
  mode: PlacementModeSchema,
  id: IdSchema.optional(),
});

export const CueSchema = z
  .object({
    start: TimeSchema,
    end: TimeSchema,
    text: z.string().min(1).max(2000),
    words: z.array(WordSchema).max(500).optional().describe('Absolute timeline word timings'),
  })
  .refine((c) => c.end > c.start, { message: 'cue end must be greater than start' });

export const AddCaptionsOpSchema = z.object({
  type: z.literal('add_captions'),
  cues: z.array(CueSchema).min(1).max(5000),
  trackId: IdSchema.optional().describe(
    'Caption track (default: first caption track or a new one)',
  ),
  replace: z.boolean().default(true).describe('Remove existing cues on that track first'),
  style: CaptionStylePatchSchema.optional(),
});

export const SplitClipOpSchema = z.object({
  type: z.literal('split_clip'),
  clipId: IdSchema,
  time: TimeSchema.describe('Timeline time of the cut'),
  newClipId: IdSchema.optional(),
});

export const TrimClipOpSchema = z
  .object({
    type: z.literal('trim_clip'),
    clipId: IdSchema,
    start: TimeSchema.optional().describe('New timeline start (moves the in-point)'),
    end: TimeSchema.optional().describe('New timeline end (moves the out-point)'),
    ripple: z.boolean().default(false).describe('Shift later clips on the track to follow'),
  })
  .refine((o) => o.start !== undefined || o.end !== undefined, {
    message: 'give start and/or end',
  });

export const MoveClipOpSchema = z.object({
  type: z.literal('move_clip'),
  clipId: IdSchema,
  start: TimeSchema,
  trackId: IdSchema.optional().describe('Move to another track of a compatible kind'),
  mode: PlacementModeSchema,
});

export const DeleteClipsOpSchema = z.object({
  type: z.literal('delete_clips'),
  clipIds: z.array(IdSchema).min(1).max(1000),
  ripple: z.boolean().default(false).describe('Close the gaps on the same track'),
});

export const DeleteRangeOpSchema = z.object({
  type: z.literal('delete_range'),
  ranges: z.array(RangeSchema).min(1).max(2000).describe('Timeline ranges to cut out'),
  trackIds: z
    .array(IdSchema)
    .optional()
    .describe('Limit to these tracks (default: all unlocked tracks, keeps sync)'),
  ripple: z.boolean().default(true).describe('Close the gaps (default true)'),
});

export const SetClipPropsOpSchema = z.object({
  type: z.literal('set_clip_props'),
  clipId: IdSchema,
  props: ClipPropsPatchSchema,
});

export const SetTransitionOpSchema = z.object({
  type: z.literal('set_transition'),
  clipId: IdSchema.describe('The clip the transition leads INTO'),
  transition: TransitionSchema.nullable().describe('null removes the transition'),
});

export const SetVolumeOpSchema = z
  .object({
    type: z.literal('set_volume'),
    clipId: IdSchema.optional(),
    trackId: IdSchema.optional(),
    volume: z.number().min(0).max(4).optional().describe('Linear gain: 0 = silent, 1 = unchanged'),
    muted: z.boolean().optional(),
    fadeIn: z.number().min(0).max(60).optional(),
    fadeOut: z.number().min(0).max(60).optional(),
  })
  .refine((o) => (o.clipId === undefined) !== (o.trackId === undefined), {
    message: 'give exactly one of clipId or trackId',
  });

export const OperationSchema = z.discriminatedUnion('type', [
  UpdateProjectOpSchema,
  AddAssetOpSchema,
  RemoveAssetOpSchema,
  AddTrackOpSchema,
  UpdateTrackOpSchema,
  RemoveTrackOpSchema,
  MoveTrackOpSchema,
  AddClipOpSchema,
  AddTextOpSchema,
  AddCaptionsOpSchema,
  SplitClipOpSchema,
  TrimClipOpSchema,
  MoveClipOpSchema,
  DeleteClipsOpSchema,
  DeleteRangeOpSchema,
  SetClipPropsOpSchema,
  SetTransitionOpSchema,
  SetVolumeOpSchema,
]);

export type Operation = z.output<typeof OperationSchema>;
export type OperationInput = z.input<typeof OperationSchema>;
export type OperationType = Operation['type'];
export type OpOf<T extends OperationType> = Extract<Operation, { type: T }>;
export type ClipPropsPatch = z.output<typeof ClipPropsPatchSchema>;
export type Cue = z.output<typeof CueSchema>;
