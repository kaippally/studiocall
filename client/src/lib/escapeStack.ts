/**
 * escapeStack.ts — Esc dismisses, Enter accepts, the top-most surface.
 *
 * A dialog, a builder form or an inline edit registers its cancel (and, if it has one, its
 * primary action) while it is open; the key runs the most recently registered one, so the
 * innermost surface always wins and a dialog opened over another answers only for itself.
 *
 * Why a stack and not a keydown listener per dialog: one listener, registered here, fans the key
 * out to whichever surface is on top — a listener per dialog would answer for every open one.
 */
import { useEffect, useRef } from 'react';

type DialogHandler = () => void;

const stack: DialogHandler[] = [];
const confirmStack: DialogHandler[] = [];

function push(list: DialogHandler[], fn: DialogHandler): () => void {
  list.push(fn);
  return () => {
    const i = list.lastIndexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
}

/** Register a cancel for as long as its surface is open. Returns the unregister. */
export function pushEscapeHandler(fn: DialogHandler): () => void {
  return push(stack, fn);
}

/** Register a primary action (Enter) for as long as its surface is open. */
export function pushConfirmHandler(fn: DialogHandler): () => void {
  return push(confirmStack, fn);
}

/** Dismiss the top-most surface. False when nothing is open. */
export function runTopEscapeHandler(): boolean {
  const fn = stack[stack.length - 1];
  if (!fn) return false;
  fn();
  return true;
}

/**
 * Is any dismissable surface open? A passive notice asks this before it takes Esc: a dialog
 * always outranks a toast, so the toast only answers the key when nothing is stacked.
 */
export function hasOpenSurface(): boolean {
  return stack.length > 0;
}

/** Accept the top-most surface. False when nothing is open. */
export function runTopConfirmHandler(): boolean {
  const fn = confirmStack[confirmStack.length - 1];
  if (!fn) return false;
  fn();
  return true;
}

/**
 * Esc cancels `onEscape` while `open`. Pass `true` for a dialog that is only mounted while open.
 * Fires even while a text field inside the surface has focus.
 */
export function useEscapeKey(open: boolean, onEscape: () => void): void {
  const ref = useRef(onEscape);
  ref.current = onEscape;
  useEffect(() => {
    if (!open) return;
    return pushEscapeHandler(() => ref.current());
  }, [open]);
}

/**
 * Enter runs `onConfirm` while `open` — the dialog's OK / Save / Delete button.
 * Enter inside a TEXTAREA or contenteditable is left alone: there it is a newline, not an accept.
 */
export function useConfirmKey(open: boolean, onConfirm: () => void): void {
  const ref = useRef(onConfirm);
  ref.current = onConfirm;
  useEffect(() => {
    if (!open) return;
    return pushConfirmHandler(() => ref.current());
  }, [open]);
}

/** The pair every confirmation dialog wants: Enter = OK, Esc = Cancel. */
export function useDialogKeys(open: boolean, onConfirm: (() => void) | null, onCancel: () => void): void {
  useConfirmKey(open && !!onConfirm, onConfirm ?? (() => {}));
  useEscapeKey(open, onCancel);
}

// Enter is a multi-line editor's newline before it is anyone's OK.
function typingMultiline(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === 'TEXTAREA' || el.isContentEditable);
}

window.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.isComposing) return;
  if (e.key === 'Escape') {
    if (runTopEscapeHandler()) { e.preventDefault(); e.stopPropagation(); }
  } else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
    if (typingMultiline()) return;
    if (runTopConfirmHandler()) { e.preventDefault(); e.stopPropagation(); }
  }
}, true);
