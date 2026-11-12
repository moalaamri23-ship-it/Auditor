import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { useStore } from './store/useStore';
import { listenForShellSettings } from './services/ShellSettings';

// Inside Reliability Shell, the flow URL entered there replaces this app's own.
// Applied after the persisted settings load, so hydration cannot overwrite it.
listenForShellSettings(({ aiRouterUrl }) => {
  if (!aiRouterUrl) return
  const apply = () => useStore.getState().updateAIConfig({ aiRouterUrl })
  if (useStore.persist.hasHydrated()) apply()
  else useStore.persist.onFinishHydration(apply)
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
