import { useEffect } from 'react';

import { handleShortcut } from '@/app/commands';
import { registerCoreCommands } from '@/app/core-commands';
import { initApp } from '@/app/init';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useAppStore } from '@/store/app';
import { useProjectStore } from '@/store/project';
import { useUiStore } from '@/store/ui';

import { Dialogs } from './Dialogs';
import { ErrorBoundary } from './ErrorBoundary';
import { StartScreen } from './StartScreen';
import { Workspace } from './Workspace';

let initialised = false;

export function App() {
  const resolvedTheme = useUiStore((s) => s.resolvedTheme);
  const hasProject = useProjectStore((s) => !!s.history);
  const ready = useAppStore((s) => s.ready);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolvedTheme === 'dark');
  }, [resolvedTheme]);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const fn = () => useUiStore.getState().applySystemTheme();
    mq?.addEventListener('change', fn);
    return () => mq?.removeEventListener('change', fn);
  }, []);

  useEffect(() => {
    const unregister = registerCoreCommands();
    const onKey = (e: KeyboardEvent) => {
      handleShortcut(e);
    };
    window.addEventListener('keydown', onKey);
    if (!initialised) {
      initialised = true;
      void initApp();
    }
    return () => {
      unregister();
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col" data-ready={ready ? 'true' : 'false'}>
        <ErrorBoundary>{hasProject ? <Workspace /> : <StartScreen />}</ErrorBoundary>
      </div>
      <ErrorBoundary>
        <Dialogs />
      </ErrorBoundary>
      <Toaster position="bottom-right" richColors closeButton />
    </TooltipProvider>
  );
}
