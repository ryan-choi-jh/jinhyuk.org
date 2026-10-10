/** src/cms/app/canvas/harness/main.tsx — WS-4 harness entry point. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';

const mount = document.getElementById('root');
if (mount === null) throw new Error('no #root');
createRoot(mount).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
