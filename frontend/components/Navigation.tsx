'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

/** Apply a saved appearance and provide navigation between real routes. */
export default function Navigation() {
  const pathname = usePathname();
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {const choice = localStorage.getItem('ridenow_theme') || 'system'; document.documentElement.dataset.theme = choice === 'system' ? (media.matches ? 'dark' : 'light') : choice; window.dispatchEvent(new Event('ridenow-resolved-theme'));};
    apply(); window.addEventListener('ridenow-theme', apply); media.addEventListener('change', apply);
    return () => {window.removeEventListener('ridenow-theme', apply); media.removeEventListener('change', apply);};
  }, []);
  return <nav className="bottom-nav" aria-label="Main navigation">{[['/', 'Home'], ['/services', 'Services'], ['/activity', 'Activity'], ['/account', 'Account']].map(([href, label]) => <Link key={href} href={href} aria-current={pathname === href ? 'page' : undefined}>{label}</Link>)}</nav>;
}
