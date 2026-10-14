import { ListOrdered } from 'lucide-react';

import type { AnalysisObject } from '@/core/types';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { CommitInput, Field, NumberInput } from '@/components/inspector/fields';
import { commit, useProject } from '@/store/project';

import { renumberTags } from './tags';

/** Properties of text, callouts and tags (row 41): text content, tag number and layer prefix. */
export function AnnotationSection({ o, readOnly }: { o: AnalysisObject; readOnly: boolean }) {
  const layer = useProject((p) => p.layers.find((l) => l.id === o.layerId));
  if (o.kind !== 'text' && o.kind !== 'callout' && o.kind !== 'tag') return null;
  const set = (label: string, fn: (x: AnalysisObject) => void) =>
    commit(label, (d) => {
      const x = d.objects.find((y) => y.id === o.id);
      if (x) fn(x as AnalysisObject);
    });
  return (
    <section className="space-y-1.5" data-testid="annotation-editor">
      {o.kind !== 'tag' ? (
        <Field label="Text">
          <Textarea
            aria-label="Annotation text"
            dir="auto"
            rows={3}
            className="min-h-14 text-xs"
            disabled={readOnly}
            defaultValue={o.text ?? ''}
            key={o.id + (o.text ?? '')}
            onBlur={(e) => {
              const v = e.target.value;
              if (v.trim() && v !== o.text) set('Edit text', (x) => void (x.text = v));
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.target as HTMLTextAreaElement).blur();
            }}
          />
        </Field>
      ) : (
        <>
          <Field label="Number">
            <NumberInput
              ariaLabel="Tag number"
              decimals={0}
              min={0}
              disabled={readOnly}
              value={o.tagNumber ?? 0}
              onCommit={(n) =>
                set('Change tag number', (x) => {
                  if (x.name === `Tag ${x.tagNumber}`) x.name = `Tag ${Math.round(n)}`;
                  x.tagNumber = Math.round(n);
                })
              }
            />
          </Field>
          <Field label="Layer prefix">
            <CommitInput
              ariaLabel="Tag prefix"
              disabled={readOnly}
              placeholder="e.g. T-"
              value={layer?.tagPrefix ?? ''}
              onCommit={(v) =>
                commit('Change tag prefix', (d) => {
                  const l = d.layers.find((x) => x.id === o.layerId);
                  if (l) l.tagPrefix = v || undefined;
                })
              }
            />
          </Field>
          <Button size="xs" variant="outline" disabled={readOnly} onClick={() => renumberTags(o.layerId)}>
            <ListOrdered /> Renumber tags on this layer
          </Button>
        </>
      )}
    </section>
  );
}
