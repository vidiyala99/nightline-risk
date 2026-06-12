"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * Single source of truth for the "up" / back affordance.
 *
 * The app has exactly one back control per screen, rendered by {@link AppShell}.
 * By default that control is a generic "Back to home". A detail page can claim
 * it instead — registering a contextual label + action (e.g. "Back to
 * Incidents") — and while that registration is live, AppShell renders the
 * page's back *in place of* "Back to home". This kills the old double-back bug
 * where a global "Back to home" stacked on top of a page-level "Back", and
 * removes every page's ad-hoc persona guesswork (the `role !== operator` gates).
 *
 * Mirrors mobile, where each screen owns its single `navigation.goBack()`.
 *
 * Two contexts on purpose:
 *  - dispatch (register/unregister) is memoized → stable identity forever, so a
 *    page's registration effect never re-runs in a loop.
 *  - state (the current registration) only re-renders AppShell, not the pages.
 */

export interface PageBack {
  id: string;
  label: string;
  onBack: () => void;
}

interface BackDispatch {
  register: (entry: PageBack) => void;
  unregister: (id: string) => void;
}

const BackDispatchContext = createContext<BackDispatch | null>(null);
const BackStateContext = createContext<PageBack | null>(null);

export function BackNavProvider({ children }: { children: ReactNode }) {
  const [reg, setReg] = useState<PageBack | null>(null);

  const dispatch = useMemo<BackDispatch>(
    () => ({
      register: (entry) => setReg(entry),
      // Only clear if *this* registration is still the active one — guards
      // against a stale unmount clobbering a newer page's registration.
      unregister: (id) => setReg((current) => (current?.id === id ? null : current)),
    }),
    [],
  );

  return (
    <BackDispatchContext.Provider value={dispatch}>
      <BackStateContext.Provider value={reg}>{children}</BackStateContext.Provider>
    </BackDispatchContext.Provider>
  );
}

/**
 * Page-level: claim the back affordance for the lifetime of this component.
 * While mounted, AppShell renders this contextual back instead of "Back to
 * home". `onBack` is read through a ref so callers don't need useCallback and
 * the registration effect stays stable (deps are only the stable dispatch, a
 * stable useId, and the label string).
 */
export function usePageBack(label: string, onBack: () => void) {
  const dispatch = useContext(BackDispatchContext);
  const id = useId();

  // Keep the latest onBack in a ref (updated in an effect, never during render)
  // so the registered callback identity stays stable and callers don't need
  // useCallback.
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  });
  const stableOnBack = useCallback(() => onBackRef.current(), []);

  useEffect(() => {
    if (!dispatch) return;
    dispatch.register({ id, label, onBack: stableOnBack });
    return () => dispatch.unregister(id);
  }, [dispatch, id, label, stableOnBack]);
}

/** AppShell-only: read the currently registered page back (or null). */
export function usePageBackState(): PageBack | null {
  return useContext(BackStateContext);
}
