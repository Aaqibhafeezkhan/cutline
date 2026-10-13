import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/misc';

function Snippet({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md border border-border bg-background p-3 pr-10 font-mono text-xs leading-relaxed">
        {code}
      </pre>
      <button
        type="button"
        aria-label="Copy to clipboard"
        className="absolute right-2 top-2 rounded p-1 text-muted hover:bg-surface-2 hover:text-foreground"
        onClick={() => {
          void navigator.clipboard.writeText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </button>
    </div>
  );
}

export function ConnectDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  // In development the editor runs on Vite (:5173) and the server on :4100; in production they share an origin.
  const mcpUrl =
    location.port === '5173'
      ? `${location.protocol}//${location.hostname}:4100/mcp`
      : `${location.origin}/mcp`;
  const desktop = JSON.stringify(
    {
      mcpServers: {
        cutline: {
          command: 'node',
          args: ['/ABSOLUTE/PATH/TO/cutline/packages/mcp-server/dist/cli.js', '--stdio'],
        },
      },
    },
    null,
    2,
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Connect an AI agent"
        description="Cutline speaks the Model Context Protocol. Changes the agent makes show up here live and are highlighted."
        className="w-[min(92vw,640px)]"
      >
        <Tabs defaultValue="code">
          <TabsList>
            <TabsTrigger value="code">Claude Code</TabsTrigger>
            <TabsTrigger value="desktop">Claude Desktop</TabsTrigger>
            <TabsTrigger value="other">Other clients</TabsTrigger>
          </TabsList>
          <TabsContent value="code" className="space-y-3 pt-3 text-sm">
            <p>Add the server once (HTTP transport):</p>
            <Snippet code={`claude mcp add --transport http cutline ${mcpUrl}`} />
            <p className="text-muted">Then ask, for example:</p>
            <Snippet
              code={
                'Import ~/Videos/talk.mp4 into Cutline, remove the silences, add captions and export an MP4.'
              }
            />
          </TabsContent>
          <TabsContent value="desktop" className="space-y-3 pt-3 text-sm">
            <p>
              Build once with <code>pnpm build</code>, then add this to{' '}
              <code>claude_desktop_config.json</code> (Settings → Developer → Edit Config). The
              stdio process connects to this running server, so you see the edits here.
            </p>
            <Snippet code={desktop} />
          </TabsContent>
          <TabsContent value="other" className="space-y-3 pt-3 text-sm">
            <p>Any MCP client that supports Streamable HTTP can connect to:</p>
            <Snippet code={mcpUrl} />
            <p className="text-muted">
              If the server runs with <code>CUTLINE_TOKEN</code>, send{' '}
              <code>Authorization: Bearer &lt;token&gt;</code>.
            </p>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
