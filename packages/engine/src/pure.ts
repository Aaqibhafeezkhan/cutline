// DOM-free helpers, importable from Node (tests, server) without loading PixiJS/WebCodecs.
export {
  placeMedia,
  placeText,
  captionCenterY,
  parseColor,
  type Placement,
  type Size,
} from './render/layout';
export { colorMatrix, applyColorMatrix, hasColorEffects, type ColorMatrix } from './render/color';
export {
  layoutWords,
  captionTokens,
  type LaidOutLine,
  type LaidOutWord,
} from './render/caption-layout';
export { mixChunk, clipSamples, segmentsInWindow, sourceWindow, type PcmChunk } from './audio/mix';
export {
  exportPlan,
  type ExportOptions,
  type ExportProgress,
  type ExportResult,
} from './export/plan';
export { shapeMetrics } from './render/shape';
export {
  orientedBounds,
  type LayerBounds,
  type LocalRect,
  type OrientedRect,
} from './render/bounds';
