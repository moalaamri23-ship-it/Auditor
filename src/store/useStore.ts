import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AppState, Session, ParsedFile, AIConfig, Screen } from '../types';
import { EMPTY_FILTERS } from '../types';

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
}

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      // ── Persisted state ─────────────────────────────
      sessions: [],
      activeSessionId: null,
      aiConfig: {
        provider: 'gemini',
        apiKey: '',
        modelId: 'gemini-2.0-flash',
        powerAutomateUrl: '',
      },

      // ── Transient UI state (reset on load) ──────────
      currentScreen: 'dashboard' as Screen,
      isLoading: false,
      loadingMessage: '',

      // ── Actions ──────────────────────────────────────
      createSession: (file: ParsedFile): string => {
        const id = generateId();
        const session: Session = {
          id,
          name: file.fileName.replace(/\.(xlsx?|csv)$/i, ''),
          fileName: file.fileName,
          fileSize: file.fileSize,
          uploadedAt: new Date().toISOString(),
          lastAnalysedAt: null,
          columnMap: {},
          validationReport: null,
          dataProfile: null,
          analysisResults: null,
          aiInsights: null,
          aiFlags: [],
          aiFlagSummary: null,
          maturityScore: null,
          stage: 'uploaded',
          hasDataInDuckDB: false,
          analysisFilters: EMPTY_FILTERS,
        };
        set((state) => ({
          sessions: [session, ...state.sessions],
          activeSessionId: id,
        }));
        return id;
      },

      updateSession: (id: string, updates: Partial<Session>) => {
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === id ? { ...s, ...updates } : s
          ),
        }));
      },

      deleteSession: (id: string) => {
        set((state) => ({
          sessions: state.sessions.filter((s) => s.id !== id),
          activeSessionId:
            state.activeSessionId === id ? null : state.activeSessionId,
          currentScreen:
            state.activeSessionId === id ? 'dashboard' : state.currentScreen,
        }));
      },

      setActiveSession: (id: string | null) => {
        set({ activeSessionId: id });
      },

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
      name: 'sap-auditor-v1',
      // Only persist these keys — not transient UI state
      partialize: (state) => ({
        sessions: state.sessions,
        activeSessionId: state.activeSessionId,
        aiConfig: state.aiConfig,
      }),
    }
  )
);

/** Convenience hook: returns the currently active session or null */
export const useActiveSession = () => {
  const sessions = useStore((s) => s.sessions);
  const activeSessionId = useStore((s) => s.activeSessionId);
  const session = sessions.find((s) => s.id === activeSessionId) ?? null;
  // Migration guards for sessions persisted before new fields were added
  if (session && !session.analysisFilters) {
    (session as any).analysisFilters = EMPTY_FILTERS;
  }
  if (session && !session.aiFlags) {
    (session as any).aiFlags = [];
  }
  if (session && session.aiFlagSummary === undefined) {
    (session as any).aiFlagSummary = null;
  }
  return session;
};
