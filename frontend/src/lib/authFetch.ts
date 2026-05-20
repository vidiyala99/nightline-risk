export function authHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const token = window.localStorage.getItem("auth_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}
