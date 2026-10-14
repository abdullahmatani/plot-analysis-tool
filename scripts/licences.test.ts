import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// @ts-expect-error — plain ESM script without type declarations
import { generate } from './gen-licences.mjs';

/**
 * Row 25: the licence list is generated at build time and matches the dependency tree. The tree is
 * recomputed here independently by walking the lockfile from the app's production dependencies.
 */

interface LockPkg {
  version?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  dev?: boolean;
  devOptional?: boolean;
  optional?: boolean;
}

const root = path.resolve(__dirname, '..');
const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as {
  packages: Record<string, LockPkg>;
};

/** Node-style resolution of `name` from the package at `from` inside the lockfile. */
function resolve(from: string, name: string): string | null {
  let dir = from;
  for (;;) {
    const key = `${dir ? `${dir}/` : ''}node_modules/${name}`;
    if (lock.packages[key]) return key;
    if (!dir) return null;
    const i = dir.lastIndexOf('/node_modules/');
    dir = i >= 0 ? dir.slice(0, i) : '';
  }
}

function productionTree(): Set<string> {
  const seen = new Set<string>();
  const stack = Object.keys(lock.packages[''].dependencies ?? {}).map((n) => resolve('', n));
  while (stack.length) {
    const key = stack.pop();
    if (!key || seen.has(key)) continue;
    const pkg = lock.packages[key];
    // Optional native binaries and optional peers (devOptional: types, schema validators of
    // libraries we don't use) are never bundled for the browser.
    if (pkg.optional || pkg.devOptional) continue;
    seen.add(key);
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies })) {
      const r = resolve(key, dep);
      if (r && !lock.packages[r].dev) stack.push(r);
    }
  }
  return seen;
}

describe('third-party licence list (row 25)', () => {
  const generated = generate() as {
    packages: { name: string; version: string; license: string; scope?: string }[];
  };

  it('lists exactly the production dependency tree', () => {
    const tree = [...productionTree()].map(
      (k) => `${k.replace(/^.*node_modules\//, '')}@${lock.packages[k].version}`,
    );
    const listed = generated.packages.filter(
      (p) =>
        !/\(font\)|pdf\.js|^pdf\.js/.test(p.name) && !p.version.includes('pdfjs-dist') && p.version !== '2.x',
    );
    const names = listed.map((p) => `${p.name}@${p.version}`);
    const missing = tree.filter((t) => !names.includes(t));
    const extra = names.filter((n) => !tree.includes(n));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it('has a known licence for every component, and GPL only in the isolated DWG worker', () => {
    for (const p of generated.packages) {
      expect(p.license, p.name).not.toBe('UNKNOWN');
      if (/GPL/i.test(p.license) && !/LGPL/i.test(p.license))
        expect(p.scope, p.name).toMatch(/DWG import worker only/);
    }
  });
});
