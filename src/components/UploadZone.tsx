import React, { useCallback, useRef, useState } from 'react';
import Icon from './Icon';
import { useStore } from '../store/useStore';
import { parseFile } from '../services/FileParser';
import { detectColumns } from '../services/SchemaDetector';
import { validateStructure } from '../services/ValidationService';
import { ParsedDataCache } from '../services/ParsedDataCache';
import type { ValidationReport } from '../types';

type UploadStage = 'idle' | 'parsing' | 'detecting' | 'validating' | 'done' | 'error';

export default function UploadZone() {
  const { createSession, updateSession, setScreen, setActiveSession } = useStore();

  const [stage, setStage] = useState<UploadStage>('idle');
  const [dragOver, setDragOver] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [validationReport, setValidationReport] = useState<ValidationReport | null>(null);
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);

  // ── Process file ──────────────────────────────────────────────────────────

  const processFile = useCallback(async (file: File) => {
    setStage('parsing');
    setErrorMsg('');
    setValidationReport(null);

    try {
      // 1. Parse
      const parsed = await parseFile(file);
      setStage('detecting');

      // 2. Detect schema
      const detection = detectColumns(parsed.headers);
      setStage('validating');

      // 3. Validate structure
      const report = validateStructure(parsed, detection.columnMap);
      setValidationReport(report);

      // 4. Create session in store
      const sessionId = createSession(parsed);
      setPendingSessionId(sessionId);

      // 5. Persist column map + validation into session
      updateSession(sessionId, {
        columnMap: detection.columnMap,
        validationReport: report,
        stage: 'uploaded',
      });

      // 6. Cache raw rows for DuckDB loading in SchemaMapper
      ParsedDataCache.set(sessionId, parsed.headers, parsed.rows);

      setStage('done');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'An unexpected error occurred.');
      setStage('error');
    }
  }, [createSession, updateSession]);

  // ── Drag handlers ─────────────────────────────────────────────────────────

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }, [processFile]);

  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); setDragOver(true); };
  const onDragLeave = () => setDragOver(false);
  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  // ── Proceed to schema mapper ──────────────────────────────────────────────

  const proceed = () => {
    if (!pendingSessionId) return;
    setActiveSession(pendingSessionId);
    setScreen('schema-mapper');
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-2xl mx-auto px-6 py-12">

      <div className="mb-8">
        <h1 className="text-3xl font-bold text-slate-900">Upload SAP Records</h1>
        <p className="text-sm text-slate-500 mt-1">
          Accepts denormalized SAP Records exports — Excel (.xlsx, .xls) or CSV.
        </p>
      </div>

      {/* ── Drop zone ── */}
      {(stage === 'idle' || stage === 'error') && (
        <div
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onClick={() => inputRef.current?.click()}
          className={`border-2 border-dashed rounded-xl p-16 flex flex-col items-center justify-center gap-4 cursor-pointer transition animate-enter ${
            dragOver
              ? 'border-brand-500 bg-brand-50'
              : 'border-slate-300 hover:border-brand-400 hover:bg-slate-50'
          }`}
        >
          <div className={`w-16 h-16 rounded-full flex items-center justify-center transition ${
            dragOver ? 'bg-brand-100' : 'bg-slate-100'
          }`}>
            <Icon name="upload" className={`w-8 h-8 ${dragOver ? 'text-brand-500' : 'text-slate-400'}`} />
          </div>
          <div className="text-center">
            <div className="font-bold text-slate-700">
              {dragOver ? 'Drop your file here' : 'Drag & drop your file here'}
            </div>
            <div className="text-sm text-slate-400 mt-1">or click to browse</div>
            <div className="text-xs text-slate-400 mt-2 font-mono">
              .xlsx · .xls · .csv
            </div>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={onFileInput}
            className="hidden"
          />
        </div>
      )}

      {/* ── Error message ── */}
      {stage === 'error' && errorMsg && (
        <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg flex gap-3 animate-enter">
          <Icon name="alertCircle" className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
          <div>
            <div className="font-bold text-red-700 text-sm">Parsing failed</div>
            <div className="text-red-600 text-sm mt-0.5">{errorMsg}</div>
          </div>
        </div>
      )}

      {/* ── Progress states ── */}
      {(stage === 'parsing' || stage === 'detecting' || stage === 'validating') && (
        <div className="flex flex-col items-center gap-6 py-12 animate-enter">
          <div className="flex gap-2">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="w-2.5 h-2.5 bg-brand-500 rounded-full animate-bounce"
                style={{ animationDelay: `${i * 150}ms` }}
              />
            ))}
          </div>
          <div className="text-center">
            <div className="font-semibold text-slate-700">
              {stage === 'parsing'    && 'Parsing file…'}
              {stage === 'detecting'  && 'Detecting column schema…'}
              {stage === 'validating' && 'Validating data structure…'}
            </div>
            <div className="text-xs text-slate-400 mt-1">
              This runs entirely in your browser — no data is uploaded anywhere.
            </div>
          </div>
        </div>
      )}

      {/* ── Done state: show validation summary ── */}
      {stage === 'done' && validationReport && (
        <div className="animate-enter space-y-4">

          {/* Errors */}
          {validationReport.errors.length > 0 && (
            <IssueSection
              title="Blocking Issues"
              icon="xCircle"
              iconColor="text-red-500"
              bg="bg-red-50 border-red-200"
              items={validationReport.errors.map((e) => e.message)}
            />
          )}

          {/* Warnings */}
          {validationReport.warnings.length > 0 && (
            <IssueSection
              title="Warnings"
              icon="alertTriangle"
              iconColor="text-amber-500"
              bg="bg-amber-50 border-amber-200"
              items={validationReport.warnings.map((w) => w.message)}
            />
          )}

          {/* Passed checks */}
          {validationReport.passed.length > 0 && (
            <IssueSection
              title="Passed"
              icon="checkCircle"
              iconColor="text-green-500"
              bg="bg-green-50 border-green-200"
              items={validationReport.passed}
            />
          )}

          {/* Info */}
          {validationReport.infos.length > 0 && (
            <IssueSection
              title="Info"
              icon="info"
              iconColor="text-blue-400"
              bg="bg-slate-50 border-slate-200"
              items={validationReport.infos.map((i) => i.message)}
            />
          )}

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <button
              onClick={() => {
                setStage('idle');
                setValidationReport(null);
                setPendingSessionId(null);
              }}
              className="bg-white border border-slate-200 text-slate-600 px-4 py-2 rounded font-bold flex items-center gap-2 hover:bg-slate-50 transition text-sm"
            >
              <Icon name="refresh" className="w-4 h-4" />
              Upload different file
            </button>

            {validationReport.canProceed && (
              <button
                onClick={proceed}
                className="bg-slate-900 text-white px-6 py-2 rounded font-bold flex items-center gap-2 hover:bg-slate-800 transition text-sm"
              >
                Review Column Mapping
                <Icon name="chevronRight" className="w-4 h-4" />
              </button>
            )}
          </div>

          {!validationReport.canProceed && (
            <p className="text-xs text-red-600">
              Resolve the blocking issues above before proceeding. You may need to check the file
              format or manually map columns on the next screen.
            </p>
          )}
        </div>
      )}

      {/* ── Privacy notice ── */}
      <div className="mt-8 p-3 bg-slate-50 border border-slate-200 rounded-lg flex gap-2 text-xs text-slate-500">
        <Icon name="shield" className="w-4 h-4 shrink-0 text-slate-400" />
        Your file never leaves your browser. All parsing and analysis runs locally using DuckDB WASM.
      </div>
    </div>
  );
}

// ─── Issue section ─────────────────────────────────────────────────────────

function IssueSection({
  title, icon, iconColor, bg, items,
}: {
  title: string;
  icon: 'xCircle' | 'alertTriangle' | 'checkCircle' | 'info';
  iconColor: string;
  bg: string;
  items: string[];
}) {
  return (
    <div className={`border rounded-lg p-4 ${bg}`}>
      <div className={`flex items-center gap-2 font-bold text-sm mb-2 ${iconColor}`}>
        <Icon name={icon} className={`w-4 h-4 ${iconColor}`} />
        {title} ({items.length})
      </div>
      <ul className="space-y-1">
        {items.map((item, i) => (
          <li key={i} className="text-sm text-slate-700 flex gap-2">
            <span className="text-slate-400">·</span>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
