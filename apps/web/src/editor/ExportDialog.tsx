import { useEffect, useRef, useState } from 'react';
import { Cpu, Download, Globe, Loader2, Server } from 'lucide-react';
import { projectDuration } from '@cutline/core';
import { exportVideo, type ExportProgress } from '@cutline/engine';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Select } from '@/components/ui/misc';
import { api, assetUrl, getToken, withToken } from '@/lib/api';
import { useEditor } from '@/lib/store';
import { cn, formatBytes } from '@/lib/utils';

type Where = 'browser' | 'server';
type Quality = 'draft' | 'standard' | 'high';

const BROWSER_QUALITY: Record<Quality, 'medium' | 'high' | 'very-high'> = {
  draft: 'medium',
  standard: 'high',
  high: 'very-high',
};

export function ExportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const project = useEditor((s) => s.project);
  const projectId = useEditor((s) => s.projectId);
  const activity = useEditor((s) => s.activity);
  const [where, setWhere] = useState<Where>('browser');
  const [quality, setQuality] = useState<Quality>('standard');
  const [width, setWidth] = useState('native');
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [result, setResult] = useState<{ url: string; name: string; size: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [serverJob, setServerJob] = useState<string | null>(null);
  const [exports, setExports] = useState<
    Array<{ fileName: string; url: string; sizeBytes: number }>
  >([]);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (open && projectId)
      api
        .listExports(projectId)
        .then((r) => setExports(r.exports))
        .catch(() => undefined);
  }, [open, projectId, result]);

  // Server export progress arrives as activity events.
  const job = serverJob ? activity.find((a) => a.id === serverJob) : undefined;
  useEffect(() => {
    if (!job) return;
    if (job.status === 'finished' && job.link) {
      setResult({
        url: withToken(`${job.link}?download`),
        name: job.link.split('/').pop()!,
        size: 0,
      });
      setServerJob(null);
    } else if (job.status === 'failed') {
      setError(job.message);
      setServerJob(null);
    }
  }, [job]);

  if (!project || !projectId) return null;
  const busy = progress !== null || serverJob !== null;
  const duration = projectDuration(project);

  const start = async () => {
    setError(null);
    setResult(null);
    if (where === 'server') {
      try {
        const { job } = await api.startExport(projectId, quality);
        setServerJob(job.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    abort.current = new AbortController();
    setProgress({ phase: 'preparing', progress: 0, frame: 0, totalFrames: 0 });
    try {
      const token = getToken();
      const out = await exportVideo(
        project,
        {
          url: (asset) => assetUrl(projectId, asset),
          fetchInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
        },
        {
          quality: BROWSER_QUALITY[quality],
          width: width === 'native' ? undefined : Number(width),
          onProgress: setProgress,
          signal: abort.current.signal,
        },
      );
      const name = `${project.name.replace(/[^\w-]+/g, '-').toLowerCase()}.${out.extension}`;
      setResult({ url: URL.createObjectURL(out.blob), name, size: out.blob.size });
    } catch (err) {
      if ((err as Error).name !== 'AbortError')
        setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProgress(null);
      abort.current = null;
    }
  };

  const pct =
    where === 'server'
      ? Math.round((job?.progress ?? 0) * 100)
      : Math.round((progress?.progress ?? 0) * 100);

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent title="Export video" description={`${duration.toFixed(1)} s timeline → MP4`}>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Where to render">
          {(
            [
              [
                'browser',
                Globe,
                'In this browser',
                'WebCodecs + WebGL, exactly what the preview shows',
              ],
              ['server', Server, 'On the server', 'ffmpeg; also what export_video uses for agents'],
            ] as const
          ).map(([value, Icon, title, text]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={where === value}
              disabled={busy}
              onClick={() => setWhere(value)}
              className={cn(
                'rounded-md border p-3 text-left',
                where === value
                  ? 'border-primary bg-primary/10'
                  : 'border-border hover:bg-surface-2',
              )}
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <Icon className="size-4" /> {title}
              </div>
              <p className="mt-1 text-xs text-muted">{text}</p>
            </button>
          ))}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <label className="space-y-1 text-xs text-muted">
            Quality
            <Select
              label="Quality"
              value={quality}
              onValueChange={(v) => setQuality(v as Quality)}
              options={[
                { value: 'draft', label: 'Draft (fast)' },
                { value: 'standard', label: 'Standard' },
                { value: 'high', label: 'High' },
              ]}
            />
          </label>
          {where === 'browser' && (
            <label className="space-y-1 text-xs text-muted">
              Resolution
              <Select
                label="Resolution"
                value={width}
                onValueChange={setWidth}
                options={[
                  {
                    value: 'native',
                    label: `${project.settings.width}×${project.settings.height} (project)`,
                  },
                  { value: '1280', label: '1280 wide' },
                  { value: '640', label: '640 wide' },
                ]}
              />
            </label>
          )}
        </div>

        {busy && (
          <div className="mt-4" aria-live="polite">
            <div className="mb-1 flex items-center gap-2 text-xs text-muted">
              <Loader2 className="size-3.5 animate-spin" />
              {where === 'browser'
                ? (progress?.phase ?? 'rendering')
                : 'rendering on server'} · {pct}%
            </div>
            <div className="h-1.5 overflow-hidden rounded bg-surface-2">
              <div className="h-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}
        {error && (
          <p role="alert" className="mt-4 rounded bg-danger/15 p-2 text-xs text-danger">
            {error}
          </p>
        )}
        {result && (
          <a
            href={result.url}
            download={result.name}
            className="mt-4 flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-300 hover:bg-emerald-500/20"
          >
            <Download className="size-4" /> {result.name}
            {result.size > 0 && (
              <span className="text-xs text-muted">({formatBytes(result.size)})</span>
            )}
          </a>
        )}

        <div className="mt-5 flex justify-end gap-2">
          {progress && (
            <Button variant="ghost" onClick={() => abort.current?.abort()}>
              Cancel
            </Button>
          )}
          <Button onClick={() => void start()} disabled={busy || duration === 0}>
            <Cpu /> Export
          </Button>
        </div>

        {exports.length > 0 && (
          <div className="mt-5 border-t border-border pt-3">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              Server exports
            </h3>
            <ul className="space-y-1 text-xs">
              {exports.slice(0, 5).map((e) => (
                <li key={e.fileName}>
                  <a className="text-primary hover:underline" href={withToken(`${e.url}?download`)}>
                    {e.fileName}
                  </a>{' '}
                  <span className="text-muted">{formatBytes(e.sizeBytes)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
