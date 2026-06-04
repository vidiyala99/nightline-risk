"""reportlab renderers for the NY E&S statutory documents. Same lazy-import
pattern as app/defense_package.render_defense_pdf — reportlab is only imported
when a document is actually rendered."""
from __future__ import annotations

from io import BytesIO
from xml.sax.saxutils import escape


def _render(title: str, lines: list[str]) -> bytes:
    # reportlab Paragraph parses a mini-XML; escape so free-text fields
    # (e.g. a declination carrier_name/reason containing '&' or '<') can't
    # break rendering. These lines carry no intentional markup.
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=letter)
    styles = getSampleStyleSheet()
    flow = [Paragraph(escape(title), styles["Title"]), Spacer(1, 12)]
    for ln in lines:
        flow.append(Paragraph(escape(ln), styles["Normal"]))
        flow.append(Spacer(1, 6))
    doc.build(flow)
    return buf.getvalue()


def render_diligent_search_affidavit(filing, declinations, venue) -> bytes:
    vname = getattr(venue, "name", filing.venue_id)
    lines = [
        f"State: {filing.state}",
        f"Insured (venue): {vname}",
        f"Policy: {filing.policy_id}",
        "Pursuant to NY Insurance Law §2118, the producing broker affirms a "
        "diligent effort was made to place this risk with authorized insurers, "
        "which declined as follows:",
    ]
    if declinations:
        for d in declinations:
            lines.append(f"  • {d.carrier_name} — {d.reason} ({d.declined_at})")
    else:
        lines.append("  • (Export-List coverage — declinations not required)"
                     if filing.export_list_exempt else "  • (none recorded)")
    return _render("Excess Line Diligent Search Affidavit", lines)


def render_sl_tax_statement(filing, policy, venue) -> bytes:
    vname = getattr(venue, "name", filing.venue_id)
    lines = [
        f"Insured (venue): {vname}",
        f"Policy: {filing.policy_id}",
        f"Taxable premium (subtotal + policy fee): ${filing.taxable_premium}",
        f"Surplus lines premium tax (3.6%): ${filing.surplus_lines_tax}",
        f"ELANY stamping fee (0.15%): ${filing.stamping_fee}",
        f"Total charges remitted: ${filing.total_charges}",
        f"Filing deadline: {filing.filing_deadline}",
    ]
    return _render("Excess Line Premium Tax Statement", lines)


def render_nonadmitted_disclosure(filing, policy, venue, carrier) -> bytes:
    cname = getattr(carrier, "name", policy.carrier_id)
    vname = getattr(venue, "name", filing.venue_id)
    lines = [
        f"Insured (venue): {vname}",
        f"Insurer: {cname}",
        "NOTICE: This insurance is placed with an insurer not licensed to do "
        "business in New York State and is not subject to its financial "
        "supervision. If the insurer becomes insolvent, claims are NOT covered "
        "by the New York State guaranty fund.",
    ]
    return _render("Notice of Placement with a Non-Admitted Insurer", lines)
