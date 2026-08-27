'use client';

import { Eye, EyeOff, Lock } from 'lucide-react';
import * as React from 'react';

import { Input, type InputProps } from '@/components/ui/input';

/**
 * A password field with a reveal toggle.
 *
 * `forwardRef` matters here: `react-hook-form`'s `register()` spreads a ref onto
 * this, and swallowing it would make the field uncontrolled and unvalidated.
 *
 * The toggle is `tabIndex={-1}` so tabbing runs field → submit rather than
 * detouring through a control nobody reaches by keyboard, and it never submits
 * the form it sits inside — hence the explicit `type="button"`.
 */
export const PasswordInput = React.forwardRef<
  HTMLInputElement,
  Omit<InputProps, 'type' | 'leadingIcon' | 'trailingSlot'>
>(function PasswordInput(props, ref) {
  const [visible, setVisible] = React.useState(false);

  return (
    <Input
      ref={ref}
      type={visible ? 'text' : 'password'}
      leadingIcon={<Lock />}
      trailingSlot={
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setVisible((current) => !current)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          className="grid size-8 place-items-center rounded-[var(--radius-xs)] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
        >
          {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      }
      {...props}
    />
  );
});
