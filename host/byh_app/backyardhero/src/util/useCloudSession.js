import { useEffect, useState } from "react";
import { apiUrl } from "@/util/clientEnv";

// Cloud profile only. The builder has no sign-in page of its own: the gateway
// at the site root (/sign-in) sets the shared Supabase cookie, and nginx sends
// /builder straight here, past the gateway's login redirect. This hook tells
// the UI whether that cookie is present so it can offer a way to sign in.
export const SIGN_IN_URL = `/sign-in?redirect=${encodeURIComponent("/builder")}`;
export const ACCOUNT_URL = "/dashboard";

// status: "unknown" (not cloud, or still checking) | "signed_in" | "signed_out"
export default function useCloudSession(enabled) {
  const [session, setSession] = useState({ status: "unknown", email: null });

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    fetch(apiUrl("/api/whoami"), { credentials: "same-origin" })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 401) {
          setSession({ status: "signed_out", email: null });
          return;
        }
        if (!res.ok) return; // server trouble: don't claim either way
        const body = await res.json();
        setSession(
          body?.authenticated
            ? { status: "signed_in", email: body.email ?? null }
            : { status: "signed_out", email: null },
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return session;
}
