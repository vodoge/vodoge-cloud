import { cn } from "@/lib/cn";

/**
 * A reading shown verbatim: an AT transcript, a command's JSON, a journal
 * payload.
 *
 * It scrolls inside its own box in both directions instead of stretching the
 * page, because none of the three things it holds has a width limit. The
 * journal's payloads are whatever the edge sent, and a single long line there
 * used to push the whole table sideways.
 *
 * `m-0` in the recipe is load-bearing rather than tidiness: preflight is off,
 * so the browser's own `pre { margin: 1em 0 }` is still live.
 *
 * Class strings live in `lib/tokens.ts`. See the note in `button.tsx`.
 */
export function Output({ className, ...props }: React.HTMLAttributes<HTMLPreElement>) {
  return <pre
      className={cn(
        "m-0 mt-2 max-h-panel overflow-auto rounded bg-background p-3 font-mono text-xs text-foreground",
        className,
      )}
      {...props}
    />;
}
