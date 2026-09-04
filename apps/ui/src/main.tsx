import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { Root } from './Root.js';

const root = document.getElementById('root');
if (!root) throw new Error('no #root element');

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
