import { redirect } from "next/navigation";

// D1: the broker's queue entry point is the Work Queue; the bare /underwriter
// index is no longer a destination. /underwriter/[id] (a specific packet) stays.
export default function UnderwriterIndexRedirect() {
  redirect("/work-queue");
}
