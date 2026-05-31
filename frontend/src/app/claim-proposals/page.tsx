import { redirect } from "next/navigation";

// D1: the broker inbox is now the Work Queue. This route redirects there.
export default function ClaimProposalsIndexRedirect() {
  redirect("/work-queue");
}
