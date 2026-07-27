import {Laptop, ShieldCheck, Sparkles, X} from 'lucide-react';
import {useEffect, useState} from 'react';

export function WelcomeNotice() {
  const [isOpen, setIsOpen] = useState(true);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, []);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-slate-950/75 p-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setIsOpen(false);
      }}
    >
      <section
        aria-describedby="welcome-description"
        aria-labelledby="welcome-title"
        aria-modal="true"
        className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-white/10 bg-slate-950 text-slate-100 shadow-2xl shadow-black/50"
        role="dialog"
      >
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-cyan-400 via-blue-500 to-violet-500" />
        <button
          aria-label="Close welcome message"
          className="absolute right-4 top-4 rounded-md p-1.5 text-slate-400 transition hover:bg-white/10 hover:text-white"
          onClick={() => setIsOpen(false)}
          type="button"
        >
          <X className="size-5" />
        </button>

        <div className="p-7 sm:p-8">
          <div className="mb-5 flex size-12 items-center justify-center rounded-xl border border-blue-400/20 bg-blue-500/10 text-blue-300">
            <Sparkles className="size-6" />
          </div>

          <p className="mb-2 text-sm font-semibold tracking-wide text-blue-300">
            Welcome to dbVisuals
          </p>
          <h1 id="welcome-title" className="pr-8 text-2xl font-semibold tracking-tight">
            Explore your data, right in your browser
          </h1>
          <p id="welcome-description" className="mt-3 leading-6 text-slate-300">
            dbVisuals is an interactive workspace for exploring local data and
            building visualizations with DuckDB and WebAssembly.
          </p>

          <div className="mt-6 space-y-4 rounded-xl border border-white/10 bg-white/[0.035] p-4">
            <div className="flex gap-3">
              <Laptop className="mt-0.5 size-5 shrink-0 text-cyan-300" />
              <div>
                <h2 className="font-medium text-slate-100">Local by default</h2>
                <p className="mt-1 text-sm leading-5 text-slate-400">
                  Your data is processed in this browser. dbVisuals does not
                  upload it to a dbVisuals server. API keys are stored locally
                  in this browser for future visits and are sent only to the
                  model provider you choose when you use AI features.
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <ShieldCheck className="mt-0.5 size-5 shrink-0 text-violet-300" />
              <div>
                <h2 className="font-medium text-slate-100">You stay in control</h2>
                <p className="mt-1 text-sm leading-5 text-slate-400">
                  Optional AI features contact your selected model provider only
                  when you use them, subject to that provider&apos;s policies.
                </p>
              </div>
            </div>
          </div>

          <button
            autoFocus
            className="mt-6 w-full rounded-lg bg-blue-500 px-4 py-2.5 font-medium text-white shadow-lg shadow-blue-950/30 transition hover:bg-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-300 focus:ring-offset-2 focus:ring-offset-slate-950"
            onClick={() => setIsOpen(false)}
            type="button"
          >
            Start exploring
          </button>
          <p className="mt-3 text-center text-xs text-slate-500">
            This message appears each time you open the app.
          </p>
        </div>
      </section>
    </div>
  );
}
