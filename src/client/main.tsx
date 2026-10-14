import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './fonts.css';
import './style.css';
import './editor.css';
import './tokens.css';
import './refonte.css';
import './refonte-ocean.css';
import './responsive.css';
import { initRipple } from './ripple';
import { watchSystemTheme } from './theme';
watchSystemTheme();
initRipple();
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
