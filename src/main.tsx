// First: moves storage saved under the app's old name before any store reads it.
import './infra/storage/migrate-on-start.ts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppRouter } from './app/router.tsx';
import './styles/index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

createRoot(root).render(
  <StrictMode>
    <AppRouter />
  </StrictMode>,
);

// The private log: upload whatever earlier visits left queued, and follow the page's life (hide, close).
// Loaded after the first render; it only reads local logs and talks to the log service, never to the car.
void import('./infra/cloud/lifecycle.ts').then((m) => m.installCloudLifecycle()).catch(() => {});
