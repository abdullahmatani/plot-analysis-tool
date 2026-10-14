import { allCommands, effectiveShortcut, formatShortcut } from '@/app/commands';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useProjectStore } from '@/store/project';
import { useViewStore } from '@/store/view';

import { useCommandsVersion } from './AppMenubar';

/** Tool rail (row 3): one button per tool command, grouped; active tool highlighted. */
export function ToolRail() {
  useCommandsVersion();
  useViewStore((s) => s.activeTool);
  const readOnly = useProjectStore((s) => s.readOnly);
  const tools = allCommands().filter((c) => c.rail);
  const groups: string[] = [];
  for (const t of tools) if (!groups.includes(t.menu)) groups.push(t.menu);

  return (
    <nav
      aria-label="Tools"
      className="flex w-11 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r py-1.5"
      data-testid="tool-rail"
    >
      {groups.map((g, gi) => (
        <div key={g} className="flex flex-col items-center gap-0.5">
          {gi > 0 && <Separator className="my-1 w-6" />}
          {tools
            .filter((t) => t.menu === g)
            .map((t) => {
              const Icon = t.icon;
              const active = t.active?.() ?? false;
              const disabled =
                (t.enabled ? !t.enabled() : false) ||
                (readOnly && t.menu !== 'View' && t.id !== 'tool.select' && t.id !== 'tool.pan');
              const sc = formatShortcut(effectiveShortcut(t));
              return (
                <Tooltip key={t.id}>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t.title}
                      aria-pressed={active}
                      disabled={disabled}
                      className={cn(active && 'bg-accent text-accent-foreground ring-ring/40 ring-1')}
                      onClick={() => void t.run()}
                      data-tool={t.id}
                    >
                      {Icon ? <Icon /> : t.title.slice(0, 2)}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    {t.title}
                    {sc && <span className="ml-2 opacity-70">{sc}</span>}
                  </TooltipContent>
                </Tooltip>
              );
            })}
        </div>
      ))}
    </nav>
  );
}
