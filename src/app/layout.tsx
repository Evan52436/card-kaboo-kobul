import type { Metadata, Viewport } from 'next';
import '@/styles/tokens.css';
import '@/styles/game.css';

export const metadata: Metadata = {
  title: 'Kaboo',
  description: 'A card game for friends, in a browser, by room code.',
};

/**
 * `viewportFit: 'cover'` is what makes `env(safe-area-inset-*)` resolve to real
 * values on a notched phone; without it the insets are always 0 and the bottom
 * action bar slides under the home indicator. See AGENTS.md §9.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // A game surface must never be zoomable by double-tap: a mistap costs a card.
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: '#ffffff',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
