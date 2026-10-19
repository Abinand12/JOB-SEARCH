import { createFileRoute } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, LabelList, XAxis, YAxis } from "recharts";
import { AlertTriangle, BarChart3, CheckCircle2, MessageSquareText, Send, Target } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { PageHeader } from "@/components/page-header";
import { api } from "@/lib/api";
import { useMe } from "@/hooks/use-me";
import { atsLabel, methodLabel, statusLabel } from "@/lib/labels";
import type { Stats } from "@/lib/types";

export const Route = createFileRoute("/_app/overview")({
  head: () => ({ meta: [{ title: "Overview — Job Autopilot" }] }),
  component: Overview,
});

const dayConfig = {
  easy_apply: { label: "LinkedIn Easy Apply", color: "var(--chart-1)" },
  external_autofill: { label: "Company site (auto-filled)", color: "var(--chart-2)" },
  manual_assist: { label: "Assisted on any site", color: "var(--chart-3)" },
} satisfies ChartConfig;
const countConfig = { count: { label: "Applications", color: "var(--chart-1)" } } satisfies ChartConfig;
const nf = new Intl.NumberFormat();

function Overview() {
  const [days, setDays] = useState("30");
  const me = useMe();
  const { data, isLoading } = useQuery({
    queryKey: ["stats", days],
    queryFn: () => api<Stats>(`/api/stats?days=${days}`),
  });

  const t = data?.totals;
  const empty = data && !t?.tracked && !data.by_day.some((d) => d.easy_apply + d.external_autofill + d.manual_assist);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description="How your auto-apply bot is doing."
        actions={
          <ToggleGroup type="single" variant="outline" size="sm" value={days} onValueChange={(v) => v && setDays(v)} aria-label="Date range">
            {["7", "30", "90"].map((d) => (
              <ToggleGroupItem key={d} value={d} className="px-3">
                {d} days
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        }
      />

      {isLoading || !data ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Skeleton className="h-36 rounded-xl sm:col-span-2 lg:row-span-2 lg:h-auto" />
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
          <Skeleton className="h-72 rounded-xl sm:col-span-2 lg:col-span-4" />
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="rounded-xl sm:col-span-2 lg:row-span-2">
              <CardContent className="flex h-full flex-col justify-between gap-6 p-6">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Send className="size-4 text-primary" /> Applications submitted (last {data.range_days ?? days} days)
                </div>
                <div>
                  <div className="text-5xl font-semibold tracking-tight sm:text-6xl">{nf.format(t!.submitted)}</div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {t!.submitted_today} today · daily limit {me.data?.settings?.daily_limit ?? "–"}
                  </p>
                </div>
              </CardContent>
            </Card>
            <Kpi icon={<CheckCircle2 className="size-4" />} label="Success rate" value={t!.success_rate == null ? "–" : `${Math.round(t!.success_rate * 100)}%`} />
            <Kpi
              icon={<AlertTriangle className={`size-4 ${t!.pending_verification > 0 ? "text-warning" : ""}`} />}
              label="Waiting on you"
              value={nf.format(t!.pending_verification)}
            />
            <Kpi icon={<MessageSquareText className="size-4" />} label="Questions answered" value={nf.format(t!.questions_answered)} sub={`${t!.llm_answers} needed the AI`} />
            <Kpi icon={<Target className="size-4" />} label="Jobs tracked" value={nf.format(t!.tracked)} />
          </div>

          {empty ? (
            <Card className="rounded-xl">
              <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
                <BarChart3 className="size-10 text-muted-foreground" />
                <p className="font-medium">No data yet</p>
                <p className="max-w-sm text-sm text-muted-foreground">Install the extension and start a run to see analytics here.</p>
              </CardContent>
            </Card>
          ) : (
            <>
              <ChartCard
                title="Applications submitted per day"
                table={
                  <SimpleTable
                    head={["Date", "Easy Apply", "Company site", "Assisted"]}
                    rows={data.by_day.map((d) => [d.date, d.easy_apply, d.external_autofill, d.manual_assist])}
                  />
                }
              >
                <ChartContainer config={dayConfig} className="aspect-auto h-72 w-full">
                  <BarChart data={data.by_day} margin={{ left: -16, right: 8 }}>
                    <CartesianGrid vertical={false} strokeDasharray="0" strokeOpacity={0.5} />
                    <XAxis
                      dataKey="date"
                      tickLine={false}
                      axisLine={false}
                      minTickGap={24}
                      tickFormatter={(v) => new Date(v + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    />
                    <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={40} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <ChartLegend content={<ChartLegendContent />} />
                    <Bar dataKey="easy_apply" stackId="a" fill="var(--color-easy_apply)" maxBarSize={24} />
                    <Bar dataKey="external_autofill" stackId="a" fill="var(--color-external_autofill)" maxBarSize={24} />
                    <Bar dataKey="manual_assist" stackId="a" fill="var(--color-manual_assist)" maxBarSize={24} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ChartContainer>
              </ChartCard>

              <div className="grid gap-4 lg:grid-cols-2">
                <HBarCard title="Outcome" data={data.by_status.map((s) => ({ name: statusLabel(s.status), count: s.count }))} />
                <HBarCard title="Where you applied" data={data.by_ats.map((s) => ({ name: atsLabel(s.ats), count: s.count }))} />
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <Card className="rounded-xl">
                  <CardHeader>
                    <CardTitle className="text-base">Top companies</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {data.top_companies.length ? (
                      <SimpleTable head={["Company", "Applications"]} rows={data.top_companies.map((c) => [c.company, c.count])} />
                    ) : (
                      <p className="text-sm text-muted-foreground">No companies yet.</p>
                    )}
                  </CardContent>
                </Card>
                <Card className="rounded-xl">
                  <CardHeader>
                    <CardTitle className="text-base">AI usage</CardTitle>
                  </CardHeader>
                  <CardContent className="grid grid-cols-2 gap-4">
                    <Stat label="Calls" value={nf.format(data.llm.calls)} />
                    <Stat
                      label="Estimated cost"
                      value={data.llm.estimated_cost_usd == null ? "Not priced (free tier)" : `$${data.llm.estimated_cost_usd.toFixed(2)}`}
                    />
                    <Stat label="Input tokens" value={nf.format(data.llm.input_tokens)} />
                    <Stat label="Output tokens" value={nf.format(data.llm.output_tokens)} />
                    {data.llm_model && <p className="col-span-2 text-xs text-muted-foreground">Model: {data.llm_model}</p>}
                  </CardContent>
                </Card>
              </div>
              {data.by_method.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  By method: {data.by_method.map((m) => `${methodLabel(m.method)} ${m.count}`).join(" · ")}
                </p>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function Kpi({ icon, label, value, sub }: { icon: ReactNode; label: string; value: string; sub?: string }) {
  return (
    <Card className="rounded-xl">
      <CardContent className="space-y-2 p-5">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {icon}
          {label}
        </div>
        <div className="text-3xl font-semibold tracking-tight">{value}</div>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}

function ChartCard({ title, children, table }: { title: string; children: ReactNode; table: ReactNode }) {
  const [asTable, setAsTable] = useState(false);
  const id = title.replace(/\W/g, "");
  return (
    <Card className="rounded-xl">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">{title}</CardTitle>
        <div className="flex items-center gap-2">
          <Label htmlFor={id} className="text-xs text-muted-foreground">
            Show as table
          </Label>
          <Switch id={id} checked={asTable} onCheckedChange={setAsTable} />
        </div>
      </CardHeader>
      <CardContent>{asTable ? <div className="max-h-80 overflow-auto">{table}</div> : children}</CardContent>
    </Card>
  );
}

function HBarCard({ title, data }: { title: string; data: { name: string; count: number }[] }) {
  return (
    <ChartCard title={title} table={<SimpleTable head={["", "Count"]} rows={data.map((d) => [d.name, d.count])} />}>
      {data.length ? (
        <ChartContainer config={countConfig} className="aspect-auto w-full" style={{ height: Math.max(120, data.length * 36) }}>
          <BarChart data={data} layout="vertical" margin={{ right: 36, left: 0 }}>
            <XAxis type="number" hide />
            <YAxis type="category" dataKey="name" width={130} tickLine={false} axisLine={false} />
            <ChartTooltip content={<ChartTooltipContent hideLabel={false} />} />
            <Bar dataKey="count" fill="var(--color-count)" radius={4} maxBarSize={22}>
              <LabelList dataKey="count" position="right" className="fill-foreground" fontSize={12} />
            </Bar>
          </BarChart>
        </ChartContainer>
      ) : (
        <p className="text-sm text-muted-foreground">No data yet.</p>
      )}
    </ChartCard>
  );
}

function SimpleTable({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {head.map((h, i) => (
            <TableHead key={i} className={i ? "text-right" : ""}>
              {h}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r, i) => (
          <TableRow key={i}>
            {r.map((c, j) => (
              <TableCell key={j} className={j ? "text-right tabular-nums" : ""}>
                {c}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
