export function AgentSection() {
  return (
    <section className="bg-slate-950 text-white py-20 lg:py-24">
      <div className="max-w-3xl mx-auto px-6">
        {/* Heading */}
        <div className="text-center mb-12">
          <h2 className="text-3xl lg:text-4xl font-bold tracking-tight">
            Claude knows your product strategy
          </h2>
          <p className="mt-4 text-lg text-slate-400 leading-relaxed">
            Connect the Compass MCP to Claude and your AI can read
            opportunities, create experiments from interview transcripts, and
            keep your OST current — without copy-paste.
          </p>
        </div>

        {/* Terminal / chat mock */}
        <div
          aria-hidden="true"
          className="bg-slate-900 rounded-xl overflow-hidden border border-white/10 shadow-2xl"
        >
          {/* Top bar */}
          <div className="flex items-center gap-3 px-4 py-3 bg-slate-800/80 border-b border-white/10">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span className="text-sm text-slate-300 font-medium">
              Claude · compass MCP connected
            </span>
          </div>

          {/* Conversation */}
          <div className="p-5 space-y-5">
            {/* User bubble */}
            <div className="flex justify-end">
              <div className="bg-slate-700 rounded-xl rounded-tr-sm px-4 py-3 max-w-sm">
                <p className="text-sm text-slate-200">
                  What opportunities should we prioritize this sprint based on
                  our Q3 OKRs?
                </p>
              </div>
            </div>

            {/* Claude bubble */}
            <div className="flex justify-start">
              <div className="bg-slate-800 rounded-xl rounded-tl-sm px-4 py-3 max-w-lg space-y-3">
                <p className="text-sm text-slate-300">
                  Based on your Q3 OKR cycle, here are the highest-leverage
                  opportunities:
                </p>

                {/* Tool call highlight */}
                <div className="bg-indigo-950/60 border border-indigo-500/30 rounded-lg px-3 py-2 font-mono text-xs">
                  <span className="text-indigo-400">→ compass:</span>
                  <span className="text-yellow-300">list_opportunities</span>
                  <span className="text-slate-400"> [workspaceId: </span>
                  <span className="text-slate-300">rbcodelabs/compass</span>
                  <span className="text-slate-400">]</span>
                </div>

                {/* Results */}
                <div className="space-y-2 text-sm text-slate-300">
                  <p>
                    <span className="text-slate-500 font-mono">1.</span>{" "}
                    Synthesis not connected to next decision{" "}
                    <span className="text-[11px] bg-indigo-900/50 text-indigo-300 px-1.5 py-0.5 rounded font-medium">
                      VALIDATED · KR: Time-to-first-OST &lt; 8min
                    </span>
                  </p>
                  <p>
                    <span className="text-slate-500 font-mono">2.</span>{" "}
                    No way to get customer insights without copy-paste{" "}
                    <span className="text-[11px] bg-indigo-900/50 text-indigo-300 px-1.5 py-0.5 rounded font-medium">
                      VALIDATED · KR: 25 agents/week
                    </span>
                  </p>
                  <p>
                    <span className="text-slate-500 font-mono">3.</span>{" "}
                    First-time users don&apos;t understand OST hierarchy{" "}
                    <span className="text-[11px] bg-slate-700 text-slate-400 px-1.5 py-0.5 rounded font-medium">
                      EXPLORING · KR: 70% 30-day retention
                    </span>
                  </p>
                </div>

                <p className="text-sm text-slate-400">
                  Opportunity #1 is directly blocking 2 KRs. Want me to draft
                  an experiment brief for it?
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
