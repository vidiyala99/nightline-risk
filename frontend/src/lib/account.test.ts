import { describe, it, expect, vi, beforeEach } from "vitest";
import { accountApi, AccountError } from "@/lib/account";

const USER = { id: "u1", email: "a@b.com", name: "A", role: "broker", tenant_id: null, extra_venue_ids: [] };

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("accountApi.updateProfile", () => {
  it("PATCHes /api/auth/me with the given body and returns the user", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => USER });
    vi.stubGlobal("fetch", fetchMock);

    const res = await accountApi.updateProfile({ name: "A", email: "a@b.com" });

    expect(res).toEqual(USER);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/auth/me");
    expect(opts.method).toBe("PATCH");
    expect(JSON.parse(opts.body)).toEqual({ name: "A", email: "a@b.com" });
  });

  it("sends the bearer token when present", async () => {
    localStorage.setItem("auth_token", "tok-123");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => USER });
    vi.stubGlobal("fetch", fetchMock);

    await accountApi.updateProfile({ name: "A" });

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer tok-123");
  });

  it("throws AccountError carrying status + the API detail message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ detail: "That email is already in use" }) }),
    );

    await expect(accountApi.updateProfile({ email: "x@y.com" })).rejects.toMatchObject({
      status: 409,
      message: "That email is already in use",
    });
    await expect(accountApi.updateProfile({ email: "x@y.com" })).rejects.toBeInstanceOf(AccountError);
  });
});

describe("accountApi.changePassword", () => {
  it("POSTs to the change-password endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    vi.stubGlobal("fetch", fetchMock);

    await accountApi.changePassword({ old_password: "a", new_password: "bbbbbb" });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/auth/me/change-password");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ old_password: "a", new_password: "bbbbbb" });
  });

  it("throws AccountError on a 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ detail: "Current password is incorrect" }) }),
    );

    await expect(
      accountApi.changePassword({ old_password: "wrong", new_password: "bbbbbb" }),
    ).rejects.toMatchObject({ status: 401, message: "Current password is incorrect" });
  });
});

describe("accountApi.forgotPassword", () => {
  it("POSTs the email to the forgot-password endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: "ok" }) });
    vi.stubGlobal("fetch", fetchMock);

    await accountApi.forgotPassword("user@x.com");

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/auth/forgot-password");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ email: "user@x.com" });
  });
});

describe("accountApi.resetPassword", () => {
  it("POSTs token + new password to the reset endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    vi.stubGlobal("fetch", fetchMock);

    await accountApi.resetPassword({ token: "t0k", new_password: "brandnew1" });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/auth/reset-password");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ token: "t0k", new_password: "brandnew1" });
  });

  it("throws AccountError on an invalid/expired token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ detail: "This reset link is invalid or has expired" }) }),
    );

    await expect(
      accountApi.resetPassword({ token: "bad", new_password: "brandnew1" }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
