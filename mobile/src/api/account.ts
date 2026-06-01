/**
 * Pre-auth account flows for mobile — mirrors web `frontend/src/lib/account.ts`.
 * No bearer token needed; api.request omits it when there's no stored token.
 *   POST /api/auth/forgot-password  → { message }
 *   POST /api/auth/reset-password   → { success }
 */
import { api } from './client';

export const accountApi = {
  forgotPassword: (email: string) =>
    api.request<{ message: string }>('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  resetPassword: (token: string, new_password: string) =>
    api.request<{ success: boolean }>('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, new_password }),
    }),
};
