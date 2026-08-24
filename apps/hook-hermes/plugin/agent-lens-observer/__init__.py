"""AgentLens Hermes observer plugin.

This plugin is deliberately passive: lifecycle callbacks only sanitize and atomically
persist local envelopes for the AgentLens Hermes Source. It never calls AgentLens
HTTP/SQLite/Core/Cordis and never returns behavior-changing hook directives.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_MAX_STRING = 32 * 1024
_SENSITIVE_KEY = re.compile(r"password|passwd|secret|token|api[_-]?key|authorization|cookie", re.I)
_PENDING_LOCK = threading.Lock()
_PENDING_CALLS: dict[str, list[str]] = {}
_DEFAULT_ENABLED_SOURCES = ("claude-code",)


def _source_enabled(source_id: str) -> bool:
    raw = os.environ.get("AGENT_LENS_ENABLED_SOURCES", "").strip()
    normalized_source_id = source_id.strip().lower()
    if not raw:
        return normalized_source_id in _DEFAULT_ENABLED_SOURCES
    if raw.lower() == "none":
        return False
    return normalized_source_id in {
        item.strip().lower() for item in raw.split(",") if item.strip()
    }


def _captured_at() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _sanitize(value: Any, depth: int = 0) -> Any:
    if depth > 8:
        return "[max-depth]"
    if isinstance(value, str):
        return value if len(value) <= _MAX_STRING else value[:_MAX_STRING] + "…[truncated]"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, (list, tuple)):
        return [_sanitize(item, depth + 1) for item in list(value)[:200]]
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for raw_key, item in value.items():
            key = str(raw_key)
            result[key] = "[redacted]" if _SENSITIVE_KEY.search(key) else _sanitize(item, depth + 1)
        return result
    return str(value)


def _inbox_dir() -> Path:
    override = os.environ.get("AGENT_LENS_HERMES_INBOX", "").strip()
    if override:
        return Path(override).expanduser()
    return Path.home() / ".agent-lens" / "1.0" / "inbox" / "hermes"


def _call_key(payload: dict[str, Any]) -> str:
    task_id = str(payload.get("task_id") or payload.get("session_id") or "")
    tool_name = str(payload.get("tool_name") or "unknown")
    args = payload.get("args", payload.get("tool_input", {}))
    try:
        encoded = json.dumps(_sanitize(args), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    except Exception:
        encoded = str(args)
    digest = hashlib.sha256(encoded.encode("utf-8", errors="replace")).hexdigest()[:16]
    return f"{task_id}:{tool_name}:{digest}"


def _correlate(event_name: str, payload: dict[str, Any]) -> None:
    if payload.get("tool_call_id") or payload.get("call_id") or payload.get("tool_use_id"):
        return
    if event_name not in {"pre_tool_call", "post_tool_call"}:
        return
    key = _call_key(payload)
    with _PENDING_LOCK:
        if event_name == "pre_tool_call":
            call_id = f"agent-lens-{uuid.uuid4()}"
            _PENDING_CALLS.setdefault(key, []).append(call_id)
            payload["tool_call_id"] = call_id
            return
        pending = _PENDING_CALLS.get(key)
        if pending:
            payload["tool_call_id"] = pending.pop(0)
            if not pending:
                _PENDING_CALLS.pop(key, None)


def _persist(event_name: str, kwargs: dict[str, Any]) -> None:
    try:
        if not _source_enabled("hermes"):
            return
        event = dict(kwargs)
        _correlate(event_name, event)
        event["hook_event_name"] = event_name
        event = _sanitize(event)
        captured_at = _captured_at()
        event_id = str(event.get("hook_invocation_id") or event.get("source_event_id") or uuid.uuid4())
        envelope = {"id": event_id, "capturedAt": captured_at, "event": event}

        inbox = _inbox_dir()
        inbox.mkdir(parents=True, exist_ok=True, mode=0o700)
        timestamp_key = re.sub(r"[^0-9]", "", captured_at)
        file_key = hashlib.sha256(event_id.encode("utf-8", errors="replace")).hexdigest()[:24]
        final_path = inbox / f"{timestamp_key}-{file_key}.json"

        fd, temp_name = tempfile.mkstemp(prefix=f".{file_key}-", suffix=".tmp", dir=str(inbox), text=True)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(envelope, handle, ensure_ascii=False, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, final_path)
        except Exception:
            try:
                os.unlink(temp_name)
            except OSError:
                pass
            raise
    except Exception:
        # Observability is fail-open: never block or mutate the Hermes agent loop.
        return


def _callback(event_name: str):
    def observe(**kwargs: Any) -> None:
        _persist(event_name, kwargs)
        return None

    return observe


def register(ctx: Any) -> None:
    """Register passive lifecycle observers. Hermes keeps this plugin opt-in."""

    if not _source_enabled("hermes"):
        return
    for event_name in (
        "pre_tool_call",
        "post_tool_call",
        "on_session_start",
        "on_session_end",
        "subagent_stop",
    ):
        ctx.register_hook(event_name, _callback(event_name))
