import { createFileRoute, Link, Outlet, redirect, useLocation, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { BarChart3, ListChecks, UserRound, MessageSquareText, Settings, Rocket, Moon, Sun, LogOut, Sparkles } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getSupabase } from "@/lib/supabase";
import { useMe } from "@/hooks/use-me";
import { useTheme } from "@/hooks/use-theme";
import { useAuth } from "@/hooks/use-auth";
import { VerificationBanner } from "@/components/verification-banner";

export const Route = createFileRoute("/_app")({
  ssr: false,
  beforeLoad: async ({ location }) => {
    let signedIn = false;
    try {
      const sb = await getSupabase();
      const { data } = await sb.auth.getSession();
      signedIn = !!data.session;
    } catch {
      signedIn = false;
    }
    if (!signedIn) throw redirect({ to: "/auth", search: { redirect: location.href } as any });
  },
  component: AppLayout,
});

const NAV = [
  { to: "/overview", label: "Overview", icon: BarChart3 },
  { to: "/applications", label: "Applications", icon: ListChecks },
  { to: "/profile", label: "Profile & Resume", icon: UserRound },
  { to: "/answers", label: "Saved Answers", icon: MessageSquareText },
  { to: "/settings", label: "Settings & Extension", icon: Settings },
] as const;

function NavItems() {
  const { pathname } = useLocation();
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarMenu>
      {NAV.map((n) => (
        <SidebarMenuItem key={n.to}>
          <SidebarMenuButton asChild isActive={pathname.startsWith(n.to)} tooltip={n.label}>
            <Link to={n.to} onClick={() => setOpenMobile(false)}>
              <n.icon />
              <span>{n.label}</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}

function AppLayout() {
  const me = useMe();
  const { theme, toggle } = useTheme();
  const { session } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const email = me.data?.user.email ?? session?.user.email ?? "";

  async function signOut() {
    await qc.cancelQueries();
    qc.clear();
    const sb = await getSupabase();
    await sb.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <div className="flex items-center gap-2 px-1 py-1.5">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Rocket className="size-4" />
            </div>
            <span className="truncate font-semibold group-data-[collapsible=icon]:hidden">Job Autopilot</span>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <NavItems />
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur sm:px-5">
          <SidebarTrigger />
          <span className="font-semibold md:hidden">Job Autopilot</span>
          <div className="ml-auto flex items-center gap-2">
            {me.data?.llm && (
              <Badge variant="secondary" className="hidden gap-1 font-normal sm:inline-flex">
                <Sparkles className="size-3" />
                AI: {me.data.llm.provider} · {me.data.llm.model}
              </Badge>
            )}
            <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme">
              {theme === "dark" ? <Sun /> : <Moon />}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="max-w-[160px] sm:max-w-[240px]">
                  <span className="truncate">{email || "Account"}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel className="font-normal text-muted-foreground">{email}</DropdownMenuLabel>
                {me.data?.llm && (
                  <DropdownMenuLabel className="font-normal text-xs text-muted-foreground sm:hidden">
                    AI: {me.data.llm.provider} · {me.data.llm.model}
                  </DropdownMenuLabel>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={signOut}>
                  <LogOut /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 space-y-6 px-3 py-6 sm:px-6">
          <VerificationBanner />
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
