"use client";

import { createContext, useContext, ReactNode } from "react";

export interface ThemeConfig {
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  logoUrl?: string;
  companyName: string;
}

interface ThemeContextType {
  theme: ThemeConfig;
  setTheme: (theme: ThemeConfig) => void;
}

const defaultTheme: ThemeConfig = {
  primaryColor: "#0369A1",
  secondaryColor: "#0EA5E9",
  accentColor: "#D4FF00",
  companyName: "Nightline Risk",
};

const ThemeContext = createContext<ThemeContextType>({
  theme: defaultTheme,
  setTheme: () => {},
});

export function ThemeProvider({
  children,
  theme = defaultTheme,
}: {
  children: ReactNode;
  theme?: ThemeConfig;
}) {
  const setTheme = (newTheme: ThemeConfig) => {
    Object.entries(newTheme).forEach(([key, value]) => {
      document.documentElement.style.setProperty(`--theme-${key}`, value);
    });
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}