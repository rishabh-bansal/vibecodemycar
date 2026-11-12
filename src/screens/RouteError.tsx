import { Link } from '@tanstack/react-router';
import { Button } from '../ui/Button.tsx';

/** Shown instead of the router's developer error page. Nothing is sent to a car from here. */
export function RouteError() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-[480px] flex-col justify-center gap-5 px-5">
      <h1 className="display m-0 text-[44px]">something broke.</h1>
      <p className="m-0 text-ink-2 text-sm">This page couldn't load. Nothing was sent to your car.</p>
      <Button asChild>
        <Link to="/">Back to start →</Link>
      </Button>
    </main>
  );
}
