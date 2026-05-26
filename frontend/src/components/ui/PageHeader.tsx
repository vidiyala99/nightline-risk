"use client";

import { ReactNode } from "react";
import { clsx } from "clsx";

interface PageHeaderProps {
  eyebrow?: string;
  title: string;
  /** Optional handwritten (Caveat) flourish rendered after the title. */
  accent?: string;
  subtitle?: string;
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({ eyebrow, title, accent, subtitle, actions, className }: PageHeaderProps) {
  return (
    <header className={clsx("page-header", className)}>
      <div className="page-header__text">
        {eyebrow ? <div className="page-header__eyebrow">{eyebrow}</div> : null}
        <h1 className="page-header__title">
          {title}
          {accent ? <span className="page-header__accent">{accent}</span> : null}
        </h1>
        {subtitle ? <p className="page-header__subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </header>
  );
}
