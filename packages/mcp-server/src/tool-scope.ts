import { AsyncLocalStorage } from 'node:async_hooks';
import type { Proposal } from '@cutline/core';

/** The MCP tool call currently running (set by the MCP server for every tool handler). */
export interface ToolCallScope {
  tool: string;
  /** Proposals created during this call (suggest mode). */
  proposals: Proposal[];
}

export const toolScope = new AsyncLocalStorage<ToolCallScope>();
