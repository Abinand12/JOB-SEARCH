import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, MessageSquareText, Search, Trash2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { PageHeader } from "@/components/page-header";
import { api } from "@/lib/api";

export const Route = createFileRoute("/_app/answers")({
  head: () => ({ meta: [{ title: "Saved Answers — Job Autopilot" }] }),
  component: Answers,
});

type Answer = { id: string; question: string; answer: string; source: "llm" | "user"; needs_review: boolean; field_type: string; updated_at: string };

function Answers() {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const { data, isLoading } = useQuery({
    queryKey: ["answers"],
    queryFn: () => api<{ answers: Answer[] }>("/api/saved-answers"),
  });
  const list = (data?.answers ?? []).filter((a) => {
    if (filter === "review" && !a.needs_review) return false;
    if (filter === "user" && a.source !== "user") return false;
    const s = q.toLowerCase();
    return !s || a.question.toLowerCase().includes(s) || (a.answer ?? "").toLowerCase().includes(s);
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Saved Answers"
        description="The AI's answers to screening questions are reused on later applications. Correct any that are wrong — your edits always win."
      />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label="Search answers" placeholder="Search questions…" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <ToggleGroup type="single" variant="outline" size="sm" value={filter} onValueChange={(v) => v && setFilter(v)}>
          <ToggleGroupItem value="all" className="px-3">All</ToggleGroupItem>
          <ToggleGroupItem value="review" className="px-3">Needs review</ToggleGroupItem>
          <ToggleGroupItem value="user" className="px-3">Edited by you</ToggleGroupItem>
        </ToggleGroup>
      </div>
      {isLoading ? (
        <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-36 rounded-xl" />)}</div>
      ) : list.length === 0 ? (
        <Card className="rounded-xl">
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
            <MessageSquareText className="size-10 text-muted-foreground" />
            <p className="font-medium">No saved answers</p>
            <p className="text-sm text-muted-foreground">Answers appear here after the bot fills screening questions.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">{list.map((a) => <AnswerRow key={a.id} a={a} />)}</div>
      )}
    </div>
  );
}

function AnswerRow({ a }: { a: Answer }) {
  const qc = useQueryClient();
  const [val, setVal] = useState(a.answer ?? "");
  const save = useMutation({
    mutationFn: () => api(`/api/saved-answers/${a.id}`, { method: "PATCH", json: { answer: val } }),
    onSuccess: () => {
      toast.success("Answer saved");
      qc.invalidateQueries({ queryKey: ["answers"] });
    },
  });
  const del = useMutation({
    mutationFn: () => api(`/api/saved-answers/${a.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Answer deleted");
      qc.invalidateQueries({ queryKey: ["answers"] });
    },
  });
  return (
    <Card className="rounded-xl">
      <CardContent className="space-y-3 p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <p className="font-medium">{a.question}</p>
          {a.source === "user" ? (
            <Badge>You</Badge>
          ) : (
            <Badge variant="outline" className="shrink-0 border-warning-border bg-warning-surface text-warning-foreground">
              AI{a.needs_review ? " · not reviewed" : ""}
            </Badge>
          )}
        </div>
        <Textarea aria-label={`Answer to: ${a.question}`} value={val} onChange={(e) => setVal(e.target.value)} rows={2} />
        <div className="flex justify-end gap-2">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm"><Trash2 /> Delete</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this answer?</AlertDialogTitle>
                <AlertDialogDescription>The AI will answer this question again next time it sees it.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => del.mutate()}>Delete</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <Button size="sm" disabled={save.isPending || val === (a.answer ?? "")} onClick={() => save.mutate()}>
            {save.isPending && <Loader2 className="animate-spin" />} Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
