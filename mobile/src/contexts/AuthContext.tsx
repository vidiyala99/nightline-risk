import React, { createContext, useContext, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { api } from '../api/client';

interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  tenant_id: string;
  extra_venue_ids: string[];
}

interface AuthContextValue {
  isSignedIn: boolean;
  isLoading: boolean;
  user: User | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, name: string, role: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  async function fetchMe(): Promise<User | null> {
    try {
      const me = await api.request<User>('/api/auth/me');
      return { ...me, extra_venue_ids: me.extra_venue_ids ?? [] };
    } catch {
      return null;
    }
  }

  useEffect(() => {
    SecureStore.getItemAsync('auth_token').then(async (token) => {
      if (token) {
        const me = await fetchMe();
        setUser(me);
      }
      setIsLoading(false);
    });
  }, []);

  async function signIn(email: string, password: string) {
    const data = await api.request<{ access_token: string; user: User }>(
      '/api/auth/login',
      { method: 'POST', body: JSON.stringify({ email, password }) }
    );
    await SecureStore.setItemAsync('auth_token', data.access_token);
    setUser({ ...data.user, extra_venue_ids: data.user.extra_venue_ids ?? [] });
  }

  async function signUp(email: string, password: string, name: string, role: string) {
    const data = await api.request<{ access_token: string; user: User }>(
      '/api/auth/register',
      { method: 'POST', body: JSON.stringify({ email, password, name, role }) }
    );
    await SecureStore.setItemAsync('auth_token', data.access_token);
    setUser({ ...data.user, extra_venue_ids: data.user.extra_venue_ids ?? [] });
  }

  async function signOut() {
    await SecureStore.deleteItemAsync('auth_token');
    setUser(null);
  }

  async function refreshUser() {
    const me = await fetchMe();
    if (me) setUser(me);
  }

  return (
    <AuthContext.Provider
      value={{ isSignedIn: !!user, isLoading, user, signIn, signUp, signOut, refreshUser }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
