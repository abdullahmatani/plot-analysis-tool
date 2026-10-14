import { confirmAction, promptText } from '@/app/prompt';
import { newId } from '@/core/ids';
import type { ExportProfile } from '@/core/types';
import { commit, getProject } from '@/store/project';

import type { ExportSettings } from './settings';

/** Named export profiles (row 81): saving, updating and deleting are single undoable commits. */

export async function saveProfileAs(settings: ExportSettings): Promise<string | null> {
  const p = getProject();
  if (!p) return null;
  const name = await promptText({
    title: 'Save export profile',
    label: 'Profile name',
    defaultValue: `${settings.sheet.paper} ${settings.format.toUpperCase()}`,
  });
  if (!name?.trim()) return null;
  const profile: ExportProfile = { id: newId('exp'), name: name.trim(), ...structuredClone(settings) };
  const ok = commit(`Save export profile “${profile.name}”`, (d) => {
    d.exportProfiles.push(profile);
  });
  return ok ? profile.id : null;
}

export function updateProfile(id: string, settings: ExportSettings): boolean {
  return commit('Update export profile', (d) => {
    const i = d.exportProfiles.findIndex((x) => x.id === id);
    if (i >= 0) d.exportProfiles[i] = { id, name: d.exportProfiles[i].name, ...structuredClone(settings) };
  });
}

export async function deleteProfile(id: string): Promise<boolean> {
  const p = getProject()?.exportProfiles.find((x) => x.id === id);
  if (!p) return false;
  const ok = await confirmAction({
    title: `Delete export profile “${p.name}”?`,
    description: 'The profile is removed from this project. You can undo this.',
    confirmLabel: 'Delete',
    destructive: true,
  });
  if (!ok) return false;
  return commit(`Delete export profile “${p.name}”`, (d) => {
    d.exportProfiles = d.exportProfiles.filter((x) => x.id !== id);
  });
}

/** Loads a profile's sheet layout into the project (the dialog then shows the profile). */
export function applyProfileSheet(profile: ExportProfile): boolean {
  return commit(`Apply export profile “${profile.name}”`, (d) => {
    d.sheet = structuredClone(profile.sheet);
  });
}
