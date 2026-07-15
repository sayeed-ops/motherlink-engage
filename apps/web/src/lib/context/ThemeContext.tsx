'use client';

// ============================================================
// Theme Context — Dark/Light mode with localStorage persistence
// ============================================================
//
// Copied from ML Studio with ONE change: the fallback theme is a prop rather
// than a hardcoded 'dark'. It still defaults to 'dark', so this file remains a
// drop-in for Studio; Engage passes defaultTheme="light".
//
// Kept as a prop rather than just flipping the literal so the two apps can
// share this file and still disagree about their default.

import React, { createContext, useContext, useEffect, useState } from 'react';

type Theme = 'dark' | 'light';

interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (t: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const STORAGE_KEY = 'motherlink-theme';

export function ThemeProvider({
  children,
  defaultTheme = 'dark',
}: {
  children: React.ReactNode;
  defaultTheme?: Theme;
}) {
  const [theme, setThemeState] = useState<Theme>(defaultTheme);

  useEffect(() => {
    // A stored choice always wins over the default — it is the user's, and
    // silently overriding it on every visit would make the toggle feel broken.
    const stored = (typeof window !== 'undefined' &&
      (localStorage.getItem(STORAGE_KEY) as Theme | null)) || null;
    const initial: Theme = stored === 'light' || stored === 'dark' ? stored : defaultTheme;
    setThemeState(initial);
    document.documentElement.setAttribute('data-theme', initial);
  }, [defaultTheme]);

  const setTheme = (next: Theme) => {
    setThemeState(next);
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {}
  };

  const toggleTheme = () => setTheme(theme === 'dark' ? 'light' : 'dark');

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
