"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";

/**
 * The Live Terminal was retired — it duplicated the home "On the floor" section
 * and added no distinct value. The venue's Risk Profile is now the canonical
 * venue-detail surface. Any lingering /terminal/<id> link (bookmark, old deep
 * link) redirects there.
 */
export default function TerminalRetired() {
  const { venueId } = useParams() as { venueId: string };
  const router = useRouter();
  useEffect(() => {
    router.replace(`/risk-profile/${venueId}`);
  }, [venueId, router]);
  return <div className="page-loading"><div className="loading-spinner" /></div>;
}
