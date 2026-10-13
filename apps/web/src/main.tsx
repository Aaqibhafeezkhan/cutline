import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { TooltipProvider } from '@/components/ui/misc';
import { usePath } from '@/lib/router';
import { ProjectsPage } from '@/pages/ProjectsPage';
import './index.css';

// The editor pulls in the rendering engine (PixiJS, Mediabunny); load it on demand.
const Editor = lazy(() => import('@/editor/Editor').then((m) => ({ default: m.Editor })));

function App() {
  const path = usePath();
  const match = /^\/p\/([^/]+)/.exec(path);
  return (
    <TooltipProvider>
      {match ? (
        <Suspense fallback={null}>
          <Editor key={match[1]} projectId={decodeURIComponent(match[1]!)} />
        </Suspense>
      ) : (
        <ProjectsPage />
      )}
      <Toaster theme="dark" position="bottom-right" richColors closeButton />
    </TooltipProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
