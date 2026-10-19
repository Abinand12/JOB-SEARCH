import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Copy, KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { PageHeader } from "@/components/page-header";
import { TagInput } from "@/components/tag-input";
import { api } from "@/lib/api";
import { API_BASE, EXTENSION_REPO } from "@/lib/config";
import { useMe } from "@/hooks/use-me";

export const Route = createFileRoute("/_app/settings")({
  head: () => ({ meta: [{ title: "Settings & Extension — Job Autopilot" }] }),
  component: SettingsPage,
});

const num = (v: any) => (v === "" || v == null ? null : Number(v));

const SWITCHES = [
  ["easy_apply_only", "Only Easy Apply jobs"],
  ["apply_external", "Also apply on company websites"],
  ["auto_submit_easy_apply", "Submit Easy Apply automatically (off = stop at review)"],
  ["auto_submit_external", "Submit on company websites automatically (off = fill and wait for me)"],
  ["auto_accept_consent", "Tick privacy-policy / terms consent boxes"],
] as const;

function CopyButton({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      aria-label="Copy"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setOk(true);
        setTimeout(() => setOk(false), 1500);
      }}
    >
      {ok ? <Check /> : <Copy />}
    </Button>
  );
}

function SettingsPage() {
  const me = useMe();
  const qc = useQueryClient();
  const form = useForm<any>({ defaultValues: {} });
  useEffect(() => {
    if (me.data) form.reset(me.data.settings ?? {});
  }, [me.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: (settings: any) => api("/api/profile", { method: "PUT", json: { settings } }),
    onSuccess: (_d, v) => {
      toast.success("Settings saved");
      form.reset(v);
      qc.invalidateQueries({ queryKey: ["me"] });
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader title="Settings & Extension" description="Control how the bot searches and applies, and connect your browser." />
      <Card className="rounded-xl">
        <CardHeader>
          <CardTitle className="text-base">Bot settings</CardTitle>
        </CardHeader>
        <CardContent>
          {me.isLoading ? (
            <Skeleton className="h-96 rounded-lg" />
          ) : (
            <form onSubmit={form.handleSubmit((v) => save.mutate({ ...(me.data?.settings ?? {}), ...v }))} className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Daily limit" id="daily_limit">
                  <Input id="daily_limit" type="number" min={0} {...form.register("daily_limit", { setValueAs: num })} />
                </Field>
                <Field label="Search keywords" id="search_keywords">
                  <Input id="search_keywords" {...form.register("search_keywords")} />
                </Field>
                <Field label="Search location" id="search_location">
                  <Input id="search_location" {...form.register("search_location")} />
                </Field>
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Min delay (sec)" id="min_delay_sec">
                    <Input id="min_delay_sec" type="number" min={0} {...form.register("min_delay_sec", { setValueAs: num })} />
                  </Field>
                  <Field label="Max delay (sec)" id="max_delay_sec">
                    <Input id="max_delay_sec" type="number" min={0} {...form.register("max_delay_sec", { setValueAs: num })} />
                  </Field>
                </div>
                {(["title_include", "title_exclude", "company_blacklist"] as const).map((k) => (
                  <Field key={k} id={k} label={{ title_include: "Job titles must include", title_exclude: "Skip titles containing", company_blacklist: "Never apply to these companies" }[k]}>
                    <Controller control={form.control} name={k} render={({ field }) => <TagInput id={k} value={field.value} onChange={field.onChange} />} />
                  </Field>
                ))}
              </div>
              <div className="divide-y rounded-lg border">
                {SWITCHES.map(([k, label]) => (
                  <div key={k} className="flex items-center justify-between gap-4 p-3">
                    <Label htmlFor={k} className="font-normal leading-snug">{label}</Label>
                    <Controller control={form.control} name={k} render={({ field }) => <Switch id={k} checked={!!field.value} onCheckedChange={field.onChange} />} />
                  </div>
                ))}
              </div>
              <div className="flex justify-end">
                <Button type="submit" disabled={save.isPending || !form.formState.isDirty}>
                  {save.isPending && <Loader2 className="animate-spin" />} Save settings
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
      <ExtensionCard />
    </div>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

type Token = { id: string; label: string; created_at: string; last_used_at: string | null };

function ExtensionCard() {
  const qc = useQueryClient();
  const [newToken, setNewToken] = useState<string | null>(null);
  const tokens = useQuery({ queryKey: ["tokens"], queryFn: () => api<{ tokens: Token[] }>("/api/tokens") });
  const create = useMutation({
    mutationFn: () => api<{ token: string }>("/api/tokens", { method: "POST", json: { label: `Chrome · ${new Date().toLocaleDateString()}` } }),
    onSuccess: (d) => {
      setNewToken(d.token);
      qc.invalidateQueries({ queryKey: ["tokens"] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/tokens/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Token revoked");
      qc.invalidateQueries({ queryKey: ["tokens"] });
    },
  });

  return (
    <Card className="rounded-xl">
      <CardHeader>
        <CardTitle className="text-base">Connect the Chrome extension</CardTitle>
        <CardDescription>The extension does the applying; this dashboard controls it.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <ol className="space-y-4 text-sm">
          <li className="flex gap-3">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">1</span>
            <p>
              Open <code className="rounded bg-muted px-1">chrome://extensions</code>, enable <b>Developer mode</b>, click <b>Load unpacked</b> and choose the{" "}
              <code className="rounded bg-muted px-1">extension</code> folder of the GitHub repo{" "}
              <a className="text-primary underline" href={`https://github.com/${EXTENSION_REPO}`} target="_blank" rel="noreferrer">{EXTENSION_REPO}</a>.
            </p>
          </li>
          <li className="flex gap-3">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">2</span>
            <div className="min-w-0 flex-1 space-y-2">
              <p>In the extension options, paste the API address and a token.</p>
              <div className="flex gap-2">
                <Input readOnly value={API_BASE} aria-label="API address" className="font-mono text-xs" />
                <CopyButton text={API_BASE} />
              </div>
              <Button onClick={() => create.mutate()} disabled={create.isPending}>
                {create.isPending ? <Loader2 className="animate-spin" /> : <Plus />} Create extension token
              </Button>
            </div>
          </li>
        </ol>

        <div className="space-y-2">
          <p className="text-sm font-medium">Your tokens</p>
          {tokens.isLoading ? (
            <Skeleton className="h-16 rounded-lg" />
          ) : !tokens.data?.tokens.length ? (
            <p className="text-sm text-muted-foreground">No tokens yet.</p>
          ) : (
            <div className="divide-y rounded-lg border">
              {tokens.data.tokens.map((t) => (
                <div key={t.id} className="flex items-center gap-3 p-3">
                  <KeyRound className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{t.label}</p>
                    <p className="text-xs text-muted-foreground">
                      Created {new Date(t.created_at).toLocaleDateString()} · {t.last_used_at ? `last used ${new Date(t.last_used_at).toLocaleString()}` : "never used"}
                    </p>
                  </div>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="ghost" size="sm"><Trash2 /> Revoke</Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Revoke this token?</AlertDialogTitle>
                        <AlertDialogDescription>Any extension using it will stop working.</AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => revoke.mutate(t.id)}>Revoke</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>

      <Dialog open={!!newToken} onOpenChange={(o) => !o && setNewToken(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Your extension token</DialogTitle>
            <DialogDescription>Copy it now — it won't be shown again.</DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Input readOnly value={newToken ?? ""} className="font-mono text-xs" aria-label="Token" />
            <CopyButton text={newToken ?? ""} />
          </div>
          <DialogFooter>
            <Button onClick={() => setNewToken(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
