import { useEffect, useRef } from 'react';
import type { AuditRun } from '../types';
import { useStore } from '../store/useStore';
import { hasRunData, loadRunData } from '../services/IndexedDBService';
import { loadData, createAnalysisScopeView, restoreAIFlagsFromRun } from '../services/DuckDBService';
import { ensureCatalogLoaded } from '../services/FailureCatalogService';

/**
 * Automatically reloads DuckDB from IndexedDB on cold start (page refresh).
 * Call this hook in any screen that needs hasDataInDB=true to function.
 */
export function useRunAutoRestore(run: AuditRun | null) {
  const updateRun = useStore((s) => s.updateRun);
  const projects = useStore((s) => s.projects);
  const restoringRef = useRef(false);

  useEffect(() => {
    if (!run || run.hasDataInDB || !run.columnMap || restoringRef.current) return;

    restoringRef.current = true;
    const project = projects.find((p) => p.id === run.projectId) ?? null;

    (async () => {
      try {
        const has = await hasRunData(run.id);
        if (!has) return;

        const data = await loadRunData(run.id);
        if (!data) return;

        await loadData(data.rows, data.columnMap);
        await ensureCatalogLoaded().catch(() => {});

        if (run.aiFlags?.length > 0) {
          await restoreAIFlagsFromRun(run.aiFlags).catch(() => {});
        }

        if (run.analysisFilters && Object.keys(data.columnMap).length > 0) {
          await createAnalysisScopeView(run.analysisFilters, data.columnMap, project).catch(() => {});
        }

        updateRun(run.id, { hasDataInDB: true });
      } catch (err) {
        console.warn('Auto-restore from IndexedDB failed', err);
      } finally {
        restoringRef.current = false;
      }
    })();
  }, [run?.id, run?.hasDataInDB]);
}
