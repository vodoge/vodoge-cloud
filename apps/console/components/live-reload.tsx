"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function LiveReload({ kinds = ["SmsReceived", "DeviceState"] }: { kinds?: string[] }) {
  const router = useRouter();

  useEffect(() => {
    const source = new EventSource("/v1/events");
    const onUplink = (event: MessageEvent<string>) => {
      if (kinds.includes(event.data)) {
        router.refresh();
      }
    };
    source.addEventListener("uplink", onUplink);
    return () => {
      source.removeEventListener("uplink", onUplink);
      source.close();
    };
  }, [kinds, router]);

  return null;
}
