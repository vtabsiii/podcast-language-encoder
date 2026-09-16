from polycast_worker.mediatime import from_rational, from_seconds_str


def test_rational_exact():
    assert from_rational(90000, 1, 90000) == 1_000_000
    assert from_rational(1001, 1, 30000) == 33367
    assert from_rational(48000, 1, 48000) == 1_000_000


def test_seconds_string_exact():
    assert from_seconds_str("3723.456") == 3_723_456_000
    assert from_seconds_str("0.0000005") == 1  # rounds half up
    assert from_seconds_str("0.0000004") == 0
