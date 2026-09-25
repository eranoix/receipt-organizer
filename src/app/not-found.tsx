import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-lg font-semibold">Nothing here</h1>
      <p className="text-sm text-muted">The page moved, or never existed.</p>
      <Link href="/" className="btn">Back to the overview</Link>
    </div>
  );
}
