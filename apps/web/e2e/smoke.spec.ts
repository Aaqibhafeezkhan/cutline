import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SERVER_PORT, fixtures } from '../playwright.config';

async function agent() {
  const client = new Client({ name: 'Smoke agent', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${SERVER_PORT}/mcp`)),
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    return r.structuredContent as Record<string, unknown>;
  };
  return { client, call };
}

test('create a project, watch an agent edit it live, edit and export in the browser', async ({
  page,
}) => {
  // 1. Projects page → create a project from the UI.
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Cutline' })).toBeVisible();
  await page.getByLabel('New project name').fill('Smoke test');
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(page).toHaveURL(/\/p\/proj_/);
  const projectId = page.url().split('/p/')[1]!;
  await expect(page.getByRole('region', { name: 'Timeline' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'V1' })).toBeVisible();

  // 2. An MCP client edits the same project; the editor updates without reload.
  const { client, call } = await agent();
  const { asset } = (await call('add_asset', { projectId, path: join(fixtures, 'still.png') })) as {
    asset: { id: string };
  };
  await call('add_clip', { projectId, assetId: asset.id, duration: 2 });
  await call('add_text_overlay', { projectId, text: 'Hello from MCP', start: 0, duration: 2 });

  const textClip = page.locator('[data-clip-id]', { hasText: 'Hello from MCP' });
  await expect(textClip).toBeVisible();
  await expect(textClip).toHaveClass(/agent-highlight/);
  await expect(page.getByText('Smoke agent').first()).toBeVisible();
  await page.getByRole('tab', { name: 'Activity' }).click();
  await expect(page.getByText(/Added text "Hello from MCP"/)).toBeVisible();

  // 3. Human edits: select + delete, then undo (shared history with the agent).
  await textClip.click();
  await page.keyboard.press('Delete');
  await expect(textClip).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-clip-id]', { hasText: 'Hello from MCP' })).toBeVisible();

  // The agent sees the human's changes.
  const state = await call('get_project', { projectId });
  expect(JSON.stringify(state.project)).toContain('Hello from MCP');
  await client.close();

  // 4. Export in the browser (WebCodecs in a worker).
  await page.getByRole('button', { name: 'Export' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export video' });
  await dialog.getByRole('radio', { name: /In this browser/ }).click();
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(dialog.getByRole('link', { name: /smoke-test\.(mp4|webm)/ })).toBeVisible({
    timeout: 60_000,
  });
});
