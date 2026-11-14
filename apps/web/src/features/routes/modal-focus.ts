'use client';

import { useEffect, useRef, type KeyboardEvent } from 'react';

const focusable = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function useModalFocus(onEscape: () => void) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const previousRef = useRef<HTMLElement | null>(null);
  const escapeRef = useRef(onEscape); escapeRef.current = onEscape;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    previousRef.current=previous;
    const first = dialogRef.current?.querySelector<HTMLElement>('[autofocus]')
      ?? dialogRef.current?.querySelector<HTMLElement>(focusable);
    first?.focus();
    return () => previous?.focus();
  }, []);
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') { event.preventDefault(); const previous=previousRef.current;escapeRef.current();setTimeout(()=>previous?.focus(),0);return; }
    if (event.key !== 'Tab') return;
    const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>(focusable) ?? [])];
    if (items.length === 0) return;
    const first = items[0]!; const last = items.at(-1)!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  return { dialogRef, onKeyDown };
}
