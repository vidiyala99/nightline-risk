# backend/tests/test_comms_connectors.py
from app.ingestion.comms.sources import SlackSource, TicketSource, TextSource
from app.ingestion.comms.types import CommsItem


def test_sources_emit_venue_scoped_items_deterministically():
    for Source, name in [(SlackSource, "slack"), (TicketSource, "tickets"), (TextSource, "sms")]:
        items = Source(["v1"]).list_items()
        assert items and all(isinstance(i, CommsItem) for i in items)
        assert all(i.venue_id == "v1" and i.source == name for i in items)
        # stable external_id within a window → re-listing is identical
        again = Source(["v1"]).list_items()
        assert [i.external_id for i in items] == [i.external_id for i in again]
