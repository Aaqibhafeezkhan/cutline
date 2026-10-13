import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { sequentialContext, type Origin } from '@cutline/core';
import { loadConfig } from '../src/config';
import { DocumentService } from '../src/documents';
import { allowedHostnames, checkRequest } from '../src/http/security';
import { AssetService, isPrivateAddress } from '../src/media/assets';
import { Ffmpeg } from '../src/media/ffmpeg';
import { imageSize } from '../src/media/probe';
import { PresenceService } from '../src/presence';
import { LocalBlobStore, LocalProjectStore } from '../src/storage/local';
import { tempDir } from './helpers';

const AGENT: Origin = { kind: 'agent', name: 'Claude' };

const req = (headers: Record<string, string>, url = '/api/projects') =>
  ({ headers, url }) as unknown as IncomingMessage;

describe('security', () => {
  const config = loadConfig({ token: undefined, allowedHosts: ['editor.example.com'] }, {});

  it('accepts loopback and configured hosts only', () => {
    const hosts = allowedHostnames(config);
    expect(checkRequest(req({ host: 'localhost:5173' }), config, hosts)).toBeNull();
    expect(
      checkRequest(req({ host: '127.0.0.1:4100', origin: 'http://localhost:5173' }), config, hosts),
    ).toBeNull();
    expect(checkRequest(req({ host: 'editor.example.com' }), config, hosts)).toBeNull();
    expect(checkRequest(req({ host: 'evil.com' }), config, hosts)).toMatch(/not allowed/);
    expect(
      checkRequest(req({ host: 'localhost', origin: 'https://evil.com' }), config, hosts),
    ).toMatch(/Origin/);
    expect(checkRequest(req({}), config, hosts)).toMatch(/not allowed/);
  });

  it('enforces the bearer token when configured', () => {
    const secured = { ...config, token: 's3cret' };
    const hosts = allowedHostnames(secured);
    expect(checkRequest(req({ host: 'localhost' }), secured, hosts)).toMatch(/token/);
    expect(
      checkRequest(req({ host: 'localhost', authorization: 'Bearer s3cret' }), secured, hosts),
    ).toBeNull();
    expect(checkRequest(req({ host: 'localhost' }, '/ws?token=s3cret'), secured, hosts)).toBeNull();
    expect(
      checkRequest(req({ host: 'localhost', authorization: 'Bearer nope!!' }), secured, hosts),
    ).toMatch(/token/);
  });

  it('classifies private addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '192.168.0.1',
      '172.20.0.1',
      '169.254.1.1',
      '::1',
      'fd00::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '2001:db8::1'])
      expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe('storage', () => {
  it('refuses path traversal and lists blobs', async () => {
    const dir = await tempDir();
    const blobs = new LocalBlobStore(dir);
    await blobs.put('assets/a/x.txt', Buffer.from('hello'));
    expect((await blobs.stat('assets/a/x.txt'))?.size).toBe(5);
    expect(await blobs.list('assets')).toEqual(['assets/a/x.txt']);
    expect(await blobs.list('missing')).toEqual([]);
    expect(await blobs.stat('assets/none')).toBeNull();
    await expect(blobs.put('../escape.txt', Buffer.from('x'))).rejects.toThrow(
      /Invalid storage key/,
    );
    await blobs.delete('assets/a');
    expect(await blobs.stat('assets/a/x.txt')).toBeNull();
  });

  it('persists projects and reloads them with a fresh service', async () => {
    const dir = await tempDir();
    const store = new LocalProjectStore(dir);
    const docs = new DocumentService(store, sequentialContext());
    const p = await docs.create({ name: 'Persist me' });
    await docs.apply(p.id, [{ type: 'add_track', kind: 'caption' }], AGENT);
    await docs.flush();
    const reloaded = new DocumentService(store);
    const { project } = await reloaded.get(p.id);
    expect(project.tracks).toHaveLength(3);
    expect((await reloaded.list())[0]).toMatchObject({ id: p.id, name: 'Persist me' });
    await expect(reloaded.get('nope')).rejects.toMatchObject({
      hint: expect.stringMatching(/Existing projects/),
    });
    expect(await reloaded.resolveId(undefined)).toBe(p.id);
    await writeFile(join(dir, 'broken.json'), '{not json');
    expect((await new DocumentService(store).list()).map((x) => x.id)).toEqual([p.id]);
  });

  it('serializes concurrent edits and emits patches in order', async () => {
    const docs = new DocumentService(new LocalProjectStore(await tempDir()), sequentialContext());
    const p = await docs.create({ name: 'Concurrent' });
    const versions: number[] = [];
    docs.events.on('change', (e) => versions.push(e.version));
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        docs.apply(p.id, [{ type: 'add_track', kind: 'video', name: `T${i}` }], AGENT),
      ),
    );
    expect(versions).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const { project } = await docs.get(p.id);
    expect(project.tracks).toHaveLength(12);
  });
});

describe('assets', () => {
  it('only reads files inside the media roots', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await mkdir(join(root, 'sub'), { recursive: true });
    await writeFile(join(outside, 'secret.mp4'), 'x');
    const config = loadConfig({ dataDir: root, mediaRoots: [join(root, 'sub')] }, {});
    const docs = new DocumentService(new LocalProjectStore(join(root, 'projects')));
    const p = await docs.create({ name: 'A' });
    const svc = new AssetService(
      config,
      new LocalBlobStore(root),
      docs,
      new Ffmpeg('ffmpeg', 'ffprobe'),
    );
    await expect(svc.importFromPath(p.id, join(outside, 'secret.mp4'), AGENT)).rejects.toThrow(
      /not allowed/,
    );
    await expect(svc.importFromPath(p.id, 'relative.mp4', AGENT)).rejects.toThrow(/absolute path/);
    await expect(svc.importFromUrl(p.id, 'file:///etc/passwd', AGENT)).rejects.toThrow(/http/);
    await expect(svc.importFromUrl(p.id, 'http://127.0.0.1:1/x.mp4', AGENT)).rejects.toThrow(
      /private address/,
    );
  });

  it('reads image sizes from headers', () => {
    const png = Buffer.alloc(24);
    png.writeUInt32BE(0x89504e47, 0);
    png.writeUInt32BE(320, 16);
    png.writeUInt32BE(200, 20);
    expect(imageSize(png)).toEqual({ width: 320, height: 200 });
    const gif = Buffer.from('GIF89a\x40\x01\xc8\x00', 'latin1');
    expect(imageSize(gif)).toEqual({ width: 320, height: 200 });
    expect(imageSize(Buffer.from('nope'))).toBeNull();
  });
});

describe('presence', () => {
  it('tracks browsers and agents per project', () => {
    const presence = new PresenceService();
    const changes: string[] = [];
    presence.events.on('change', (id) => changes.push(id));
    presence.join('p1', { id: 'b1', kind: 'browser', name: 'Editor' });
    presence.join('p1', { id: 'a1', kind: 'agent', name: 'Claude' }, true);
    presence.join('p2', { id: 'a1', kind: 'agent', name: 'Claude' }, true);
    expect(presence.list('p1').map((p) => p.id)).toEqual(['b1']);
    expect(presence.hasBrowser('p1')).toBe(true);
    presence.leave('b1');
    presence.leave('unknown');
    expect(presence.hasBrowser('p1')).toBe(false);
    expect(changes).toEqual(['p1', 'p1', 'p1', 'p2', 'p1']);
  });
});
