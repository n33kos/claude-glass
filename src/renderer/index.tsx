import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initStore } from './store';
import './styles.css';

// macOS fullscreen hides the traffic lights (see .fullscreen .topbar). From the window's own
// events: comparing sizes fails on notched displays, where fullscreen stops below the notch.
window.glass.onFullscreen((on) => document.documentElement.classList.toggle('fullscreen', on));

initStore().then(() => {
  createRoot(document.getElementById('root')!).render(<App />);
});
