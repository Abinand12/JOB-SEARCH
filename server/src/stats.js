// Pure aggregation for the analytics dashboard. Input rows come from the
// applications table; everything is computed in UTC calendar days.

export const STATUSES = ['submitted', 'in_progress', 'needs_verification', 'needs_review', 'failed', 'skipped'];
export const METHODS = ['easy_apply', 'external_autofill', 'manual_assist'];

const dayKey = (iso) => String(iso).slice(0, 10);

export function computeStats(applications, { days = 30, now = new Date(), usage = [], prices = null } = {}) {
  const today = dayKey(now.toISOString());
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (days - 1));

  const byDay = new Map();
  for (let d = new Date(start); dayKey(d.toISOString()) <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    byDay.set(dayKey(d.toISOString()), Object.fromEntries(METHODS.map((m) => [m, 0])));
  }

  const statusCounts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  const methodCounts = Object.fromEntries(METHODS.map((m) => [m, 0]));
  const atsCounts = new Map();
  const companyCounts = new Map();
  let submittedToday = 0;
  let llmAnswers = 0;
  let questionsAnswered = 0;

  for (const app of applications) {
    statusCounts[app.status] = (statusCounts[app.status] ?? 0) + 1;
    questionsAnswered += app.questions_answered ?? 0;
    llmAnswers += app.llm_answers ?? 0;
    if (app.status !== 'submitted') continue;

    methodCounts[app.method] = (methodCounts[app.method] ?? 0) + 1;
    const ats = app.ats || 'other';
    atsCounts.set(ats, (atsCounts.get(ats) ?? 0) + 1);
    if (app.company) companyCounts.set(app.company, (companyCounts.get(app.company) ?? 0) + 1);

    const key = dayKey(app.submitted_at ?? app.started_at);
    if (key === today) submittedToday += 1;
    const bucket = byDay.get(key);
    if (bucket) bucket[app.method] = (bucket[app.method] ?? 0) + 1;
  }

  const finished = statusCounts.submitted + statusCounts.failed;
  const tokens = usage.reduce(
    (acc, u) => ({ input: acc.input + (u.input_tokens ?? 0), output: acc.output + (u.output_tokens ?? 0) }),
    { input: 0, output: 0 },
  );
  const estimatedCost =
    prices && prices.input !== null && prices.output !== null
      ? (tokens.input * prices.input + tokens.output * prices.output) / 1_000_000
      : null;

  return {
    range_days: days,
    totals: {
      tracked: applications.length,
      submitted: statusCounts.submitted,
      submitted_today: submittedToday,
      failed: statusCounts.failed,
      pending_verification: statusCounts.needs_verification,
      success_rate: finished ? statusCounts.submitted / finished : null,
      questions_answered: questionsAnswered,
      llm_answers: llmAnswers,
    },
    by_day: [...byDay.entries()].map(([date, counts]) => ({ date, ...counts })),
    by_status: STATUSES.map((status) => ({ status, count: statusCounts[status] ?? 0 })),
    by_method: METHODS.map((method) => ({ method, count: methodCounts[method] ?? 0 })),
    by_ats: sortedEntries(atsCounts).map(([ats, count]) => ({ ats, count })),
    top_companies: sortedEntries(companyCounts)
      .slice(0, 10)
      .map(([company, count]) => ({ company, count })),
    llm: { calls: usage.length, input_tokens: tokens.input, output_tokens: tokens.output, estimated_cost_usd: estimatedCost },
  };
}

function sortedEntries(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}
