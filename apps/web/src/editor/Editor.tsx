import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { projectDuration } from '@cutline/core';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/misc';
import { seek, togglePlay } from '@/lib/player-bridge';
import { useEditor, usePlayhead } from '@/lib/store';
import { isTypingTarget } from '@/lib/utils';
import { ActivityFeed } from './ActivityFeed';
import { AssetBin } from './AssetBin';
import { CaptionsPanel } from './CaptionsPanel';
import { addText, deleteSelection, nudgeSelection, selectAll, splitAtPlayhead } from './commands';
import { BrandKitDialog } from './BrandKitDialog';
import { ChatPanel } from './ChatPanel';
import { ConnectDialog } from './ConnectDialog';
import { ExportDialog } from './ExportDialog';
import { Preview } from './Preview';
import { Properties } from './Properties';
import { ShortcutsDialog } from './ShortcutsDialog';
import { Timeline } from './timeline/Timeline';
import { TopBar } from './TopBar';

const CHAT_OPEN_KEY = 'cutline.chatOpen';

function initialChatOpen(): boolean {
  try {
    return localStorage.getItem(CHAT_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function useShortcuts(openHelp: () => void, toggleChat: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || document.querySelector('[role="dialog"]')) return;
      const { project, undo, redo, select, zoom, setZoom } = useEditor.getState();
      if (!project) return;
      const mod = e.ctrlKey || e.metaKey;
      const frame = 1 / project.settings.fps;
      const t = usePlayhead.getState().time;
      const key = e.key.toLowerCase();
      let handled = true;
      if (mod && key === 'z') (e.shiftKey ? redo : undo)();
      else if (mod && key === 'y') redo();
      else if (mod && key === 'a') selectAll();
      else if (mod && key === 'k') toggleChat();
      else if (e.key === ' ') togglePlay();
      else if (key === 's' && !mod) void splitAtPlayhead();
      else if (key === 't' && !mod) void addText();
      else if (e.key === 'Delete' || e.key === 'Backspace') void deleteSelection(e.shiftKey);
      else if (e.key === 'ArrowLeft' && e.altKey) void nudgeSelection(-frame);
      else if (e.key === 'ArrowRight' && e.altKey) void nudgeSelection(frame);
      else if (e.key === 'ArrowLeft') seek(t - (e.shiftKey ? 1 : frame));
      else if (e.key === 'ArrowRight') seek(t + (e.shiftKey ? 1 : frame));
      else if (e.key === 'Home') seek(0);
      else if (e.key === 'End') seek(projectDuration(project));
      else if (e.key === '+' || e.key === '=') setZoom(zoom * 1.4);
      else if (e.key === '-' || e.key === '_') setZoom(zoom / 1.4);
      else if (e.key === 'Escape') select([]);
      else if (e.key === '?') openHelp();
      else handled = false;
      if (handled) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openHelp, toggleChat]);
}

export function Editor({ projectId }: { projectId: string }) {
  const project = useEditor((s) => s.project);
  const connection = useEditor((s) => s.connection);
  const [exportOpen, setExportOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [brandOpen, setBrandOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(initialChatOpen);
  const toggleChat = useCallback(() => {
    setChatOpen((open) => {
      try {
        localStorage.setItem(CHAT_OPEN_KEY, open ? '0' : '1');
      } catch {
        // storage unavailable: the panel state lives for this page only
      }
      return !open;
    });
  }, []);
  const openHelp = useCallback(() => setHelpOpen(true), []);

  useEffect(() => {
    useEditor.getState().open(projectId);
    return () => useEditor.getState().close();
  }, [projectId]);

  useEffect(() => {
    if (project) document.title = `${project.name} · Cutline`;
  }, [project]);

  useShortcuts(openHelp, toggleChat);

  if (!project) {
    return (
      <div
        className="flex h-full items-center justify-center gap-2 text-sm text-muted"
        role="status"
      >
        <Loader2 className="size-4 animate-spin" />
        {connection === 'closed' ? 'Connecting to the Cutline server…' : 'Loading project…'}
      </div>
    );
  }

  return (
    <div className="grid h-full grid-cols-1 grid-rows-[auto_minmax(0,1fr)_minmax(180px,38%)]">
      <TopBar
        onExport={() => setExportOpen(true)}
        onConnect={() => setConnectOpen(true)}
        onShortcuts={() => setHelpOpen(true)}
        onBrand={() => setBrandOpen(true)}
        chatOpen={chatOpen}
        onChat={toggleChat}
      />
      <div
        className={
          chatOpen
            ? 'grid min-h-0 grid-cols-[240px_minmax(0,1fr)_280px_340px]'
            : 'grid min-h-0 grid-cols-[260px_minmax(0,1fr)_300px]'
        }
      >
        <aside className="min-h-0 border-r border-border bg-surface">
          <AssetBin />
        </aside>
        <main className="min-h-0">
          <Preview />
        </main>
        <aside className="flex min-h-0 flex-col border-l border-border bg-surface">
          <Tabs defaultValue="properties" className="flex min-h-0 flex-1 flex-col">
            <TabsList>
              <TabsTrigger value="properties">Properties</TabsTrigger>
              <TabsTrigger value="captions">Captions</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
            </TabsList>
            <TabsContent value="properties" className="min-h-0 flex-1 overflow-y-auto">
              <Properties />
            </TabsContent>
            <TabsContent value="captions" className="min-h-0 flex-1">
              <CaptionsPanel />
            </TabsContent>
            <TabsContent value="activity" className="flex min-h-0 flex-1 flex-col">
              <ActivityFeed />
            </TabsContent>
          </Tabs>
        </aside>
        {chatOpen && (
          <aside className="min-h-0 border-l border-border bg-surface">
            <ChatPanel projectId={projectId} onClose={toggleChat} />
          </aside>
        )}
      </div>
      <div className="min-h-0 min-w-0 border-t border-border">
        <Timeline />
      </div>
      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />
      <ConnectDialog open={connectOpen} onOpenChange={setConnectOpen} />
      <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} />
      <BrandKitDialog open={brandOpen} onOpenChange={setBrandOpen} />
    </div>
  );
}
