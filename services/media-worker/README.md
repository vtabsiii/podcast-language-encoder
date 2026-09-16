# media-worker

Python worker for the media plane. See `../../docs/architecture.md`.

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
ruff check . && mypy polycast_worker && pytest
```

`ffprobe` is required for real probing; `parse_probe_output` is tested without it.
All ML/cloud capabilities are behind `polycast_worker.providers` Protocols. The only
adapters in this milestone are `providers/mock.py`, which register as tier `unavailable`.
