"use client";

import { ComponentType } from "react";
import Link from "next/link";
import { clsx } from "clsx";

interface SidebarNavItemProps {
  href: string;
  label: string;
  icon: ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
  active?: boolean;
  badge?: number;
  variant?: "full" | "rail";
  onClick?: () => void;
}

export function SidebarNavItem({
  href,
  label,
  icon: Icon,
  active,
  badge,
  variant = "full",
  onClick,
}: SidebarNavItemProps) {
  // Stable E2E seam keyed on the route (e.g. /work-queue → "nav-work-queue",
  // / → "nav-home"). Specs locate nav by identity, not by CSS class or label
  // copy, so design migrations can't silently break navigation.
  const navKey = href.split("?")[0].replace(/^\//, "").replace(/\//g, "-") || "home";
  return (
    <Link
      href={href}
      onClick={onClick}
      className={clsx("sidebar-nav-item", active && "sidebar-nav-item--active", `sidebar-nav-item--${variant}`)}
      aria-current={active ? "page" : undefined}
      title={variant === "rail" ? label : undefined}
      data-testid={`nav-${navKey}`}
    >
      <Icon size={16} aria-hidden />
      {variant === "full" ? <span className="sidebar-nav-item__label">{label}</span> : null}
      {badge && badge > 0 && variant === "full" ? (
        <span className="sidebar-nav-item__badge">{badge}</span>
      ) : null}
    </Link>
  );
}
