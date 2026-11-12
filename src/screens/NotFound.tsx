import { Link } from '@tanstack/react-router';
import { Button } from '../ui/Button.tsx';

export function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-[480px] flex-col justify-center gap-5 px-5">
      <h1 className="display m-0 text-[44px]">nothing here.</h1>
      <p className="m-0 text-ink-2 text-sm">That page doesn’t exist.</p>
      <Button asChild>
        <Link to="/">Back to start →</Link>
      </Button>
    </main>
  );
}
