import { redirect } from "next/navigation";

// D1: the canonical decision surface is /underwriter/[id] (packet-keyed).
export default function ClaimProposalDecisionRedirect({
  params,
}: {
  params: { packetId: string };
}) {
  redirect(`/underwriter/${params.packetId}`);
}
