/**
 * Named layout catalog — export/import LayoutDocument JSON (MMT Layout Hub pattern).
 */
import type { LayoutCatalogEntry, LayoutDocument, WorkspaceProfile } from './types';
import { LAYOUT_DOC_VERSION, newAnchorId, parseLayoutDocument } from './layoutDocument';

const CATALOG_KEY = 'mmt-layout-catalog-v1';

function readCatalog(): LayoutCatalogEntry[] {
  try {
    const raw = localStorage.getItem(CATALOG_KEY);
    if (!raw) return [];
    const j = JSON.parse(raw) as LayoutCatalogEntry[];
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

function writeCatalog(entries: LayoutCatalogEntry[]): void {
  try {
    localStorage.setItem(CATALOG_KEY, JSON.stringify(entries));
  } catch {
    /* quota */
  }
}

export function listLayoutCatalog(): LayoutCatalogEntry[] {
  return readCatalog().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function saveLayoutToCatalog(doc: LayoutDocument, name?: string): LayoutCatalogEntry {
  const entries = readCatalog();
  const id = newAnchorId();
  const entry: LayoutCatalogEntry = {
    id,
    name: name ?? doc.meta.name,
    profile: doc.meta.profile,
    slot: doc.meta.slot,
    updatedAt: Date.now(),
    document: { ...doc, meta: { ...doc.meta, name: name ?? doc.meta.name } },
  };
  entries.push(entry);
  writeCatalog(entries);
  return entry;
}

export function deleteCatalogEntry(id: string): void {
  writeCatalog(readCatalog().filter((e) => e.id !== id));
}

export function renameCatalogEntry(id: string, name: string): void {
  const entries = readCatalog();
  const idx = entries.findIndex((e) => e.id === id);
  if (idx < 0) return;
  entries[idx] = {
    ...entries[idx],
    name,
    updatedAt: Date.now(),
    document: {
      ...entries[idx].document,
      meta: { ...entries[idx].document.meta, name },
    },
  };
  writeCatalog(entries);
}

export function exportLayoutDocument(doc: LayoutDocument): string {
  return JSON.stringify(doc, null, 2);
}

export function importLayoutDocument(json: string, profile: WorkspaceProfile): LayoutDocument | null {
  try {
    const parsed = JSON.parse(json) as unknown;
    const doc = parseLayoutDocument(parsed, profile);
    if (!doc || doc.version !== LAYOUT_DOC_VERSION) return null;
    return doc;
  } catch {
    return null;
  }
}

export async function copyLayoutToClipboard(doc: LayoutDocument): Promise<boolean> {
  const text = exportLayoutDocument(doc);
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export async function readLayoutFromClipboard(profile: WorkspaceProfile): Promise<LayoutDocument | null> {
  try {
    const text = await navigator.clipboard.readText();
    return importLayoutDocument(text, profile);
  } catch {
    return null;
  }
}

export function getCatalogEntry(id: string): LayoutCatalogEntry | undefined {
  return readCatalog().find((e) => e.id === id);
}
