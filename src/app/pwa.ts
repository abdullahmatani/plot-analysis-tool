import { toast } from 'sonner';

/**
 * Service worker registration (row 6). The update check fails silently when offline; when a new
 * version has been cached the user is prompted to reload.
 */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  void import('virtual:pwa-register')
    .then(({ registerSW }) => {
      const update = registerSW({
        immediate: true,
        onNeedRefresh() {
          toast('A new version of Plot Analysis Tool is ready.', {
            description: 'Your work is saved. Reload to update.',
            duration: Infinity,
            action: { label: 'Reload', onClick: () => void update(true) },
          });
        },
        onOfflineReady() {
          toast.success('Ready to work offline.', {
            description: 'Every feature now works without a network connection.',
          });
        },
        onRegisterError() {
          /* silent: e.g. unsupported context */
        },
      });
    })
    .catch(() => {});
}
