import { Toaster as Sonner, type ToasterProps } from 'sonner';

import { useUiStore } from '@/store/ui';

function Toaster(props: ToasterProps) {
  const theme = useUiStore((s) => s.resolvedTheme);
  return (
    <Sonner
      theme={theme}
      className="toaster group"
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
        } as React.CSSProperties
      }
      {...props}
    />
  );
}

export { Toaster };
