"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Signs out here and at the gateway.
 *
 * A full navigation afterwards rather than a router refresh, so the middleware
 * re-runs against the cleared cookie instead of rendering from a cache that
 * still believes there is a session.
 */
export function SignOutButton({ label }: { label: string }) {
  const [pending, setPending] = useState(false);

  return (
    <Button
      variant="subtle"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          await fetch("/api/auth/logout", { method: "POST" });
        } catch {
          // The cookie is cleared server-side either way; going to the login
          // page is the right destination even if the request failed.
        }
        window.location.assign("/login");
      }}
    >
      {label}
    </Button>
  );
}
