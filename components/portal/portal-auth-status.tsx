"use client";

import { useState } from "react";

interface Props {
  email: string;
}

/** Small header-right "Signed in as x@y.com · Sign out" affordance. */
export function PortalAuthStatus({ email }: Props) {
  const [isSigningOut, setIsSigningOut] = useState(false);

  async function handleSignOut() {
    setIsSigningOut(true);
    try {
      await fetch("/api/portal/auth/signout", { method: "POST" });
    } finally {
      window.location.reload();
    }
  }

  return (
    <div className="flex items-center gap-2 text-xs text-slate-500">
      <span>
        Signed in as <span className="font-medium text-slate-700">{email}</span>
      </span>
      <button
        type="button"
        onClick={handleSignOut}
        disabled={isSigningOut}
        className="text-indigo-600 hover:underline disabled:opacity-50"
      >
        {isSigningOut ? "Signing out..." : "Sign out"}
      </button>
    </div>
  );
}
