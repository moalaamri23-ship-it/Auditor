/**
 * AI Controller
 *
 * Builds a pre-aggregated payload from DuckDB analysis results and calls the
 * configured AI provider. Raw rows NEVER leave DuckDB — AI only sees counts,
 * rates, anomaly descriptions, and module scores.
 *
 * Anti-hallucination gates:
 *  - No API key → throws immediately
 *  - < 10 WOs in scope → returns insufficientData flag
 *  - Data quality score < 20 → returns insufficientData flag
 */

import { callAI } from './AIService';
import type { AnalysisResults } from '../analysis/analysisTypes';
import type { AIConfig, AIInsights, AIModuleInsight } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// System prompt
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior reliability engineer specializing in SAP PM maintenance data analysis.
You are given aggregated statistical results produced by DuckDB SQL analysis of maintenance work orders.
Your job is to interpret these results and provide actionable engineering insights.

Rules:
- Only interpret what the data explicitly shows. Never invent failure modes or issues not present.
- Reference specific numbers, percentages, and counts from the data.
- If a metric is flagged as unreliable (null dates, insufficient data, low coverage), acknowledge this limitation clearly.
- Write for a technical reliability engineer — be direct and specific.
- Do not use filler phrases like "it's important to note" or "in conclusion".

Respond in this exact format (use the section headers exactly as shown):

## Overall Summary
[2–3 sentences on the overall reliability health]

## Data Integrity
[Specific insight on data quality findings and what they mean for trust in the other metrics]

## Reliability Analysis
[Specific insight on MTBF, MTTR, equipment performance patterns]

## Process Compliance
[Specific insight on scheduling, response times, confirmation quality]

## Top Recommendations
1. [Most critical action]
2. [Second action]
3. [Third action]`;

// ─────────────────────────────────────────────────────────────────────────────
// Payload builder
// ─────────────────────────────────────────────────────────────────────────────

function buildPayload(results: AnalysisResults): string {
  const lines: string[] = [
    `SESSION ANALYSIS RESULTS`,
    `WOs in scope: ${results.scopeWOCount.toLocaleString()}`,
    `Maturity score: ${results.maturityScore}/100 (Grade ${results.maturityGrade})`,
    `Total anomalies detected: ${results.totalAnomalies}`,
    '',
  ];

  // Active filters summary
  const f = results.filters;
  const activeFilters = [
    f.dateFrom || f.dateTo ? `date: ${f.dateFrom ?? '?'} → ${f.dateTo ?? '?'}` : null,
    f.equipment.length        > 0 ? `equipment: ${f.equipment.slice(0, 3).join(', ')}${f.equipment.length > 3 ? ` +${f.equipment.length - 3} more` : ''}` : null,
    f.functionalLocation.length > 0 ? `functional location: ${f.functionalLocation.length} selected` : null,
    f.orderType.length        > 0 ? `order type: ${f.orderType.join(', ')}` : null,
    f.systemStatus.length     > 0 ? `status: ${f.systemStatus.join(', ')}` : null,
  ].filter(Boolean);

  if (activeFilters.length > 0) {
    lines.push(`Active filters: ${activeFilters.join(' | ')}`);
    lines.push('');
  }

  // Per-module breakdown
  for (const mod of results.modules) {
    lines.push(`--- ${mod.moduleName.toUpperCase()} ---`);
    lines.push(`Status: ${mod.status} | Score: ${mod.score}/100`);
    lines.push(`Key metric: ${mod.keyMetric.label} = ${mod.keyMetric.value}${mod.keyMetric.unit ? ' ' + mod.keyMetric.unit : ''}${mod.keyMetric.note ? ` (${mod.keyMetric.note})` : ''}`);

    if (mod.warnings.length > 0) {
      lines.push(`Data limitations: ${mod.warnings.join('; ')}`);
    }

    if (mod.anomalies.length > 0) {
      lines.push(`Anomalies (${mod.anomalies.length}):`);
      for (const a of mod.anomalies.slice(0, 5)) {
        lines.push(`  [${a.severity}] ${a.label} — ${a.affectedCount.toLocaleString()} of ${a.totalCount.toLocaleString()} WOs (score ${a.score})`);
        lines.push(`    ${a.description}`);
      }
      if (mod.anomalies.length > 5) {
        lines.push(`  ...and ${mod.anomalies.length - 5} more anomalies`);
      }
    } else {
      lines.push('No anomalies detected.');
    }

    // Key metrics (exclude internal objects)
    const metricEntries = Object.entries(mod.metrics)
      .filter(([k, v]) => typeof v === 'number' || typeof v === 'string')
      .slice(0, 8);
    if (metricEntries.length > 0) {
      lines.push('Metrics: ' + metricEntries.map(([k, v]) => `${k}=${v}`).join(', '));
    }

    lines.push('');
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Response parser
// ─────────────────────────────────────────────────────────────────────────────

function parseResponse(text: string, results: AnalysisResults): AIInsights {
  const section = (header: string): string => {
    const re = new RegExp(`## ${header}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, 'i');
    const m = text.match(re);
    return m ? m[1].trim() : '';
  };

  const overallSummary = section('Overall Summary');

  const moduleMap: Record<string, string> = {
    'data-integrity': section('Data Integrity'),
    'reliability':    section('Reliability Analysis'),
    'process':        section('Process Compliance'),
  };

  const moduleInsights: AIModuleInsight[] = results.modules.map(mod => ({
    moduleId:   mod.moduleId,
    moduleName: mod.moduleName,
    insight:    moduleMap[mod.moduleId] || '',
    priority:   mod.status === 'critical' ? 'HIGH' : mod.status === 'warning' ? 'MEDIUM' : 'LOW',
  }));

  // Parse numbered recommendations
  const recsSection = section('Top Recommendations');
  const topRecommendations = recsSection
    .split('\n')
    .map(l => l.replace(/^\d+\.\s*/, '').trim())
    .filter(l => l.length > 0);

  return {
    overallSummary,
    moduleInsights,
    topRecommendations,
    insufficientData: false,
    generatedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function generateInsights(
  results: AnalysisResults,
  aiConfig: AIConfig,
): Promise<AIInsights> {

  if (!aiConfig.apiKey?.trim() && aiConfig.provider !== 'copilot') {
    throw new Error('No API key configured. Go to Settings to add your API key.');
  }

  // Anti-hallucination gate — too few WOs to trust
  if (results.scopeWOCount < 10) {
    return {
      overallSummary: `Only ${results.scopeWOCount} work orders in scope — too few for reliable AI interpretation. Expand the analysis scope or use a larger dataset.`,
      moduleInsights: [],
      topRecommendations: [],
      insufficientData: true,
      generatedAt: new Date().toISOString(),
    };
  }

  const payload = buildPayload(results);
  const text = await callAI(
    aiConfig.provider,
    aiConfig.apiKey,
    aiConfig.modelId,
    [{ role: 'user', content: payload }],
    SYSTEM_PROMPT,
    '',
    aiConfig.powerAutomateUrl ?? '',
  );

  return parseResponse(text, results);
}
