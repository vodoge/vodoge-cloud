"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

type Labels = {
  email: string;
  password: string;
  submit: string;
  working: string;
  error: string;
  unavailable: string;
};

/**
 * Posts the credential to this app's own route, which forwards it to the
 * gateway and stores the resulting token in an httpOnly cookie. The token never
 * passes through code running on this page.
 */
export function LoginForm({ next, labels }: { next: string; labels: Labels }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: String(form.get("email") ?? ""),
          password: String(form.get("password") ?? ""),
        }),
      });
      if (response.ok) {
        // A full navigation, so the middleware sees the new cookie.
        window.location.assign(next);
        return;
      }
      setError(response.status === 401 ? labels.error : labels.unavailable);
    } catch {
      setError(labels.unavailable);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm font-medium text-muted-foreground">
        {labels.email}
        <input
          className="min-h-touch w-full rounded border border-line-strong bg-bg px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-brand-edge disabled:opacity-50"
          name="email"
          type="email"
          autoComplete="username"
          required
          disabled={pending}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium text-muted-foreground">
        {labels.password}
        {/* `type="password"`, never a reveal toggle: this field is the only
            thing between a stranger on the same screen and the fleet. */}
        <input
          className="min-h-touch w-full rounded border border-line-strong bg-bg px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-brand-edge disabled:opacity-50"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          disabled={pending}
        />
      </label>
      {error ? <p className="m-0 text-sm text-destructive">{error}</p> : null}
      <Button type="submit" disabled={pending}>
        {pending ? labels.working : labels.submit}
      </Button>
    </form>
  );
}
