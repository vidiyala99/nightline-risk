# Nightline Landing Page — Design

Date: 2026-06-03
Status: approved (brainstorm)

## Context

There is no landing page. Root `/` does `redirect("/dashboard")`, and `/dashboard`
bounces a signed-out visitor to `/login`. So every outreach demo link
(`nightline-app.vercel.app`) funnels recruiters/founders `/ → /dashboard → /login`
and dumps them on a bare password form with zero product story.

## Goal / audience

A standalone **Nightline** landing at `/` that, for a signed-out visitor, sells the
thesis and routes them into the live demo in one click. Audience = **recruiters /
founders** (the people clicking the demo link), not customers.

**Honesty stance:** Nightline has no real users, so **no fabricated social proof** — no
testimonials, customer logos, or "trusted by N." Credibility comes from the live demo,
the breadth (full value chain), and the eval-gated AI depth. (Same rule as the
no-vanity-test-count guidance.)

**Framing:** stand-alone Nightline (Aakash's own project), NOT "built for ThirdSpaceRisk"
— the link goes to every recruiter. The thesis pillars are Nightline's own framing.

## Routing

`frontend/src/app/page.tsx` becomes a `"use client"` page:
- `if (isLoaded && isSignedIn)` → redirect to the role home (`carrier` → `/underwriting`,
  else `/dashboard`). Preserves existing app behavior for logged-in users.
- else → render the landing.
(Root layout already provides `AuthProvider` and renders bare — no AppShell — same as
`/login`.)

## Structure (single scrolling page)

1. **Hero** — mono eyebrow ("NIGHTLINE · RISK OS"), a one-line thesis headline with the
   Caveat script accent on one word, a sub naming the value chain (operator → broker →
   carrier), primary CTA **"Explore the live demo"** (scrolls to the persona section) +
   secondary text link "Sign in" (`/login`).
2. **Three pillars** (Nightline's framing of the bet): (a) operational data → proprietary
   underwriting; (b) hashed, corroborated evidence that defends the assault-and-battery
   lawsuits driving liability-rate hikes; (c) the AI-native carrier — it underwrites and
   adjudicates its own claims.
3. **The loop** — compact horizontal pipeline: incident → hashed evidence → risk score →
   underwriting → claim → defense package. Communicates "system, not screens."
4. **The differentiator** — eval-gated AI: "every agent recommendation is scored against
   a rubric in CI, not shipped on vibes." The moat, plainly.
5. **One-click demo** — the three persona buttons inline (Venue operator / Broker /
   Carrier desk), each calling the existing demo `signIn` then redirecting to that
   persona's home. Recruiter is inside the product in one click.

## Brand / visual

Reuse the existing editorial system — `lc-eyebrow`, `lc-display` (+ `em` Caveat accent),
`lc-sub`, `lc-card`, `--accent` (lime fill), `--accent-ink` (accent TEXT — never lime as
text), warm-paper `--bg-base`, mono eyebrows. **No new design system.** Static, calm
background (no heavy animation); respect `prefers-reduced-motion`.

## A11y / invariants

- Touch targets ≥44px; visible focus rings; headings sequential (one `h1` in hero).
- Body/secondary text ≥4.5:1 contrast on warm paper.
- Accent text uses `--accent-ink`, lime is a FILL only (project invariant).
- The persona buttons are real `<button>`s with loading state on click (reuse login's
  `loading` pattern); errors surface inline.

## Out of scope

Mobile app (web only); `/login` stays as-is (the landing's "Sign in" links to it); no new
copy for other routes.

## Testing / verify

`tsc --noEmit` clean; manual render check of the page signed-out (landing) and signed-in
(redirects to role home); persona buttons log into the right demo home.
