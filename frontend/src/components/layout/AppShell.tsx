"use client";

import { ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  Building2,
  AlertTriangle,
  CheckSquare,
  FileSearch,
  Settings,
  LogOut,
  Activity,
} from "lucide-react";
import { useAuth, useRole } from "@/contexts/AuthContext";

interface AppShellProps {
  children: ReactNode;
}

const navItems = [
  { href: "/dashboard", label: "Portfolio", icon: LayoutDashboard },
  { href: "/underwriter", label: "Packet Review", icon: FileSearch, roles: ["broker", "admin"] },
  { href: "/terminal", label: "Venue Risk", icon: Activity },
  { href: "/venues", label: "Venues", icon: Building2, roles: ["broker", "admin"] },
  { href: "/incidents", label: "Incidents", icon: AlertTriangle },
  { href: "/compliance", label: "Compliance", icon: CheckSquare },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { signOut, user } = useAuth();
  const role = useRole();

  const filteredNav = navItems.filter(
    (item) => !item.roles || item.roles.includes(role || "")
  );

  const handleSignOut = () => {
    signOut();
    router.push("/login");
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <h1>Third Space</h1>
          <p>Risk OS</p>
        </div>

        <div className="sidebar-user">
          <span className="user-name">{user?.name}</span>
          <span className="user-role">{user?.role}</span>
        </div>

        <nav className="sidebar-nav">
          {filteredNav.map((item) => {
            const Icon = item.icon;
            const isActive = pathname === item.href || pathname?.startsWith(item.href + "/");
            
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`sidebar-nav-item ${isActive ? "active" : ""}`}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <button onClick={handleSignOut} className="sidebar-nav-item">
            <LogOut size={18} />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      <main className="main-content">
        {children}
      </main>
    </div>
  );
}
