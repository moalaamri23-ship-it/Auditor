import React, { useState } from 'react';
import Icon from './Icon';
import { useStore } from '../store/useStore';
import type { AuditPeriod, AuditType } from '../types';

const PERIODS: Array<{ id: AuditPeriod; label: string }> = [
  { id: 'WEEKLY', label: 'Weekly' },
  { id: 'BIWEEKLY', label: 'Bi-weekly' },
  { id: 'QUARTERLY', label: 'Quarterly' },
  { id: 'YEARLY', label: 'Yearly' },
];

export default function AuditInitWizard() {
  const { createProject, setScreen } = useStore();

  const [name, setName] = useState('');
  const [type, setType] = useState<AuditType>('TOTAL');
  const [period, setPeriod] = useState<AuditPeriod>('QUARTERLY');
  const [bankPattern, setBankPattern] = useState('');
  const [error, setError] = useState('');

  const submit = () => {
    if (!name.trim()) {
      setError('Audit name is required.');
      return;
    }
    if (type === 'SINGLE_BANK' && !bankPattern.trim()) {
      setError('Bank pattern is required for Single Bank audits.');
      return;
    }
    const pattern = bankPattern.trim().includes('*')
      ? bankPattern.trim()
      : bankPattern.trim()
        ? `${bankPattern.trim().replace(/%+$/, '')}%`
        : undefined;
    createProject({ name: name.trim(), type, period, bankPattern: pattern });
    setScreen('upload');
  };

  return (
    <div className="max-w-2xl mx-auto px-6 py-12 animate-enter">
      <div className="mb-8">
        <button
          onClick={() => setScreen('projects')}
          className="text-xs font-bold text-slate-400 hover:text-slate-700 inline-flex items-center gap-1 mb-3"
        >
          <Icon name="arrowLeft" className="w-3.5 h-3.5" />
          Back to Projects
        </button>
        <h1 className="text-3xl font-bold text-slate-900">New Audit Project</h1>
        <p className="text-sm text-slate-500 mt-1">
          Set the audit metadata. After this, every dataset you upload becomes a run inside this
          project so you can track improvement across periods.
        </p>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm space-y-6">
        <Field label="Audit Name" required>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Plant 53 Reliability Coding Q2"
            className="w-full border border-slate-200 rounded px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
          />
        </Field>

        <Field label="Audit Type" required>
          <div className="grid grid-cols-2 gap-3">
            <RadioCard
              active={type === 'TOTAL'}
              title="Total Audit"
              description="Audit every Functional Location in the dataset."
              onClick={() => setType('TOTAL')}
            />
            <RadioCard
              active={type === 'SINGLE_BANK'}
              title="Single Bank Audit"
              description="Restrict the audit to one bank — Functional Locations that share the same prefix."
              onClick={() => setType('SINGLE_BANK')}
            />
          </div>
        </Field>

        <Field label="Audit Period" required>
          <div className="grid grid-cols-4 gap-2">
            {PERIODS.map((p) => (
              <button
                key={p.id}
                onClick={() => setPeriod(p.id)}
                className={`px-3 py-2 rounded text-sm font-bold border transition ${
                  period === p.id
                    ? 'bg-brand-500 border-brand-500 text-white'
                    : 'bg-white border-slate-200 text-slate-600 hover:border-brand-300'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </Field>

        {type === 'SINGLE_BANK' && (
          <Field
            label="Bank Pattern"
            required
            help="A Functional Location pattern. Use * (or %) as a wildcard for the parts that vary across the bank. Example: OS-BK053-LOT03-PWT-*"
          >
            <input
              type="text"
              value={bankPattern}
              onChange={(e) => setBankPattern(e.target.value)}
              placeholder="OS-BK053-LOT03-PWT-*"
              className="w-full border border-slate-200 rounded px-3 py-2 text-sm font-mono focus:border-brand-500 focus:outline-none"
            />
          </Field>
        )}

        {error && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2 border-t border-slate-100">
          <button
            onClick={() => setScreen('projects')}
            className="px-4 py-2 text-sm border border-slate-200 rounded-lg hover:bg-slate-50 transition"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            className="px-6 py-2 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition flex items-center gap-2 font-bold"
          >
            Create & Upload Data
            <Icon name="chevronRight" className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  help,
  children,
}: {
  label: string;
  required?: boolean;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-bold uppercase text-slate-500 mb-1.5">
        {label}{required && <span className="text-red-500 ml-1">*</span>}
      </label>
      {children}
      {help && <p className="text-xs text-slate-400 mt-1.5">{help}</p>}
    </div>
  );
}

function RadioCard({
  active,
  title,
  description,
  onClick,
}: {
  active: boolean;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`text-left p-4 rounded-lg border-2 transition ${
        active
          ? 'border-brand-500 bg-brand-50'
          : 'border-slate-200 bg-white hover:border-brand-300'
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        <div className={`w-3 h-3 rounded-full ${active ? 'bg-brand-500' : 'border-2 border-slate-300'}`} />
        <div className="font-bold text-sm text-slate-700">{title}</div>
      </div>
      <p className="text-xs text-slate-500 leading-relaxed">{description}</p>
    </button>
  );
}
