import { MessageSquareText, Tag, Type } from 'lucide-react';

import { promptText } from '@/app/prompt';
import type { Pt } from '@/core/types';
import { addObjects } from '@/features/objects/ops';
import { createPickTool, type PickToolSpec } from '@/features/draw/pick-tool';

import { addTag } from './tags';

/** Free text, leader callout and bubble tag tools (row 41). */

async function askText(title: string, defaultValue = ''): Promise<string | null> {
  return promptText({
    title,
    label: 'Text',
    description: 'Any language, including Arabic. Ctrl+Enter to finish.',
    defaultValue,
    multiline: true,
  });
}

export const ANNOTATION_TOOLS: (PickToolSpec & { shortcut?: string })[] = [
  {
    id: 'annotate.text',
    title: 'Text',
    icon: Type,
    shortcut: 'T',
    creates: true,
    minPoints: 1,
    maxPoints: 1,
    prompt: () => 'Text: pick the insertion point (top-left of the text)',
    preview: () => null,
    finish: (pts: Pt[]) => {
      void askText('Add text').then((text) => {
        if (text)
          addObjects(
            [{ kind: 'text', geometry: { type: 'point', p: pts[0] }, text, style: { hatch: 'none' } }],
            'Add text',
          );
      });
    },
  },
  {
    id: 'annotate.callout',
    title: 'Leader callout',
    icon: MessageSquareText,
    shortcut: 'Shift+T',
    creates: true,
    minPoints: 2,
    maxPoints: 2,
    prompt: (n) =>
      n === 0 ? 'Callout: pick the point the arrow points to' : 'Callout: pick where the text goes',
    preview: (pts, c) => (pts.length && c ? { type: 'polyline', pts: [pts[0], c], closed: false } : null),
    finish: (pts: Pt[]) => {
      void askText('Callout text').then((text) => {
        if (text)
          addObjects(
            [{ kind: 'callout', geometry: { type: 'polyline', pts: [pts[0], pts[1]], closed: false }, text }],
            'Add callout',
          );
      });
    },
  },
  {
    id: 'annotate.tag',
    title: 'Numbered tag',
    icon: Tag,
    shortcut: 'B',
    creates: true,
    repeat: true,
    minPoints: 1,
    maxPoints: 2,
    prompt: (n) =>
      n === 0
        ? 'Tag: pick the tagged point (Enter after one pick for a tag without leader)'
        : 'Tag: pick the bubble position, or Enter',
    preview: (pts, c) => (pts.length && c ? { type: 'polyline', pts: [pts[0], c], closed: false } : null),
    finish: (pts: Pt[]) => {
      addTag(
        pts.length === 1
          ? { type: 'point', p: pts[0] }
          : { type: 'polyline', pts: [pts[0], pts[1]], closed: false },
      );
    },
  },
];

export const annotationTools = ANNOTATION_TOOLS.map((spec) => ({ spec, tool: createPickTool(spec) }));
