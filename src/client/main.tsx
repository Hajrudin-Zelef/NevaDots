import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './fonts.css';
import './style.css';
import './editor.css';
import './tokens.css';
import './refonte.css';
import './refonte-ocean.css';
import './motion.css';
import './responsive.css';
import { initRipple } from './ripple';
import { watchSystemTheme } from './theme';
import { initAvatarQuality } from './avatar-quality';
import { applyMotionPreference } from './motion-pref';
watchSystemTheme();
applyMotionPreference();
initRipple();
initAvatarQuality();
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
