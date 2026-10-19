import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { getSupabase } from "@/lib/supabase";

type AuthState = { session: Session | null; ready: boolean };
const AuthContext = createContext<AuthState>({ session: null, ready: false });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ session: null, ready: false });
  const router = useRouter();
  const qc = useQueryClient();

  useEffect(() => {
    let unsub: (() => void) | undefined;
    getSupabase()
      .then(async (sb) => {
        const { data } = await sb.auth.getSession();
        setState({ session: data.session, ready: true });
        const { data: sub } = sb.auth.onAuthStateChange((event, session) => {
          setState({ session, ready: true });
          if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") {
            router.invalidate();
          }
        });
        unsub = () => sub.subscription.unsubscribe();
      })
      .catch(() => setState({ session: null, ready: true }));
    return () => unsub?.();
  }, [router, qc]);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
