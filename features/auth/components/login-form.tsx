'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { Mail } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { AuthAlert, AuthShell } from '@/features/auth/components/auth-shell';
import { GoogleButton } from '@/features/auth/components/google-button';
import { PasswordInput } from '@/features/auth/components/password-input';
import { signIn } from '@/lib/auth/client';
import { type LoginInput, loginSchema } from '@/lib/validation/auth';

export function LoginForm({
  googleEnabled,
  redirectTo = '/',
}: {
  googleEnabled: boolean;
  redirectTo?: string;
}): React.JSX.Element {
  const router = useRouter();
  const [formError, setFormError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '', rememberMe: true },
  });

  const rememberMe = watch('rememberMe');

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);

    const { error } = await signIn.email({
      email: values.email,
      password: values.password,
      rememberMe: values.rememberMe,
      callbackURL: redirectTo,
    });

    if (error) {
      // Better Auth returns a distinct code for the allowlist rejection; every
      // other failure is deliberately collapsed into one message so the form
      // cannot be used to discover which of the two addresses is registered.
      setFormError(
        error.code === 'NOT_AUTHORIZED_ACCOUNT'
          ? 'This application is private. Only pre-authorized accounts may sign in.'
          : 'Incorrect email or password.',
      );
      return;
    }

    router.push(redirectTo);
    router.refresh();
  });

  return (
    <AuthShell
      title="Welcome back"
      description="Sign in to continue your conversation."
      footer={
        <>
          Need an account?{' '}
          <Link
            href="/register"
            className="font-medium text-[var(--accent)] underline-offset-4 hover:underline"
          >
            Register
          </Link>
        </>
      }
    >
      <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4" noValidate>
        {formError ? <AuthAlert>{formError}</AuthAlert> : null}

        <Field label="Email" error={errors.email?.message}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              type="email"
              inputMode="email"
              autoComplete="email"
              autoFocus
              placeholder="you@example.com"
              leadingIcon={<Mail />}
              invalid={invalid}
              aria-describedby={describedBy}
              {...register('email')}
            />
          )}
        </Field>

        <Field label="Password" error={errors.password?.message}>
          {({ id, describedBy, invalid }) => (
            <PasswordInput
              id={id}
              placeholder="Your password"
              autoComplete="current-password"
              invalid={invalid}
              aria-describedby={describedBy}
              {...register('password')}
            />
          )}
        </Field>

        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Checkbox
              id="rememberMe"
              checked={rememberMe}
              onCheckedChange={(checked) => setValue('rememberMe', checked === true)}
            />
            <Label htmlFor="rememberMe" className="cursor-pointer">
              Remember me
            </Label>
          </div>
          <Link
            href="/forgot-password"
            className="text-sm text-[var(--accent)] underline-offset-4 hover:underline"
          >
            Forgot password?
          </Link>
        </div>

        <Button type="submit" block size="lg" loading={isSubmitting}>
          Sign in
        </Button>

        {googleEnabled ? (
          <>
            <div className="my-1 flex items-center gap-3">
              <Separator className="flex-1" />
              <span className="text-xs tracking-wider text-[var(--text-muted)] uppercase">or</span>
              <Separator className="flex-1" />
            </div>
            <GoogleButton callbackURL={redirectTo} onError={setFormError} />
          </>
        ) : null}
      </form>
    </AuthShell>
  );
}
