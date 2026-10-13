import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

function App() {
  return <main className="p-8 text-neutral-100">Cutline</main>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
