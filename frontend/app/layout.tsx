import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: 'RideNow | Your city, in motion', description: 'A simulated Hyderabad mobility experience.' };

/** Wrap the application in its document shell. */
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
