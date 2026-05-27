/**
 * Typed client for the caller's own account mutations:
 *   PATCH /api/auth/me              — update name / email
 *   POST  /api/auth/me/change-password
 *
 * Mirrors the lib/ingestion.ts shape and uses authHeaders() for the bearer
 * token. The web settings page consumes these, then calls refreshUser() from
 * AuthContext to re-sync the cached user.
 */
import { authHeaders } from "@/lib/authFetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

export interface AccountUser {
  id: string;
  email: string;
  name: string;
  role: string;
  tenant_id: string | null;
  extra_venue_ids: string[];
}

export class AccountError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "AccountError";
  }
}

async function raise(res: Response, fallback: string): Promise<never> {
  let message = fallback;
  try {
    const data = await res.json();
    const detail = data?.detail ?? data?.message;
    if (typeof detail === "string") message = detail;
  } catch {
    /* non-JSON error body — keep fallback */
  }
  throw new AccountError(res.status, message);
}

export const accountApi = {
  updateProfile: async (body: { name?: string; email?: string }): Promise<AccountUser> => {
    const res = await fetch(`${API_URL}/api/auth/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
    });
    if (!res.ok) await raise(res, "Failed to update profile");
    return (await res.json()) as AccountUser;
  },

  changePassword: async (body: { old_password: string; new_password: string }): Promise<void> => {
    const res = await fetch(`${API_URL}/api/auth/me/change-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
    });
    if (!res.ok) await raise(res, "Failed to change password");
  },

  // Pre-auth flows — no bearer token needed.
  forgotPassword: async (email: string): Promise<void> => {
    const res = await fetch(`${API_URL}/api/auth/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) await raise(res, "Couldn't start the reset. Try again.");
  },

  resetPassword: async (body: { token: string; new_password: string }): Promise<void> => {
    const res = await fetch(`${API_URL}/api/auth/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) await raise(res, "Couldn't reset your password.");
  },
};
