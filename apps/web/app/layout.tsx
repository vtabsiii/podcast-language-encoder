import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import '@polycast/ui/tokens.css';
import './globals.css';
import { getSession } from '@/lib/session';

export const metadata: Metadata = {
  title: { default: 'Polycast Studio', template: '%s · Polycast Studio' },
  description: 'Localize a podcast once: voices, timing, captions, and visible speech aligned.',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  const who = session?.who ?? null;
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
          <div className="identity">
            {who ? (
              <>
                <span>
                  <span className="pc-visually-hidden">Signed in as </span>
                  {who.displayName} <span className="muted">({who.email})</span>
                </span>
                <span>
                  <span className="pc-visually-hidden">Organization </span>
                  <strong>{who.organizationName}</strong>{' '}
                  <span className="muted">· {who.role}</span>
                </span>
                <Link href="/login">Switch organization</Link>
                <a href="/logout">Sign out</a>
              </>
            ) : (
              <Link href="/login">Sign in</Link>
            )}
          </div>
        </header>
        <main id="main" className="page">
          {children}
        </main>
      </body>
    </html>
  );
}
