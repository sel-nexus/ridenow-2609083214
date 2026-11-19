// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import Navigation from './Navigation';

vi.mock('next/navigation', () => ({usePathname: () => '/activity'}));

beforeEach(() => {vi.stubGlobal('React', React);});
afterEach(() => {cleanup(); localStorage.clear(); vi.unstubAllGlobals(); delete document.documentElement.dataset.theme;});

it('renders real route links and marks only the current page', () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn()})));
  render(<Navigation />);
  for (const [label, href] of [['Home', '/'], ['Services', '/services'], ['Activity', '/activity'], ['Account', '/account']]) {
    const link = screen.getByRole('link', {name: label});
    expect(link).toHaveAttribute('href', href);
    if (label === 'Activity') expect(link).toHaveAttribute('aria-current', 'page');
    else expect(link).not.toHaveAttribute('aria-current');
  }
});

it('resolves system and saved themes, reacts to changes and removes listeners', () => {
  let change: (() => void) | undefined;
  const media = {matches: true, addEventListener: vi.fn((_event: string, fn: () => void) => {change = fn;}), removeEventListener: vi.fn()};
  vi.stubGlobal('matchMedia', vi.fn(() => media));
  const resolved = vi.fn(); window.addEventListener('ridenow-resolved-theme', resolved);
  const view = render(<Navigation />);
  expect(document.documentElement.dataset.theme).toBe('dark');
  media.matches = false; act(() => change?.());
  expect(document.documentElement.dataset.theme).toBe('light');
  localStorage.setItem('ridenow_theme', 'dark');
  act(() => window.dispatchEvent(new Event('ridenow-theme')));
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(resolved).toHaveBeenCalledTimes(3);
  view.unmount();
  expect(media.removeEventListener).toHaveBeenCalledWith('change', change);
  localStorage.setItem('ridenow_theme', 'light');
  window.dispatchEvent(new Event('ridenow-theme'));
  expect(document.documentElement.dataset.theme).toBe('dark');
  window.removeEventListener('ridenow-resolved-theme', resolved);
});
