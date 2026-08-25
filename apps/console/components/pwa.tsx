"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { t, type Locale } from "@/lib/i18n";
import {
  INSTALL_DISMISSED_KEY,
  detectPlatform,
  installState,
  isStandalone,
  type InstallState,
} from "@/lib/pwa";
import { PWA } from "@/lib/tokens";

/**
 * Registers the service worker.
 *
 * Registration is deferred to the load event so it never competes with the
 * first render for bandwidth, and failure is swallowed: the console works
 * perfectly well without one, and a red console error would send someone
 * debugging a non-problem.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    };
    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}

/**
 * The event Chromium fires and nobody has typed.
 *
 * It is not in lib.dom, because it is not in any specification a second engine
 * implements — which is the whole reason `InstallState` has an `ios-guide`
 * arm.
 */
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

/**
 * The install offer, which is two different features sharing one word.
 *
 * On Chromium the browser decides the console is installable, fires
 * `beforeinstallprompt`, and hands over an object that opens the real install
 * dialog. Deferring it with `preventDefault()` is what moves that dialog from
 * "whenever the browser felt like it" to "when the operator asks".
 *
 * **Safari has never fired that event and offers no equivalent.** On iOS the
 * only route to a home-screen app is Share → Add to Home Screen, found by the
 * user, so the only honest thing to render there is where the button is. A
 * console that shipped the Chromium branch alone would have no install path at
 * all on the devices an operator carries — see `detectPlatform`, which also
 * has to catch the iPad that claims to be a Mac.
 *
 * Nothing is rendered until an effect has run: the server cannot know whether
 * this browser can install anything, and guessing would mean markup that
 * disagrees with the DOM on the first paint.
 */
export function InstallPrompt({ locale }: { locale: Locale }) {
  const [state, setState] = useState<InstallState>("unavailable");
  const [dismissed, setDismissed] = useState(true);
  const deferred = useRef<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const platform = detectPlatform(
      window.navigator.userAgent,
      window.navigator.maxTouchPoints,
    );
    const standalone = isStandalone(
      (query) => window.matchMedia(query).matches,
      (window.navigator as { standalone?: boolean }).standalone === true,
    );

    const refresh = () => {
      setState(
        installState({ standalone, promptAvailable: deferred.current !== null, platform }),
      );
    };

    // A private window, or storage blocked by policy, must not take the offer
    // down — it throws rather than returning null.
    let remembered = false;
    try {
      remembered = window.localStorage.getItem(INSTALL_DISMISSED_KEY) === "1";
    } catch {
      remembered = false;
    }
    setDismissed(remembered);
    refresh();

    const onBeforeInstallPrompt = (event: Event) => {
      // Without this Chromium shows its own mini-infobar at a moment of its
      // choosing and the event is spent; with it, the dialog is ours to open.
      event.preventDefault();
      deferred.current = event as BeforeInstallPromptEvent;
      refresh();
    };
    const onInstalled = () => {
      deferred.current = null;
      setState("installed");
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const remember = useCallback(() => {
    setDismissed(true);
    try {
      window.localStorage.setItem(INSTALL_DISMISSED_KEY, "1");
    } catch {
      // Nothing to do: the offer is gone for this tab either way.
    }
  }, []);

  const install = useCallback(async () => {
    const event = deferred.current;
    if (!event) return;
    // Chromium spends the event on the first `prompt()`, so it is cleared
    // whatever the answer; a second click on a spent event does nothing and
    // would look like a broken button.
    deferred.current = null;
    await event.prompt();
    const choice = await event.userChoice;
    if (choice.outcome === "accepted") {
      setState("installed");
      return;
    }
    remember();
  }, [remember]);

  if (dismissed) return null;
  if (state !== "promptable" && state !== "ios-guide") return null;

  const ios = state === "ios-guide";

  return (
    <div className={PWA.install.bar} role="region" aria-label={t("pwa.install.title", locale)}>
      <span className={PWA.install.text}>
        <strong className={PWA.install.title}>
          {ios ? t("pwa.install.iosTitle", locale) : t("pwa.install.title", locale)}
        </strong>
        <span className={PWA.install.hint}>
          {ios ? t("pwa.install.iosHint", locale) : t("pwa.install.hint", locale)}
        </span>
      </span>
      <span className={PWA.install.actions}>
        {/* iOS gets no button, because there is nothing a button could call.
            Pretending otherwise is worse than directions that work. */}
        {ios ? null : (
          <Button variant="primary" size="sm" onClick={install}>
            {t("pwa.install.action", locale)}
          </Button>
        )}
        <Button variant="subtle" size="sm" onClick={remember}>
          {t("pwa.install.dismiss", locale)}
        </Button>
      </span>
    </div>
  );
}
