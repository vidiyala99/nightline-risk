"""Render a Certificate of Insurance as a real PDF.

Replaces the Phase-2 JSON-envelope stub on GET /certificates/{id}/pdf.
Reuses the same reportlab layout approach as app.defense_package — a flow of
Paragraphs/Spacers built into a SimpleDocTemplate — so the two exporters stay
visually consistent. ACORD-25-flavored content (holder, additional-insured
scope, description of operations, the underlying policy + coverage lines),
not a pixel-perfect ACORD form.
"""
from __future__ import annotations

from io import BytesIO
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.models import CertificateOfInsurance, Policy


def render_coi_pdf(coi: "CertificateOfInsurance", policy: "Policy | None") -> bytes:
    """Lay a COI out as a PDF and return the bytes."""
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

    styles = getSampleStyleSheet()
    h1, h2, body, mono = styles["Title"], styles["Heading2"], styles["BodyText"], styles["Code"]
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=letter, title="Certificate of Insurance")
    flow: list = []

    def line(text: str, style=body):
        flow.append(Paragraph(text, style))

    line("Certificate of Insurance", h1)
    line("This certificate is issued as a matter of information only and confers no rights upon the holder.")
    line(f"<b>Certificate ID:</b> {coi.id} &nbsp; <b>Status:</b> {coi.status}")
    line(f"<b>Issued:</b> {coi.issued_at.date().isoformat()} &nbsp; <b>Expires:</b> {coi.expires_on.isoformat()}")
    flow.append(Spacer(1, 12))

    line("Certificate Holder", h2)
    line(f"<b>{coi.certificate_holder}</b>")
    line(coi.certificate_holder_address or "")
    ai = "Yes" if coi.additional_insured else "No"
    line(f"<b>Additional insured:</b> {ai}"
         + (f" &nbsp; <b>Scope:</b> {coi.additional_insured_scope}" if coi.additional_insured_scope else ""))
    flow.append(Spacer(1, 12))

    line("Description of Operations", h2)
    line(coi.description_of_operations or "—")
    flow.append(Spacer(1, 12))

    line("Insured Policy", h2)
    if policy is not None:
        line(f"<b>Policy number:</b> {policy.policy_number or '(pending)'}")
        line(f"<b>Venue:</b> {policy.venue_id} &nbsp; <b>Carrier:</b> {policy.carrier_id}")
        line(f"<b>Effective:</b> {policy.effective_date.isoformat()} &nbsp; "
             f"<b>Expiration:</b> {policy.expiration_date.isoformat()}")
        lines = ", ".join(policy.coverage_lines) if policy.coverage_lines else "—"
        line(f"<b>Coverage lines:</b> {lines}")
        line(f"<b>Policy snapshot (SHA-256):</b>")
        line(policy.snapshot_hash or "—", mono)
    else:
        line("Underlying policy not found.")

    doc.build(flow)
    return buf.getvalue()
