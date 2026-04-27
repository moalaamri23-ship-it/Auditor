import type { ColumnMap } from '../types';

const DB_NAME = 'sap-auditor-data';
const DB_VERSION = 1;
const STORE_NAME = 'run-rows';

interface RunData {
  runId: string;
  rows: Record<string, string>[];
  columnMap: ColumnMap;
  savedAt: string;
}

let _dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: 'runId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      _dbPromise = null;
      reject(req.error);
    };
  });
  return _dbPromise;
}

export async function saveRunData(
  runId: string,
  rows: Record<string, string>[],
  columnMap: ColumnMap,
): Promise<void> {
  const db = await openDB();
  const entry: RunData = { runId, rows, columnMap, savedAt: new Date().toISOString() };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(entry);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function loadRunData(runId: string): Promise<RunData | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(runId);
    req.onsuccess = () => resolve((req.result as RunData) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteRunData(runId: string): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).delete(runId);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Best-effort cleanup
  }
}

export async function hasRunData(runId: string): Promise<boolean> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getKey(runId);
      req.onsuccess = () => resolve(req.result !== undefined);
      req.onerror = () => resolve(false);
    });
  } catch {
    return false;
  }
}
