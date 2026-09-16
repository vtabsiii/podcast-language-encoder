from __future__ import annotations

import logging

from polycast_worker.logsafe import FORBIDDEN_KEYS, RedactingFilter, configure_logging


def _record(msg: str, *args: object) -> logging.LogRecord:
    return logging.LogRecord("t", logging.INFO, __file__, 1, msg, args, None)


def test_filter_drops_forbidden_keys_including_formatted_args():
    f = RedactingFilter()
    assert f.filter(_record("task %s stage %s succeeded in %d ms", "id-1", "MIXING", 12))
    assert not f.filter(_record("transcript text: hello"))
    assert not f.filter(_record("url %s", "https://x/y?X-Amz-Signature=abc"))
    assert not f.filter(_record("claimed with %s", "taskToken=xyz"))
    assert not f.filter(_record("AdaptedText=Hola"))
    assert not f.filter(_record("hint: make it shorter"))
    assert not f.filter(_record("embedding=[0.1]"))
    assert "transcript" in FORBIDDEN_KEYS and "token" in FORBIDDEN_KEYS


def test_filter_drops_records_that_fail_to_format():
    assert not RedactingFilter().filter(_record("%d items", "not-a-number"))


def test_configure_logging_attaches_the_filter_once(capsys):
    root = logging.getLogger()
    saved = list(root.handlers)
    for h in saved:
        root.removeHandler(h)
    try:
        configure_logging()
        configure_logging()
        assert len(root.handlers) == 1
        filters = [f for f in root.handlers[0].filters if isinstance(f, RedactingFilter)]
        assert len(filters) == 1
        logging.getLogger("polycast_worker.test").info("signedUrl=https://x")
        logging.getLogger("polycast_worker.test").info("task abc stage MIXING ok")
        err = capsys.readouterr().err
        assert "signedUrl" not in err
        assert "task abc stage MIXING ok" in err
    finally:
        for h in list(root.handlers):
            root.removeHandler(h)
        for h in saved:
            root.addHandler(h)
