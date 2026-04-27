import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  AppState, AuditProject, AuditRun, AuditType, AuditPeriod,
  ParsedFile, AIConfig, Screen,
} from '../types';
import { EMPTY_FILTERS } from '../types';
import { STORAGE_KEYS } from '../constants';
import { deleteRunData } from '../services/IndexedDBService';

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      // ── Persisted state ─────────────────────────────
      projects: [],
      runs: [],
      activeProjectId: null,
      activeRunId: null,
      aiConfig: {
        provider: 'gemini',
        apiKey: '',
        modelId: 'gemini-2.0-flash',
        powerAutomateUrl: '',
      },

      // ── Transient UI state (reset on load) ──────────
      currentScreen: 'projects' as Screen,
      isLoading: false,
      loadingMessage: '',

      // ── Project actions ─────────────────────────────
      createProject: (input: {
        name: string;
        type: AuditType;
        period: AuditPeriod;
        bankPattern?: string;
      }): string => {
        const id = generateId();
        const project: AuditProject = {
          id,
          name: input.name.trim() || 'Untitled Audit',
          type: input.type,
          period: input.period,
          bankPattern: input.type === 'SINGLE_BANK' ? (input.bankPattern ?? '').trim() : undefined,
          createdAt: new Date().toISOString(),
          runIds: [],
        };
        set((state) => ({
          projects: [project, ...state.projects],
          activeProjectId: id,
          activeRunId: null,
        }));
        return id;
      },

      updateProject: (id: string, updates: Partial<AuditProject>) => {
        set((state) => ({
          projects: state.projects.map((p) => (p.id === id ? { ...p, ...updates } : p)),
        }));
      },

      deleteProject: (id: string) => {
        const runIds = get().projects.find((p) => p.id === id)?.runIds ?? [];
        for (const runId of runIds) deleteRunData(runId);
        set((state) => ({
          projects: state.projects.filter((p) => p.id !== id),
          runs: state.runs.filter((r) => !runIds.includes(r.id)),
          activeProjectId: state.activeProjectId === id ? null : state.activeProjectId,
          activeRunId: runIds.includes(state.activeRunId ?? '') ? null : state.activeRunId,
          currentScreen:
            state.activeProjectId === id ? 'projects' : state.currentScreen,
        }));
      },

      setActiveProject: (id: string | null) => {
        set({ activeProjectId: id, activeRunId: null });
      },

      // ── Run actions ─────────────────────────────────
      createRun: (input: { projectId: string; periodLabel: string; file: ParsedFile }): string => {
        const id = generateId();
        const project = get().projects.find((p) => p.id === input.projectId);
        const runIndex = (project?.runIds.length ?? 0) + 1;
        const run: AuditRun = {
          id,
          projectId: input.projectId,
          runIndex,
          periodLabel: input.periodLabel.trim() || `Run ${runIndex}`,
          name: input.file.fileName.replace(/\.(xlsx?|csv)$/i, ''),
          fileName: input.file.fileName,
          fileSize: input.file.fileSize,
          uploadedAt: new Date().toISOString(),
          lastAnalysedAt: null,
          columnMap: {},
          validationReport: null,
          dataProfile: null,
          ruleChecks: null,
          aiFlags: [],
          aiFlagSummary: null,
          stage: 'uploaded',
          hasDataInDB: false,
          analysisFilters: EMPTY_FILTERS,
          chartCache: null,
        };
        set((state) => ({
          runs: [run, ...state.runs],
          projects: state.projects.map((p) =>
            p.id === input.projectId ? { ...p, runIds: [...p.runIds, id] } : p
          ),
          activeRunId: id,
        }));
        return id;
      },

      updateRun: (id: string, updates: Partial<AuditRun>) => {
        set((state) => ({
          runs: state.runs.map((r) => (r.id === id ? { ...r, ...updates } : r)),
        }));
      },

      deleteRun: (id: string) => {
        deleteRunData(id);
        set((state) => {
          const run = state.runs.find((r) => r.id === id);
          return {
            runs: state.runs.filter((r) => r.id !== id),
            projects: state.projects.map((p) =>
              p.id === run?.projectId
                ? { ...p, runIds: p.runIds.filter((rid) => rid !== id) }
                : p
            ),
            activeRunId: state.activeRunId === id ? null : state.activeRunId,
          };
        });
      },

      setActiveRun: (id: string | null) => {
        set({ activeRunId: id });
      },

      // ── UI actions ──────────────────────────────────
      setScreen: (screen: Screen) => {
        set({ currentScreen: screen });
      },

      setLoading: (loading: boolean, message = '') => {
        set({ isLoading: loading, loadingMessage: message });
      },

      updateAIConfig: (config: Partial<AIConfig>) => {
        set((state) => ({ aiConfig: { ...state.aiConfig, ...config } }));
      },
    }),
    {
      name: STORAGE_KEYS.STORE,
      partialize: (state) => ({
        projects: state.projects,
        runs: state.runs,
        activeProjectId: state.activeProjectId,
        activeRunId: state.activeRunId,
        aiConfig: state.aiConfig,
      }),
    }
  )
);

// ─────────────────────────────────────────────
// Convenience selectors
// ─────────────────────────────────────────────

export function useActiveProject(): AuditProject | null {
  const projects = useStore((s) => s.projects);
  const activeProjectId = useStore((s) => s.activeProjectId);
  return projects.find((p) => p.id === activeProjectId) ?? null;
}

export function useActiveRun(): AuditRun | null {
  const runs = useStore((s) => s.runs);
  const activeRunId = useStore((s) => s.activeRunId);
  return runs.find((r) => r.id === activeRunId) ?? null;
}

export function useRunsForProject(projectId: string | null): AuditRun[] {
  const runs = useStore((s) => s.runs);
  if (!projectId) return [];
  return runs
    .filter((r) => r.projectId === projectId)
    .sort((a, b) => a.runIndex - b.runIndex);
}

/** Returns true if the legacy v1 localStorage blob has any sessions in it. */
export function hasArchivedV1Data(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.LEGACY_STORE);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.state?.sessions) && parsed.state.sessions.length > 0;
  } catch {
    return false;
  }
}
