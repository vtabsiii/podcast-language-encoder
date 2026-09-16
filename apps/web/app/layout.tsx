import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import '@polycast/ui/tokens.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'Polycast Studio',
  description: 'Localize a podcast once: voices, timing, captions, and visible speech aligned.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a href="#main" className="skip-link">
          Skip to main content
        </a>
        <header className="topbar">
          <span className="brand">Polycast Studio</span>
          <nav aria-label="Primary">
            <Link href="/">Projects</Link>
            <Link href="/languages">Languages</Link>
          </nav>
        </header>
        <main id="main" className="page">
          {children}
        </main>
      </body>
    </html>
  );
}
