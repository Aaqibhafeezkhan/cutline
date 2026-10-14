import { join } from 'node:path';
import type { OpContext } from '@cutline/core';
import { chatModelFromEnv, type ChatModel } from './chat/model';
import { ChatService } from './chat/service';
import type { CutlineConfig } from './config';
import { DocumentService } from './documents';
import { ExportService } from './exports';
import { AnalysisService } from './media/analysis';
import { AssetService } from './media/assets';
import { Ffmpeg } from './media/ffmpeg';
import { WhisperTranscriber, type Transcriber } from './media/transcribe';
import { PresenceService } from './presence';
import { Renderer } from './render/renderer';
import { LocalBlobStore, LocalProjectStore } from './storage/local';
import type { BlobStore, ProjectStore } from './storage/types';

export interface Services {
  config: CutlineConfig;
  docs: DocumentService;
  blobs: BlobStore;
  ffmpeg: Ffmpeg;
  assets: AssetService;
  analysis: AnalysisService;
  renderer: Renderer;
  exports: ExportService;
  presence: PresenceService;
  transcriber: Transcriber;
  /** In-editor chat with Claude (disabled without ANTHROPIC_API_KEY). */
  chat: ChatService;
}

export interface ServiceOverrides {
  projectStore?: ProjectStore;
  blobStore?: BlobStore;
  transcriber?: Transcriber;
  ctx?: OpContext;
  /** Chat model override (tests); null disables chat. Default: from the environment. */
  chatModel?: ChatModel | null;
}

export function createServices(config: CutlineConfig, overrides: ServiceOverrides = {}): Services {
  const projects =
    overrides.projectStore ?? new LocalProjectStore(join(config.dataDir, 'projects'));
  const blobs = overrides.blobStore ?? new LocalBlobStore(config.dataDir);
  const ffmpeg = new Ffmpeg(config.ffmpegPath, config.ffprobePath);
  const docs = new DocumentService(projects, overrides.ctx);
  const transcriber = overrides.transcriber ?? new WhisperTranscriber(config.whisperModel);
  const renderer = new Renderer(ffmpeg, blobs);
  const services: Services = {
    config,
    docs,
    blobs,
    ffmpeg,
    assets: new AssetService(config, blobs, docs, ffmpeg),
    analysis: new AnalysisService(blobs, ffmpeg, transcriber),
    renderer,
    exports: new ExportService(renderer, blobs, docs),
    presence: new PresenceService(),
    transcriber,
    chat: undefined as unknown as ChatService,
  };
  const chatModel =
    overrides.chatModel !== undefined ? overrides.chatModel : chatModelFromEnv(config);
  services.chat = new ChatService(services, {
    model: chatModel,
    modelId: config.chatModel,
    effort: config.chatEffort,
    fake: config.chatFake && overrides.chatModel === undefined,
  });
  return services;
}
