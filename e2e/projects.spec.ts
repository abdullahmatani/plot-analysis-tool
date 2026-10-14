import { readFileSync } from 'node:fs';

import { createProject, expect, openApp, test } from './fixtures';

/** Row 87: a project file saved by the 0.x builds opens (with its embedded drawing) in this build. */
test('opens a project file saved by an earlier build', async ({ page }) => {
  await openApp(page);
  await createProject(page, 'Scratch');
  // Dropping a project file opens it (File → Open uses the system picker, which tests cannot drive).
  const bytes = [...readFileSync('tests/fixtures/projects/schema1-0x-all-features.patproj')];
  await page.evaluate((data) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(data)], 'schema1-0x-all-features.patproj'));
    const target = document.querySelector('[data-testid="canvas-container"]')!;
    for (const type of ['dragenter', 'dragover', 'drop'])
      target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, bytes);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __pat: { project(): { name: string } | null } }).__pat.project()?.name,
      ),
    )
    .toBe('Fixture — all 0.x features');
  const summary = await page.evaluate(() => {
    const w = window as unknown as {
      __pat: {
        project(): { name: string; objects: unknown[]; datasets: unknown[]; drawings: unknown[] } | null;
        models(): { status: string }[];
      };
    };
    const p = w.__pat.project()!;
    return {
      name: p.name,
      objects: p.objects.length,
      datasets: p.datasets.length,
      drawings: p.drawings.length,
    };
  });
  expect(summary).toEqual({ name: 'Fixture — all 0.x features', objects: 6, datasets: 1, drawings: 1 });
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __pat: { models(): { status: string }[] } }).__pat.models()[0]?.status,
      ),
    )
    .toBe('ready');
});
