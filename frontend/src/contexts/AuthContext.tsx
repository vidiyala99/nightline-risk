"use client";

import { createContext, useContext, ReactNode, useState, useEffect } from "react";
import { useRouter } from "next/navigation";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

export type UserRole = "broker" | "venue_operator" | "admin";

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  tenant_id: string | null;
  extra_venue_ids: string[];
}

interface AuthContextType {
  user: User | null;
  isLoaded: boolean;
  isSignedIn: boolean;
  role: UserRole | null;
  tenantId: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => void;
  refreshUser: () => Promise<void>;
}

function normalizeUser(raw: any): User {
  return { ...raw, extra_venue_ids: raw?.extra_venue_ids ?? [] };
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem("auth_token");
    if (token) {
      fetchUser(token);
    } else {
      setIsLoaded(true);
    }
  }, []);

  async function fetchUser(token: string) {
    try {
      const response = await fetch(`${API_URL}/api/auth/me`, {
        headers: { "Authorization": `Bearer ${token}` }
      });
      if (!response.ok) throw new Error("Auth failed");
      const userData = await response.json();
      setUser(normalizeUser(userData));
    } catch (error) {
      localStorage.removeItem("auth_token");
    } finally {
      setIsLoaded(true);
    }
  }

  async function refreshUser() {
    const token = localStorage.getItem("auth_token");
    if (!token) return;
    try {
      const response = await fetch(`${API_URL}/api/auth/me`, {
        headers: { "Authorization": `Bearer ${token}` }
      });
      if (!response.ok) return;
      const userData = await response.json();
      setUser(normalizeUser(userData));
    } catch {
      // best-effort refresh; ignore network errors
    }
  }

  async function signIn(email: string, password: string) {
    const response = await fetch(`${API_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "Login failed");
    localStorage.setItem("auth_token", data.access_token);
    setUser(normalizeUser(data.user));
  }

  function signOut() {
    localStorage.removeItem("auth_token");
    setUser(null);
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoaded,
        isSignedIn: !!user,
        role: user?.role || null,
        tenantId: user?.tenant_id || null,
        signIn,
        signOut,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

export function useRole(): UserRole | null {
  const { role } = useAuth();
  return role;
}

export function useTenantId(): string | null {
  const { tenantId } = useAuth();
  return tenantId;
}

export function useIsBroker(): boolean {
  const { role } = useAuth();
  return role === "broker" || role === "admin";
}

export function useIsVenueOperator(): boolean {
  const { role } = useAuth();
  return role === "venue_operator";
}

export function useIsAdmin(): boolean {
  const { role } = useAuth();
  return role === "admin";
}