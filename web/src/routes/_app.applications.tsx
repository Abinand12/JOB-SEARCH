import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Inbox, Search } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/page-header";
import { api } from "@/lib/api";
import { METHOD, STATUS, atsLabel, methodLabel } from "@/lib/labels";
import type { Application } from "@/lib/types";

export const Route = createFileRoute("/_app/applications")({
  head: () => ({ meta: [{ title: "Applications — Job Autopilot" }] }),
  component: Applications,
});

const LIMIT = 25;

function StatusCell({ a }: { a: Application }) {
  const s = STATUS[a.status];
  return (
    <div>
      <span className="inline-flex items-center gap-1.5 text-sm">
        <span className={`size-2 rounded-full ${s?.dot ?? "bg-status-skipped"}`} />
        {s?.label ?? a.status}
      </span>
      {a.failure_reason && <p className="mt-0.5 text-xs text-muted-foreground">{a.failure_reason}</p>}
    </div>
  );
}

const fmtDate = (d: string) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "–");

function Applications() {
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [status, setStatus] = useState("all");
  const [method, setMethod] = useState("all");
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => {
      setDq(q);
      setOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const params = new URLSearchParams({
    limit: String(LIMIT),
    offset: String(offset),
    status: status === "all" ? "" : status,
    method: method === "all" ? "" : method,
    q: dq,
  });
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["applications", params.toString()],
    queryFn: () => api<{ rows: Application[]; total: number }>(`/api/applications?${params}`),
    placeholderData: keepPreviousData,
  });
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader title="Applications" description="Every job the bot has touched." />
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search applications" placeholder="Search title or company…" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select value={status} onValueChange={(v) => { setStatus(v); setOffset(0); }}>
          <SelectTrigger className="sm:w-48" aria-label="Status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {Object.entries(STATUS).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={method} onValueChange={(v) => { setMethod(v); setOffset(0); }}>
          <SelectTrigger className="sm:w-56" aria-label="Method">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All methods</SelectItem>
            {Object.entries(METHOD).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14 rounded-lg" />)}
        </div>
      ) : rows.length === 0 ? (
        <Card className="rounded-xl">
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
            <Inbox className="size-10 text-muted-foreground" />
            <p className="font-medium">No applications found</p>
            <p className="text-sm text-muted-foreground">Try different filters, or start a run from the extension.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card className={`hidden rounded-xl md:block ${isFetching ? "opacity-70" : ""}`}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Job</TableHead>
                  <TableHead>Company</TableHead>
                  <TableHead>Platform</TableHead>
                  <TableHead>How</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">AI answers</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{fmtDate(a.started_at)}</TableCell>
                    <TableCell className="max-w-64">
                      <a href={a.job_url} target="_blank" rel="noreferrer" className="font-medium hover:text-primary hover:underline">
                        {a.job_title || "Untitled job"}
                      </a>
                      {a.location && <p className="text-xs text-muted-foreground">{a.location}</p>}
                    </TableCell>
                    <TableCell>{a.company}</TableCell>
                    <TableCell>{atsLabel(a.ats)}</TableCell>
                    <TableCell className="text-sm">{methodLabel(a.method)}</TableCell>
                    <TableCell><StatusCell a={a} /></TableCell>
                    <TableCell className="text-right tabular-nums">{a.llm_answers} / {a.questions_answered}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
          <div className="space-y-3 md:hidden">
            {rows.map((a) => (
              <Card key={a.id} className="rounded-xl">
                <CardContent className="space-y-2 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <a href={a.job_url} target="_blank" rel="noreferrer" className="font-medium hover:text-primary hover:underline">
                        {a.job_title || "Untitled job"}
                      </a>
                      <p className="text-sm text-muted-foreground">{a.company}{a.location ? ` · ${a.location}` : ""}</p>
                    </div>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">AI {a.llm_answers}/{a.questions_answered}</span>
                  </div>
                  <StatusCell a={a} />
                  <p className="text-xs text-muted-foreground">
                    {fmtDate(a.started_at)} · {atsLabel(a.ats)} · {methodLabel(a.method)}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}

      {total > 0 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{offset + 1}–{Math.min(offset + LIMIT, total)} of {total}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>
              <ChevronLeft /> Prev
            </Button>
            <Button variant="outline" size="sm" disabled={offset + LIMIT >= total} onClick={() => setOffset(offset + LIMIT)}>
              Next <ChevronRight />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
