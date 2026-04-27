import React, { useState, useEffect } from 'react';
import { useStore, useActiveRun } from '../store/useStore';
import { useRunAutoRestore } from '../hooks/useRunAutoRestore';
import { query } from '../services/DuckDBService';
import Icon from './Icon';

interface WCInfo {
  workCenter: string;
  description: string;
}

export default function ReportingSettingsScreen() {
  const { reportingEmails, setReportingEmail, currentScreen } = useStore();
  const run = useActiveRun();
  useRunAutoRestore(run);
  const [workCenters, setWorkCenters] = useState<WCInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchWCs() {
      try {
        const hasWC = !!run?.columnMap?.work_center;
        const wcCol = hasWC ? 'work_center' : "''";
        const descCol = run?.columnMap?.work_center_description ? 'work_center_description' : "''";

        const queryText = `
          SELECT ${wcCol} as work_center, MAX(${descCol}) as description
          FROM v_wo_primary
          WHERE ${hasWC ? "TRIM(CAST(work_center AS VARCHAR)) <> ''" : "1=0"}
          GROUP BY ${wcCol}
          ORDER BY ${wcCol}
        `;
        const res = await query(queryText);
        const wcs: WCInfo[] = res.map((r: any) => ({
          workCenter: r.work_center,
          description: r.description || '',
        }));
        setWorkCenters(wcs);
      } catch (e) {
        console.error('Failed to fetch work centers:', e);
      } finally {
        setLoading(false);
      }
    }
    if (currentScreen === 'reporting-settings') {
      fetchWCs();
    }
  }, [currentScreen, run?.columnMap]);

  return (
    <div className="max-w-4xl mx-auto p-10 animate-enter">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-slate-900">Reporting Settings</h1>
        <p className="text-sm text-slate-700 mt-2">
          Assign email addresses to each Work Center for bulk Audit Report distribution.
        </p>
      </div>

      <div className="bg-white border rounded shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-slate-50 text-slate-500 uppercase text-[10px] font-bold border-b tracking-wider">
              <tr>
                <th className="px-6 py-3">Work Center</th>
                <th className="px-6 py-3">Description</th>
                <th className="px-6 py-3">Email Address</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={3} className="px-6 py-10 text-center text-slate-400">
                    <Icon name="loader" className="w-5 h-5 animate-spin mx-auto mb-2" />
                    Loading work centers...
                  </td>
                </tr>
              ) : workCenters.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-6 py-10 text-center text-slate-400">
                    No work centers found. Ensure data is uploaded and mapped.
                  </td>
                </tr>
              ) : (
                workCenters.map((wc) => (
                  <tr key={wc.workCenter} className="hover:bg-slate-50 transition">
                    <td className="px-6 py-3 font-mono font-medium text-slate-700">
                      {wc.workCenter}
                    </td>
                    <td className="px-6 py-3 text-slate-600">
                      {wc.description || <span className="text-slate-300 italic">No description</span>}
                    </td>
                    <td className="px-6 py-3">
                      <input
                        type="email"
                        placeholder="owner@example.com"
                        value={reportingEmails[wc.workCenter] || ''}
                        onChange={(e) => setReportingEmail(wc.workCenter, e.target.value)}
                        className="w-full border border-slate-200 rounded px-3 py-1.5 text-sm outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition shadow-sm"
                      />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
