'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { AuthAlert, AuthShell } from '@/features/auth/components/auth-shell';
import { PasswordInput } from '@/features/auth/components/password-input';
import { api } from '@/lib/api/client';
import { signOut } from '@/lib/auth/client';
import { AppError } from '@/lib/errors';
import { type VerificationInput, verificationSchema } from '@/lib/validation/auth';

/**
 * The additional verification screen.
 *
 * A wrong phrase does not advance: the field is cleared, the message stays, and
 * the screen is asked again. The phrase is only ever checked on the server —
 * this component has no idea what the right answer is.
 */
export function VerificationForm({
  email,
  redirectTo = '/',
}: {
  email: string;
  redirectTo?: string;
}): React.JSX.Element {
  const router = useRouter();
  const [formError, setFormError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setFocus,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<VerificationInput>({
    resolver: zodResolver(verificationSchema),
    defaultValues: { passphrase: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);

    try {
      await api.post('/api/verification', { body: { passphrase: values.passphrase } });
    } catch (error) {
      // A rate-limit rejection needs to say so, otherwise the reader keeps
      // retrying a correct phrase and cannot tell why nothing happens.
      setFormError(
        error instanceof AppError && error.code === 'RATE_LIMITED'
          ? `Too many attempts. Try again in ${error.retryAfter ?? 60}s.`
          : 'That passphrase is not correct.',
      );
      reset({ passphrase: '' });
      setFocus('passphrase');
      return;
    }

    router.replace(redirectTo);
    // The gate is checked in a server component, so the tree has to be rebuilt.
    router.refresh();
  });

  return (
    <AuthShell
      title="Additional verification"
      description="One more step before this conversation opens. Enter the passphrase to continue."
      footer={
        <>
          Signed in as {email}.{' '}
          <button
            type="button"
            onClick={() => void signOut().then(() => router.replace('/login'))}
            className="font-medium text-[var(--accent)] underline-offset-4 hover:underline"
          >
            Sign out
          </button>
        </>
      }
    >
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4" noValidate>
        {formError ? <AuthAlert>{formError}</AuthAlert> : null}

        <Field label="Passphrase" error={errors.passphrase?.message}>
          {({ id, describedBy, invalid }) => (
            <PasswordInput
              id={id}
              placeholder="Enter passphrase"
              // Not `current-password`: this is a shared phrase, and offering to
              // save it over the account password would be actively unhelpful.
              autoComplete="off"
              autoFocus
              invalid={invalid}
              aria-describedby={describedBy}
              {...register('passphrase')}
            />
          )}
        </Field>

        <Button type="submit" block size="lg" loading={isSubmitting}>
          Continue
        </Button>
      </form>
    </AuthShell>
  );
}
