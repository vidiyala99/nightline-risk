"""
RTSP Sampler — continuous frame sampling from venue security cameras.

Runs one background thread per CameraFeed. Each thread:
  1. Opens the RTSP stream with OpenCV.
  2. Samples one frame every camera.sample_interval_seconds seconds.
  3. Encodes the frame as JPEG and sends it to Gemini 2.5 Flash for analysis.
  4. Applies a three-gate filter (confidence + temporal persistence + severity).
  5. Persists qualifying AlertEvent rows and dispatches push notifications.

Requires: opencv-python, httpx (already in requirements).
If opencv is missing the sampler logs a warning and silently skips start().
"""

from __future__ import annotations

import base64
import json
import logging
import os
import threading
import time
import uuid
from app.time import now_utc
from typing import Optional

logger = logging.getLogger(__name__)

# ── Gemini constants ──────────────────────────────────────────────────────────

_GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    "gemini-2.5-flash:generateContent"
)

_GEMINI_SCHEMA = {
    "type": "object",
    "properties": {
        "event_type": {
            "type": "string",
            "enum": ["altercation", "crowd_crush", "person_down", "weapon", "normal", "other"],
        },
        "severity": {
            "type": "string",
            "enum": ["critical", "high", "medium", "low", "none"],
        },
        "confidence": {"type": "number"},
        "description": {"type": "string"},
    },
    "required": ["event_type", "severity", "confidence", "description"],
}

_GEMINI_PROMPT = (
    "Analyze this venue security camera frame. "
    "Identify any potential liability events."
)

# ── Filter thresholds ─────────────────────────────────────────────────────────

_CONFIDENCE_GATE = 0.75
_PERSISTENCE_GATE = 3          # consecutive frames required
_COOLDOWN_SECONDS = 1200       # 20 minutes between push alerts per (venue, zone)


class RTSPSampler:
    """Manages one background thread per active CameraFeed."""

    def __init__(self) -> None:
        # camera_id -> stop_event
        self._threads: dict[str, threading.Event] = {}

        # (venue_id, zone, event_type) -> consecutive frame count
        self._frame_counters: dict[tuple[str, str, str], int] = {}

        # (venue_id, zone) -> expiry timestamp (float, epoch seconds)
        self._cooldowns: dict[tuple[str, str], float] = {}

    # ── Public API ────────────────────────────────────────────────────────────

    def start(self, camera) -> None:  # camera: CameraFeed
        """Start a background sampling thread for the given CameraFeed.

        Silently returns if opencv-python is not installed.
        """
        try:
            import cv2  # noqa: F401
        except ImportError:
            logger.warning(
                "opencv-python not installed — RTSP sampling disabled for camera %s",
                camera.id,
            )
            return

        if camera.id in self._threads:
            logger.debug("Camera %s already running; skipping start.", camera.id)
            return

        stop_event = threading.Event()
        self._threads[camera.id] = stop_event

        t = threading.Thread(
            target=self._run_loop,
            args=(camera, stop_event),
            name=f"rtsp-{camera.id}",
            daemon=True,
        )
        t.start()
        logger.info("Started RTSP sampler thread for camera %s (%s)", camera.id, camera.zone)

    def stop(self, camera_id: str) -> None:
        """Signal the sampling thread for camera_id to stop."""
        event = self._threads.pop(camera_id, None)
        if event is not None:
            event.set()
            logger.info("Stopped RTSP sampler for camera %s", camera_id)

    def stop_all(self) -> None:
        """Signal all running sampling threads to stop."""
        for camera_id, event in list(self._threads.items()):
            event.set()
        self._threads.clear()
        logger.info("Stopped all RTSP sampler threads.")

    # ── Thread loop ───────────────────────────────────────────────────────────

    def _run_loop(self, camera, stop_event: threading.Event) -> None:
        import cv2

        cap = cv2.VideoCapture(camera.rtsp_url)
        if not cap.isOpened():
            logger.error(
                "Failed to open RTSP stream for camera %s: %s",
                camera.id,
                camera.rtsp_url,
            )
            return

        logger.info("RTSP stream opened for camera %s", camera.id)
        try:
            while not stop_event.is_set():
                ret, frame = cap.read()
                if not ret:
                    logger.warning(
                        "Frame read failed for camera %s — stream may have dropped.",
                        camera.id,
                    )
                    # Brief back-off before retry
                    time.sleep(2)
                    continue

                # Encode frame to JPEG bytes
                ok, buf = cv2.imencode(".jpg", frame)
                if not ok:
                    logger.warning("JPEG encoding failed for camera %s", camera.id)
                else:
                    frame_bytes: bytes = buf.tobytes()
                    self._process_frame(camera, frame_bytes)

                # Wait the configured interval (or until stop signal)
                stop_event.wait(timeout=camera.sample_interval_seconds)
        finally:
            cap.release()
            logger.info("RTSP stream released for camera %s", camera.id)

    def _process_frame(self, camera, frame_bytes: bytes) -> None:
        result = self._analyze_frame(camera.id, camera.venue_id, camera.zone, frame_bytes)

        if result is None:
            # Non-event frame — reset temporal counter for this camera's last seen type
            # (counters for unknown type keys decay naturally; nothing to reset without
            # knowing which event_type was previously accumulating)
            return

        event_type: str = result["event_type"]
        severity: str = result["severity"]
        confidence: float = result["confidence"]
        description: str = result["description"]

        # ── Gate 1: confidence ────────────────────────────────────────────────
        if confidence < _CONFIDENCE_GATE:
            logger.debug(
                "Camera %s: confidence %.2f below gate (%.2f) — skipped.",
                camera.id,
                confidence,
                _CONFIDENCE_GATE,
            )
            self._reset_counter(camera.venue_id, camera.zone, event_type)
            return

        # ── Gate 2: temporal persistence ──────────────────────────────────────
        key = (camera.venue_id, camera.zone, event_type)
        count = self._frame_counters.get(key, 0) + 1
        self._frame_counters[key] = count

        # Reset counters for other event types in this (venue, zone)
        for existing_key in list(self._frame_counters.keys()):
            v, z, et = existing_key
            if v == camera.venue_id and z == camera.zone and et != event_type:
                self._frame_counters[existing_key] = 0

        if count < _PERSISTENCE_GATE:
            logger.debug(
                "Camera %s: event_type=%s count=%d/%d — waiting for persistence.",
                camera.id,
                event_type,
                count,
                _PERSISTENCE_GATE,
            )
            return

        # ── Gate 3: severity (only critical / high pass) ──────────────────────
        if severity not in ("critical", "high"):
            logger.debug(
                "Camera %s: severity=%s below gate — skipped.", camera.id, severity
            )
            # Reset counter so the same low-severity run doesn't stack
            self._frame_counters[key] = 0
            return

        # ── Cooldown check (governs alerted flag, not DB write) ───────────────
        cooldown_key = (camera.venue_id, camera.zone)
        now = time.time()
        cooldown_expiry = self._cooldowns.get(cooldown_key, 0.0)
        in_cooldown = now < cooldown_expiry

        alerted = (severity == "critical") and not in_cooldown

        if alerted:
            self._cooldowns[cooldown_key] = now + _COOLDOWN_SECONDS

        # ── Persist AlertEvent ────────────────────────────────────────────────
        self._persist_alert(
            camera_id=camera.id,
            venue_id=camera.venue_id,
            zone=camera.zone,
            event_type=event_type,
            severity=severity,
            confidence=confidence,
            description=description,
            frame_count=count,
            alerted=alerted,
        )

        # Reset persistence counter after alert fires
        self._frame_counters[key] = 0

    # ── Gemini analysis ───────────────────────────────────────────────────────

    def _analyze_frame(
        self,
        camera_id: str,
        venue_id: str,
        zone: str,
        frame_bytes: bytes,
    ) -> Optional[dict]:
        """Send a JPEG frame to Gemini 2.5 Flash and parse the structured response.

        Returns None if:
        - GEMINI_API_KEY is not set
        - The API call fails
        - event_type == "normal" or severity == "none"
        """
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            logger.warning("GEMINI_API_KEY not configured — skipping frame analysis.")
            return None

        import httpx

        b64 = base64.b64encode(frame_bytes).decode("ascii")
        payload = {
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {"inline_data": {"mime_type": "image/jpeg", "data": b64}},
                        {"text": _GEMINI_PROMPT},
                    ],
                }
            ],
            "generationConfig": {
                "maxOutputTokens": 512,
                "temperature": 0.2,
                "responseMimeType": "application/json",
                "responseSchema": _GEMINI_SCHEMA,
            },
        }

        try:
            with httpx.Client(timeout=30.0) as client:
                response = client.post(
                    _GEMINI_URL,
                    json=payload,
                    headers={"x-goog-api-key": api_key},
                )
                response.raise_for_status()
                data = response.json()

            text = data["candidates"][0]["content"]["parts"][0]["text"]
            result: dict = json.loads(text)
        except Exception as exc:
            logger.error(
                "Gemini frame analysis failed for camera %s: %s",
                camera_id,
                exc,
            )
            return None

        if result.get("event_type") == "normal" or result.get("severity") == "none":
            return None

        return result

    # ── DB persistence ────────────────────────────────────────────────────────

    def _persist_alert(
        self,
        camera_id: str,
        venue_id: str,
        zone: str,
        event_type: str,
        severity: str,
        confidence: float,
        description: str,
        frame_count: int,
        alerted: bool,
    ) -> None:
        from sqlmodel import Session

        from app.database import engine
        from app.models import AlertEvent

        alert = AlertEvent(
            id=str(uuid.uuid4()),
            venue_id=venue_id,
            camera_id=camera_id,
            zone=zone,
            event_type=event_type,
            severity=severity,
            confidence=confidence,
            frame_count=frame_count,
            alerted=alerted,
            description=description,
            detected_at=now_utc(),
        )

        try:
            with Session(engine) as session:
                session.add(alert)
                session.commit()
                session.refresh(alert)
            logger.info(
                "AlertEvent persisted: id=%s venue=%s zone=%s event=%s severity=%s alerted=%s",
                alert.id,
                venue_id,
                zone,
                event_type,
                severity,
                alerted,
            )
        except Exception as exc:
            logger.error("Failed to persist AlertEvent: %s", exc)
            return

        _dispatch_alert(alert)

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _reset_counter(self, venue_id: str, zone: str, event_type: str) -> None:
        key = (venue_id, zone, event_type)
        if key in self._frame_counters:
            self._frame_counters[key] = 0


# ── Alert dispatch ────────────────────────────────────────────────────────────

def _dispatch_alert(alert_event) -> None:  # alert_event: AlertEvent
    try:
        from app.database import engine
        from app.services.alert_dispatcher import dispatch_alert
        from sqlmodel import Session
        with Session(engine) as session:
            dispatch_alert(alert_event, session)
    except Exception as exc:
        logger.error("Alert dispatch failed for %s: %s", alert_event.id, exc)


# ── Module-level singleton ────────────────────────────────────────────────────

sampler = RTSPSampler()
