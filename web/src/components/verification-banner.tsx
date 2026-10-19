import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { AlertTriangle, BellRing, ExternalLink, X } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { getSupabase } from "@/lib/supabase";
import { kindLabel } from "@/lib/labels";
import { useAuth } from "@/hooks/use-auth";
import type { Alert } from "@/lib/types";

function where(a: Alert) {
  let host = "";
  try {
    if (a.page_url) host = new URL(a.page_url).hostname;
  } catch {
    /* ignore */
  }
  const company = a.applications?.company || host || "a page";
  return `${company}${a.applications?.job_title ? ` · ${a.applications.job_title}` : ""}`;
}

export function VerificationBanner() {
  const qc = useQueryClient();
  const { session } = useAuth();
  const userId = session?.user.id;
  const { pathname } = useLocation();
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">("default");
  const seen = useRef(new Set<string>());

  const { data } = useQuery({
    queryKey: ["alerts"],
    queryFn: async () => {
      const r = await api<any>("/api/alerts?status=open");
      return (Array.isArray(r) ? r : r?.alerts ?? []) as Alert[];
    },
    refetchInterval: 20000,
  });
  const alerts = data ?? [];

  const dismiss = useMutation({
    mutationFn: (id: string) => api(`/api/alerts/${id}`, { method: "PATCH", json: { status: "expired" } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }),
  });

  useEffect(() => {
    setPerm(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
  }, []);

  // Realtime refresh
  useEffect(() => {
    if (!userId) return;
    let cleanup: (() => void) | undefined;
    getSupabase().then((sb) => {
      const ch = sb
        .channel(`alerts-${userId}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "verification_alerts", filter: `user_id=eq.${userId}` },
          () => qc.invalidateQueries({ queryKey: ["alerts"] }),
        )
        .subscribe();
      cleanup = () => {
        sb.removeChannel(ch);
      };
    });
    return () => cleanup?.();
  }, [userId, qc]);

  // Desktop notifications for new alerts
  useEffect(() => {
    for (const a of alerts) {
      if (seen.current.has(a.id)) continue;
      seen.current.add(a.id);
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification("Verification needed", { body: `${kindLabel(a.kind)} on ${where(a)}`, tag: a.id });
      }
    }
  }, [alerts]);

  // Tab title prefix
  useEffect(() => {
    const apply = () => {
      const base = document.title.replace(/^\(\d+\)\s/, "");
      document.title = alerts.length ? `(${alerts.length}) ${base}` : base;
    };
    apply();
    const t = setTimeout(apply, 50);
    return () => clearTimeout(t);
  }, [alerts.length, pathname]);

  const enable = async () => setPerm(await Notification.requestPermission());

  if (!alerts.length) {
    return perm === "default" ? (
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={enable} className="text-muted-foreground">
          <BellRing /> Enable desktop alerts
        </Button>
      </div>
    ) : null;
  }

  return (
    <div className="space-y-2" role="alert">
      {alerts.map((a) => (
        <div
          key={a.id}
          className="flex flex-col gap-3 rounded-xl border border-warning-border bg-warning-surface p-4 text-warning-foreground sm:flex-row sm:items-start"
        >
          <AlertTriangle className="size-5 shrink-0 text-warning" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="font-medium">
              Verification needed: {kindLabel(a.kind)} on {where(a)}
            </p>
            <p className="text-sm opacity-90">
              The bot is paused on that tab. Switch to it (click the extension's notification), complete the check, and the bot continues by itself.
            </p>
            <p className="text-xs opacity-75">{formatDistanceToNow(new Date(a.created_at), { addSuffix: true })}</p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {perm === "default" && (
              <Button size="sm" variant="outline" onClick={enable}>
                <BellRing /> Enable desktop alerts
              </Button>
            )}
            {a.page_url?.startsWith("http") && (
              <Button size="sm" variant="outline" asChild>
                <a href={a.page_url} target="_blank" rel="noreferrer">
                  <ExternalLink /> Open page
                </a>
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => dismiss.mutate(a.id)} disabled={dismiss.isPending}>
              <X /> Dismiss
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
