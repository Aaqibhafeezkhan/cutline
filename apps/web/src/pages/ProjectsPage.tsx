import { useEffect, useState, type FormEvent } from 'react';
import { Clapperboard, KeyRound, Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';
import { api, ApiError, setToken, type Health, type ProjectListItem } from '@/lib/api';
import { navigate } from '@/lib/router';
import { formatTimecode } from '@/lib/utils';

export function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [needsToken, setNeedsToken] = useState(false);
  const [offline, setOffline] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  const load = () => {
    setOffline(false);
    api
      .health()
      .then(setHealth)
      .catch(() => setOffline(true));
    api
      .listProjects()
      .then((r) => {
        setProjects(r.projects);
        setNeedsToken(false);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) setNeedsToken(true);
        else setOffline(true);
      });
  };
  useEffect(() => {
    document.title = 'Cutline';
    load();
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      const { project } = await api.createProject(name.trim() || 'Untitled project');
      navigate(`/p/${project.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-full max-w-3xl flex-col gap-8 px-6 py-12">
      <header className="flex items-center gap-3">
        <img src="/favicon.svg" alt="" className="size-9" />
        <div>
          <h1 className="text-xl font-semibold">Cutline</h1>
          <p className="text-sm text-muted">
            A video editor your AI agent can drive over MCP, while you watch.
          </p>
        </div>
      </header>

      {offline && (
        <div role="alert" className="rounded-md border border-danger/40 bg-danger/10 p-4 text-sm">
          Cannot reach the Cutline server. Start it with <code>pnpm dev</code> (or{' '}
          <code>pnpm start</code>) and{' '}
          <button className="underline" onClick={load}>
            retry
          </button>
          .
        </div>
      )}
      {health && !health.ffmpeg && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          ffmpeg was not found on the server. Editing and browser export work, but perception tools
          (silence, scenes, transcripts, frames) and server-side export need ffmpeg on{' '}
          <code>PATH</code>.
        </div>
      )}

      {needsToken ? (
        <form
          className="space-y-2 rounded-md border border-border bg-surface p-4"
          onSubmit={(e) => {
            e.preventDefault();
            const value = new FormData(e.currentTarget).get('token');
            setToken(typeof value === 'string' ? value : null);
            load();
          }}
        >
          <Label htmlFor="token" className="flex items-center gap-1">
            <KeyRound className="size-3.5" /> This server requires an access token (CUTLINE_TOKEN)
          </Label>
          <div className="flex gap-2">
            <Input id="token" name="token" type="password" autoComplete="off" />
            <Button type="submit">Unlock</Button>
          </div>
        </form>
      ) : (
        <form onSubmit={(e) => void create(e)} className="flex gap-2">
          <Input
            aria-label="New project name"
            placeholder="New project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-9"
          />
          <Button type="submit" disabled={creating} className="h-9">
            {creating ? <Loader2 className="animate-spin" /> : <Plus />} New project
          </Button>
        </form>
      )}

      <section aria-label="Projects">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Projects</h2>
        {projects === null && !offline && !needsToken && (
          <p className="text-sm text-muted">Loading…</p>
        )}
        {projects?.length === 0 && (
          <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted">
            No projects yet. Create one above, or ask your agent to call <code>create_project</code>
            .
          </p>
        )}
        <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {projects?.map((p) => (
            <li key={p.id}>
              <a
                href={`/p/${p.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/p/${p.id}`);
                }}
                className="flex items-center gap-3 bg-surface px-4 py-3 hover:bg-surface-2"
              >
                <Clapperboard className="size-4 text-muted" aria-hidden />
                <span className="flex-1 font-medium">{p.name}</span>
                <span className="text-xs tabular-nums text-muted">
                  {formatTimecode(p.duration, 1)} · {p.clipCount} clips ·{' '}
                  {new Date(p.updatedAt).toLocaleString()}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </section>

      {health && (
        <footer className="mt-auto text-xs text-muted">
          Server {health.version} · ffmpeg {health.ffmpeg ?? 'missing'} · MCP endpoint{' '}
          <code>
            {location.port === '5173'
              ? `http://${location.hostname}:4100/mcp`
              : `${location.origin}/mcp`}
          </code>
        </footer>
      )}
    </div>
  );
}
