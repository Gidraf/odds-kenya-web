import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'OddsTerminal — Arbitrage Intelligence',
  description: 'Real-time odds comparison and arbitrage discovery',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}